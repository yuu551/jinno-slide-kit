// HTTP の互換層（開発とテスト用）。marp/editor/server.mjs と同じ API を同じ形で返す。
// `marp-native --http` で起動したときだけ使う。画面のコードは backend.mjs を通してここを呼ぶ。
use crate::deck::{now_ms, ApiError, BringResult, Deck, SaveOutcome};
use crate::git as G;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

pub struct Config {
    pub root: PathBuf,
    pub deck_path: PathBuf,
    pub port: u16,
    pub hub: Option<String>,
    pub bundle_dir: PathBuf,
}

/// 立ち上がった画面のサーバー（アプリの中でも使う）
pub struct Running {
    pub port: u16,
    pub deck: Arc<Deck>,
    pub ctx: Arc<Context>,
}

/// 画面と API のサーバーを立ち上げる（待ち受けは別スレッド。すぐ返る）
/// 画面の JS は esbuild で1つにまとめて配る（Node 版と同じ）。
/// 材料（client のソース）より古ければ作り直す（古い束でテストを流さないため）
pub fn ensure_bundle(root: &Path, bundle_dir: &Path) -> Result<(), String> {
    if crate::hub::packaged(root) {
        return if ["app.js", "present.js", "hub.js", "export.js", "render-worker.js"]
            .iter()
            .all(|n| bundle_dir.join(n).is_file())
        {
            Ok(())
        } else {
            Err("アプリの画面が見つかりません。再インストールしてください。".into())
        };
    }
    #[cfg(debug_assertions)]
    {
        if !bundle_is_stale_dir(root, bundle_dir) {
            return Ok(());
        }
        std::fs::create_dir_all(bundle_dir).map_err(|e| e.to_string())?;
        let output = crate::hub::node_command()
            .arg(root.join("scripts/bundle-client.mjs"))
            .arg(bundle_dir)
            .current_dir(root)
            .output()
            .map_err(|e| e.to_string())?;
        if output.status.success() {
            return Ok(());
        }
    }
    Err("アプリの画面を用意できませんでした。再インストールしてください。".into())
}

pub fn start(config: Config) -> Result<Running, String> {
    ensure_bundle(&config.root, &config.bundle_dir)?;

    let deck = Arc::new(
        Deck::open(&config.root, &config.deck_path, config.hub.clone()).map_err(|e| e.message)?,
    );
    deck.clone().watch();

    let listener = bind_free(config.port)?;
    let addr = listener.local_addr().map_err(|e| e.to_string())?;
    let port = addr.port();
    let ctx = Arc::new(Context {
        deck: deck.clone(),
        root: config.root.clone(),
        bundle_dir: config.bundle_dir.clone(),
        hub: HubProbe::new(config.hub.clone()),
    });
    let active = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let ctx_thread = Arc::clone(&ctx);
    std::thread::spawn(move || loop {
        match listener.accept() {
            Ok((stream, _)) => {
                // 止めるときは自分に1本つないで accept を起こす。その1本でここを通るので、
                // 受けた stream を捨てて待ち受けを終える（review-P4-2 の must 5）
                if ctx_thread.deck.is_stopped() {
                    drop(stream);
                    return;
                }
                // macOS では accept した socket が非同期のままになることがある。
                // 大きなファイルを途中で切らないよう、必ず同期に戻す
                let _ = stream.set_nonblocking(false);
                if active.fetch_add(1, std::sync::atomic::Ordering::SeqCst) >= 32 {
                    active.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
                    drop(stream);
                    continue;
                }
                let count = active.clone();
                let ctx = Arc::clone(&ctx_thread);
                std::thread::spawn(move || {
                    let _ = handle(ctx, stream);
                    count.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
                });
            }
            Err(_) => {
                // 待ち受けは一度の失敗でやめない（ファイルが足りない・接続が中断された など）。
                // やめるのは「閉じた」と知らされたときだけ（review-P4-2 の must 5）
                if ctx_thread.deck.is_stopped() {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        }
    });
    Ok(Running { port, deck, ctx })
}

/// `--http` で起動したときの入口（URL を出して、そのまま待つ）
pub fn run(config: Config) -> Result<(), String> {
    let deck_path = config.deck_path.clone();
    let running = start(config)?;
    println!(
        "エディター: http://127.0.0.1:{}/  （{}）",
        running.port,
        deck_path.display()
    );
    println!("（Rust のバックエンド。Node のサーバーの代わり）");
    std::io::stdout().flush().ok();
    loop {
        std::thread::sleep(Duration::from_secs(3600));
    }
}

#[cfg(debug_assertions)]
fn bundle_is_stale_dir(root: &Path, bundle_dir: &Path) -> bool {
    let app = bundle_dir.join("app.js");
    let Ok(app_at) = std::fs::metadata(&app).and_then(|m| m.modified()) else {
        return true;
    };
    let mut newest = app_at;
    for base in [
        root.join("marp/editor/client"),
        root.join("marp/hub/client"),
        root.join("marp/shared"),
        root.join("marp/export"),
        root.join("marp/pptx"),
        root.join("marp/lib"),
    ] {
        if let Some(t) = newest_mtime(&base, 0) {
            if t > newest {
                newest = t;
            }
        }
    }
    newest > app_at
}

#[cfg(debug_assertions)]
fn newest_mtime(dir: &Path, depth: usize) -> Option<std::time::SystemTime> {
    if depth > 3 {
        return None;
    }
    let mut newest = None;
    for e in std::fs::read_dir(dir).ok()?.filter_map(|e| e.ok()) {
        let p = e.path();
        if p.is_dir() {
            if let Some(t) = newest_mtime(&p, depth + 1) {
                newest = Some(newest.map_or(t, |cur: std::time::SystemTime| cur.max(t)));
            }
        } else if let Ok(t) = e.metadata().and_then(|m| m.modified()) {
            newest = Some(newest.map_or(t, |cur: std::time::SystemTime| cur.max(t)));
        }
    }
    newest
}

fn bind_free(start: u16) -> Result<TcpListener, String> {
    if start == 0 {
        return TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).map_err(|e| e.to_string());
    }
    for port in start..start + 200 {
        let addr = SocketAddr::from(([127, 0, 0, 1], port));
        if let Ok(l) = TcpListener::bind(addr) {
            return Ok(l);
        }
    }
    Err("空きポートがありません".into())
}

pub struct Context {
    pub deck: Arc<Deck>,
    pub root: PathBuf,
    pub bundle_dir: PathBuf,
    pub hub: HubProbe,
}

/// ハブ（ライブラリー）が動いているかを確かめて覚えておく（30秒だけ覚える）
pub struct HubProbe {
    fixed: Option<String>,
    cached: std::sync::Mutex<Option<(Option<String>, u128)>>,
}

impl HubProbe {
    pub fn new(fixed: Option<String>) -> HubProbe {
        HubProbe {
            fixed,
            cached: std::sync::Mutex::new(None),
        }
    }
    pub fn url(&self) -> Option<String> {
        if let Some(f) = &self.fixed {
            return Some(f.clone());
        }
        if std::env::var_os("MARP_NO_HUB").is_some() {
            return None;
        }
        let mut c = self.cached.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((v, at)) = &*c {
            if now_ms().saturating_sub(*at) < 30_000 {
                return v.clone();
            }
        }
        let found = http_get("127.0.0.1:4860", "/api/info", 400)
            .map(|(_, body)| body)
            .map(|b| b.contains("\"themes\""))
            .unwrap_or(false);
        let v = if found {
            Some("http://127.0.0.1:4860/".to_string())
        } else {
            None
        };
        *c = Some((v.clone(), now_ms()));
        v
    }
}

// --- HTTP の読み書き ------------------------------------------------------------------------

struct Request {
    method: String,
    path: String,
    query: HashMap<String, String>,
    body: Vec<u8>,
}

fn read_request(stream: &mut TcpStream) -> std::io::Result<Option<Request>> {
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(10)))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    if Read::by_ref(&mut reader).take(8193).read_line(&mut line)? == 0 {
        return Ok(None);
    }
    if line.len() > 8192 {
        return Ok(None);
    }
    let mut it = line.trim_end().split(' ');
    let method = it.next().unwrap_or("").to_string();
    let target = it.next().unwrap_or("/").to_string();
    let mut headers: HashMap<String, String> = HashMap::new();
    let mut header_bytes = 0;
    loop {
        let mut h = String::new();
        if Read::by_ref(&mut reader).take(8193).read_line(&mut h)? == 0 {
            break;
        }
        header_bytes += h.len();
        if h.len() > 8192 || header_bytes > 65536 {
            return Ok(None);
        }
        let h = h.trim_end().to_string();
        if h.is_empty() {
            break;
        }
        if let Some(i) = h.find(':') {
            headers.insert(h[..i].to_lowercase(), h[i + 1..].trim().to_string());
        }
    }
    let host = format!("127.0.0.1:{}", stream.local_addr()?.port());
    let origin = format!("http://{host}");
    let content_type = headers
        .get("content-type")
        .map(|v| v.split(';').next().unwrap_or("").trim())
        .unwrap_or("");
    let upload = target.split('?').next() == Some("/api/upload");
    if headers.get("host") != Some(&host)
        || headers.get("origin").is_some_and(|value| value != &origin)
        || (method == "POST"
            && if upload {
                !content_type.starts_with("image/") && content_type != "application/octet-stream"
            } else {
                content_type != "application/json"
            })
    {
        write_response(
            stream,
            403,
            "application/json",
            &[],
            br#"{"error":"Forbidden"}"#,
        );
        return Ok(None);
    }
    // 大きすぎる本文は受け取らない（確保に失敗してプロセスごと落ちないように）
    let len: usize = headers
        .get("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    if len > MAX_BODY {
        // 上限まで読み捨ててから 400 を返す（読み残すと RST が飛んで 400 が届かないことがある）
        let mut sink = vec![0u8; 64 * 1024];
        let mut left = len.min(8 * 1024 * 1024);
        while left > 0 {
            let want = left.min(sink.len());
            match reader.read(&mut sink[..want]) {
                Ok(0) | Err(_) => break,
                Ok(n) => left -= n,
            }
        }
        let body = r#"{"error":"本文が大きすぎます"}"#.as_bytes();
        write_response(stream, 400, "application/json; charset=utf-8", &[], body);
        return Ok(None);
    }
    let mut body = vec![0u8; len];
    if len > 0 {
        reader.read_exact(&mut body)?;
    }
    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p.to_string(), parse_query(q)),
        None => (target.clone(), HashMap::new()),
    };
    Ok(Some(Request {
        method,
        path: percent_decode(&path),
        query,
        body,
    }))
}

pub(crate) fn parse_query(q: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for pair in q.split('&').filter(|p| !p.is_empty()) {
        let (k, v) = match pair.split_once('=') {
            Some((k, v)) => (k, v),
            None => (pair, ""),
        };
        out.insert(
            percent_decode(&k.replace('+', " ")),
            percent_decode(&v.replace('+', " ")),
        );
    }
    out
}

pub(crate) fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let hex = |c: u8| (c as char).to_digit(16).map(|d| d as u8);
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn status_text(code: u16) -> &'static str {
    match code {
        200 => "OK",
        302 => "Found",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        409 => "Conflict",
        _ => "Internal Server Error",
    }
}

/// 受け取る本文の上限（画像のアップロードや PowerPoint を考えて 64MB）
const MAX_BODY: usize = 64 * 1024 * 1024;

fn write_response(
    stream: &mut TcpStream,
    code: u16,
    content_type: &str,
    extra: &[(&str, String)],
    body: &[u8],
) {
    write_response_csp(stream, code, content_type, extra, body, false);
}

fn write_response_csp(
    stream: &mut TcpStream,
    code: u16,
    content_type: &str,
    extra: &[(&str, String)],
    body: &[u8],
    _allow_inline_script: bool,
) {
    let mut head = format!("HTTP/1.1 {} {}\r\n", code, status_text(code));
    head.push_str(&format!("content-type: {content_type}\r\n"));
    head.push_str(&format!("content-length: {}\r\n", body.len()));
    head.push_str("cache-control: no-store\r\n");
    if content_type.starts_with("text/html") {
        let script = "script-src 'self';";
        head.push_str(&format!(
            "content-security-policy: default-src 'self' ipc: http://ipc.localhost; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; {script} font-src 'self' data:; frame-src 'self'; connect-src 'self' ipc: http://ipc.localhost\r\n"
        ));
    }
    for (k, v) in extra {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("connection: close\r\n\r\n");
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body);
    let _ = stream.flush();
}

// JSON の孤立した UTF-16 サロゲートを Node のファイル保存と同じ U+FFFD にする。
// エスケープされたバックスラッシュと、正しいサロゲート対はそのまま残す。
fn json_body(bytes: &[u8]) -> Result<Value, serde_json::Error> {
    fn unit(bytes: &[u8], at: usize) -> Option<u16> {
        if bytes.get(at..at + 2)? != b"\\u" {
            return None;
        }
        u16::from_str_radix(std::str::from_utf8(bytes.get(at + 2..at + 6)?).ok()?, 16).ok()
    }
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    let mut quoted = false;
    while i < bytes.len() {
        if bytes[i] == b'"' {
            quoted = !quoted;
        }
        if quoted && bytes[i] == b'\\' {
            if let Some(value) = unit(bytes, i) {
                if (0xd800..=0xdbff).contains(&value)
                    && unit(bytes, i + 6).is_some_and(|v| (0xdc00..=0xdfff).contains(&v))
                {
                    out.extend_from_slice(&bytes[i..i + 12]);
                    i += 12;
                    continue;
                }
                if (0xd800..=0xdfff).contains(&value) {
                    out.extend_from_slice(b"\\ufffd");
                    i += 6;
                    continue;
                }
            }
            out.push(bytes[i]);
            i += 1;
            if i < bytes.len() {
                out.push(bytes[i]);
                i += 1;
            }
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    serde_json::from_slice(&out)
}

fn send_json(stream: &mut TcpStream, code: u16, body: Value) {
    write_response(
        stream,
        code,
        "application/json; charset=utf-8",
        &[],
        body.to_string().as_bytes(),
    );
}

fn mime_of(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .as_deref()
    {
        Some("html") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        Some("woff2") => "font/woff2",
        Some("pdf") => "application/pdf",
        _ => "application/octet-stream",
    }
}

fn serve_file(stream: &mut TcpStream, path: &Path) {
    // SVG-Edit はインラインのスクリプトを使うので、そこだけ許可する（本体の画面は許可しない）
    let inline = path.components().any(|c| c.as_os_str() == "svgedit")
        || path
            .file_name()
            .map(|f| f == "shape-host.html")
            .unwrap_or(false);
    match std::fs::read(path) {
        Ok(data) => write_response_csp(stream, 200, mime_of(path), &[], &data, inline),
        Err(_) => write_response(stream, 404, "text/plain; charset=utf-8", &[], b"not found"),
    }
}

/// リポジトリ（root）からの見せ方。外にあるものはホームを ~ にして返す
pub fn display_path(root: &Path, f: &Path) -> String {
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let f = f.canonicalize().unwrap_or_else(|_| f.to_path_buf());
    match f.strip_prefix(&root) {
        Ok(r) => r.to_string_lossy().to_string(),
        Err(_) => {
            let home = std::env::var("HOME").unwrap_or_default();
            let s = f.to_string_lossy().to_string();
            if !home.is_empty() && s.starts_with(&home) {
                s.replacen(&home, "~", 1)
            } else {
                s
            }
        }
    }
}

/// `127.0.0.1:4860` のような host を、そのまま SocketAddr にする（ポートが無いときだけ 80 を足す）
fn addr_of(host: &str) -> Option<SocketAddr> {
    let host = host.trim_start_matches("http://").trim_end_matches('/');
    let host = host.split('/').next().unwrap_or(host);
    if host.contains(':') {
        host.parse().ok()
    } else {
        format!("{host}:80").parse().ok()
    }
}

fn http_get(host: &str, path: &str, timeout_ms: u64) -> Option<(u16, String)> {
    let addr: SocketAddr = addr_of(host)?;
    let stream = TcpStream::connect_timeout(&addr, Duration::from_millis(timeout_ms)).ok()?;
    stream
        .set_read_timeout(Some(Duration::from_millis(timeout_ms)))
        .ok()?;
    let mut stream = stream;
    let req = format!("GET {path} HTTP/1.0\r\nhost: {host}\r\nconnection: close\r\n\r\n");
    stream.write_all(req.as_bytes()).ok()?;
    let mut buf = Vec::new();
    stream.read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf).to_string();
    let code: u16 = text
        .split_whitespace()
        .nth(1)
        .and_then(|c| c.parse().ok())?;
    let body = text.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
    Some((code, body))
}

// --- ルーティング ---------------------------------------------------------------------------

fn handle(ctx: Arc<Context>, mut stream: TcpStream) -> std::io::Result<()> {
    let Some(req) = read_request(&mut stream)? else {
        return Ok(());
    };
    let p = req.path.as_str();
    let query = |k: &str| req.query.get(k).cloned().unwrap_or_default();
    let deck = ctx.deck.clone();

    // --- 画面（HTML・CSS・JS） ---
    let client = ctx.root.join("marp/editor/client");
    match (req.method.as_str(), p) {
        ("GET", "/") | ("GET", "/index.html") => {
            serve_file(&mut stream, &client.join("index.html"));
            return Ok(());
        }
        ("GET", "/app.css") => {
            serve_file(&mut stream, &client.join("app.css"));
            return Ok(());
        }
        ("GET", "/app.js") => {
            serve_file(&mut stream, &ctx.bundle_dir.join("app.js"));
            return Ok(());
        }
        ("GET", "/render-worker.js") => {
            serve_file(&mut stream, &ctx.bundle_dir.join("render-worker.js"));
            return Ok(());
        }
        ("GET", "/present.js") => {
            serve_file(&mut stream, &ctx.bundle_dir.join("present.js"));
            return Ok(());
        }
        ("GET", "/present-launch.js") => {
            serve_file(&mut stream, &client.join("present-launch.mjs"));
            return Ok(());
        }
        ("GET", "/present") | ("GET", "/presenter") | ("GET", "/preview") => {
            serve_file(&mut stream, &client.join(format!("{}.html", &p[1..])));
            return Ok(());
        }
        ("GET", "/present.css") | ("GET", "/preview.css") => {
            serve_file(&mut stream, &client.join(&p[1..]));
            return Ok(());
        }
        ("GET", "/split") => {
            write_response(
                &mut stream,
                302,
                "text/plain; charset=utf-8",
                &[("location", "/?view=split".into())],
                b"",
            );
            return Ok(());
        }
        _ => {}
    }
    // 書き方の見本に使うダミーの図だけ（Node 版と同じ形に絞る。外のファイルを読まない）
    if let Some(name) = p.strip_prefix("/cheat/") {
        if is_cheat_name(name) {
            serve_file(&mut stream, &client.join("cheat").join(name));
        } else {
            write_response(
                &mut stream,
                404,
                "text/plain; charset=utf-8",
                &[],
                b"not found",
            );
        }
        return Ok(());
    }
    if p == "/svgedit/marpkit-host.js" {
        serve_file(&mut stream, &client.join("shape-host.mjs"));
        return Ok(());
    }
    if p == "/svgedit/marpkit-host.html" {
        serve_file(&mut stream, &client.join("shape-host.html"));
        return Ok(());
    }
    if let Some(rest) = p.strip_prefix("/svgedit/") {
        let base = ctx.root.join("node_modules/svgedit/dist/editor");
        serve_file(
            &mut stream,
            &safe_join(&base, rest).unwrap_or_else(|| base.join("__none__")),
        );
        return Ok(());
    }
    if let Some(rest) = p.strip_prefix("/theme-assets/") {
        let base = ctx.root.join("marp/themes/assets");
        serve_file(
            &mut stream,
            &safe_join(&base, rest).unwrap_or_else(|| base.join("__none__")),
        );
        return Ok(());
    }
    if let Some(rest) = p.strip_prefix("/deck/") {
        let base = deck.deck_dir.clone();
        serve_file(
            &mut stream,
            &safe_join(&base, rest).unwrap_or_else(|| base.join("__none__")),
        );
        return Ok(());
    }
    if p == "/favicon.ico" {
        write_response(&mut stream, 204, "text/plain; charset=utf-8", &[], b"");
        return Ok(());
    }

    // --- API ---
    let result: Result<(), ApiError> = (|| {
        match (req.method.as_str(), p) {
            ("GET", "/api/info") => {
                let themes = themes_json(&ctx.root);
                send_json(
                    &mut stream,
                    200,
                    json!({
                                "file": display_path(&ctx.root, &deck.deck_path),
                                "abs": deck.deck_path.to_string_lossy(),
                    "exports": (["pdf", "pdf-notes", "pptx", "html"].into_iter().filter(|fmt| deck.export_file(fmt).is_some()).collect::<Vec<_>>()),
                                "name": deck.deck_dir.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(),
                                "slides": ctx.root.join("marp/bin/slides.mjs").to_string_lossy(),
                                "themes": themes,
                                "hub": ctx.hub.url(),
                            }),
                );
            }
            ("GET", "/api/notes") => send_json(&mut stream, 200, deck.notes_get()),
            ("PUT", "/api/notes") => {
                let v: Value =
                    json_body(&req.body).map_err(|_| ApiError::new(400, "JSONとして読めません"))?;
                deck.notes_save(&v)?;
                send_json(&mut stream, 200, json!({ "ok": true }));
            }
            ("GET", "/api/deck") => {
                let (text, hash) = deck.read_deck()?;
                send_json(&mut stream, 200, json!({ "text": text, "hash": hash }));
            }
            ("PUT", "/api/deck") => {
                let v: Value =
                    json_body(&req.body).map_err(|_| ApiError::new(400, "JSONとして読めません"))?;
                let text = v
                    .get("text")
                    .and_then(|t| t.as_str())
                    .ok_or_else(|| ApiError::new(400, "text が必要です"))?;
                let base = v.get("base").and_then(|b| b.as_str()).unwrap_or("");
                let force = v.get("force").and_then(|f| f.as_bool()).unwrap_or(false);
                match deck.save_deck(text, base, force)? {
                    SaveOutcome::Conflict { text: theirs, hash } => {
                        send_json(
                            &mut stream,
                            409,
                            json!({ "error": "conflict", "text": theirs, "hash": hash }),
                        );
                    }
                    SaveOutcome::Ok { hash } => {
                        send_json(
                            &mut stream,
                            200,
                            json!({ "ok": true, "savedAt": now_ms(), "hash": hash }),
                        );
                        // 発表画面向けに「保存した」を知らせる（Node 版と同じ）
                        deck.broadcast("saved", json!({ "text": std::fs::read_to_string(&deck.deck_path).unwrap_or_default() }));
                    }
                }
            }
            ("POST", "/api/upload") => {
                let path = deck.upload(&query("name"), &req.body)?;
                send_json(&mut stream, 200, json!({ "path": path }));
            }
            ("GET", "/api/history") => {
                let items = deck.history.list().map_err(|e| ApiError::new(500, e))?;
                let git = deck.git_log();
                send_json(&mut stream, 200, json!({ "items": items, "git": git }));
            }
            ("GET", "/api/history/text") => {
                let id = query("id");
                let rev = query("rev");
                if !rev.is_empty() {
                    if !crate::git::valid_rev(&rev) {
                        return Err(ApiError::new(400, "版の指定が正しくありません"));
                    }
                    match deck.git_text(&rev) {
                        Some(text) => send_json(&mut stream, 200, json!({ "text": text })),
                        None => {
                            send_json(&mut stream, 404, json!({ "error": "版が見つかりません" }))
                        }
                    }
                } else {
                    match deck.history.text(&id) {
                        Some(text) => {
                            let entry = deck.history.get(&id);
                            send_json(&mut stream, 200, json!({ "text": text, "entry": entry }));
                        }
                        None => {
                            send_json(&mut stream, 404, json!({ "error": "版が見つかりません" }))
                        }
                    }
                }
            }
            ("GET", _) if p.starts_with("/api/history/object/") => {
                let h = p.rsplit('/').next().unwrap_or("");
                match deck.history.object(h) {
                    Ok(buf) => {
                        let sniffed =
                            String::from_utf8_lossy(&buf[..buf.len().min(200)]).contains("<svg");
                        let ct = if !query("type").is_empty() {
                            query("type")
                        } else if sniffed {
                            "image/svg+xml".to_string()
                        } else {
                            "application/octet-stream".to_string()
                        };
                        write_response(
                            &mut stream,
                            200,
                            &ct,
                            &[("cache-control", "max-age=31536000, immutable".into())],
                            &buf,
                        );
                    }
                    Err(_) => send_json(&mut stream, 404, json!({ "error": "見つかりません" })),
                }
            }
            ("POST", "/api/history/named") => {
                let v: Value = json_body(&req.body).unwrap_or(json!({}));
                let label = v.get("label").and_then(|l| l.as_str()).unwrap_or("");
                let label: String = label.chars().take(80).collect();
                let label = if label.trim().is_empty() {
                    "名前なし".to_string()
                } else {
                    label
                };
                let text = std::fs::read_to_string(&deck.deck_path).unwrap_or_default();
                let e = deck
                    .history
                    .record(&text, "named", &label)
                    .map_err(|e| ApiError::new(500, e))?;
                send_json(&mut stream, 200, json!({ "entry": e }));
            }
            ("POST", "/api/history/rename") => {
                let v: Value = json_body(&req.body).unwrap_or(json!({}));
                let id = v.get("id").and_then(|x| x.as_str()).unwrap_or("");
                let label: String = v
                    .get("label")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .chars()
                    .take(80)
                    .collect();
                send_json(
                    &mut stream,
                    200,
                    json!({ "entry": deck.history.rename(id, &label) }),
                );
            }
            ("POST", "/api/history/restoring") => {
                let v: Value = json_body(&req.body).unwrap_or(json!({}));
                let label = v.get("label").and_then(|l| l.as_str()).unwrap_or("");
                deck.mark_restoring(if label.is_empty() {
                    "版を戻した"
                } else {
                    label
                });
                send_json(&mut stream, 200, json!({ "ok": true }));
            }
            ("POST", "/api/history/restore-figure") => {
                let v: Value = json_body(&req.body).unwrap_or(json!({}));
                let rel = v.get("path").and_then(|x| x.as_str()).unwrap_or("");
                let h = v.get("hash").and_then(|x| x.as_str());
                let label = v.get("label").and_then(|x| x.as_str()).unwrap_or("");
                // Node 版と同じく、デッキのフォルダの外に出ないことを確かめる。
                // `figs/../slides.md` のように畳むと外へ出る指定は、畳む前に断る（S03）
                if !crate::deck::is_fig_rel(rel) {
                    return Err(ApiError::new(403, "figs/ の中だけ戻せます"));
                }
                let Some(f) = crate::deck::inside(&deck.deck_dir, rel) else {
                    return Err(ApiError::new(403, "figs/ の中だけ戻せます"));
                };
                let fig_label = if label.is_empty() {
                    format!("{rel} を戻した")
                } else {
                    label.to_string()
                };
                deck.set_fig_label(rel, &fig_label);
                match h {
                    Some(hash) if !hash.is_empty() => {
                        let buf = deck
                            .history
                            .object(hash)
                            .map_err(|_| ApiError::new(404, "見つかりません"))?;
                        crate::deck::atomic_write(&f, &buf)
                            .map_err(|e| ApiError::new(500, e.to_string()))?;
                    }
                    _ => {
                        let _ = std::fs::remove_file(&f);
                    }
                }
                send_json(&mut stream, 200, json!({ "ok": true }));
            }
            ("POST", "/api/git/commit") => {
                let v: Value = json_body(&req.body).unwrap_or(json!({}));
                let message = v.get("message").and_then(|m| m.as_str()).unwrap_or("");
                let Some(root) = deck.repo_root() else {
                    return Err(ApiError::new(400, "この資料は Git で管理されていません"));
                };
                let root_path = PathBuf::from(&root);
                let dir = crate::deck::relative_posix(&root_path, &deck.deck_dir);
                let message = if message.trim().is_empty() {
                    "資料を更新"
                } else {
                    message.trim()
                };
                match G::commit(&root_path, &dir, message) {
                    Ok(short) => send_json(&mut stream, 200, json!({ "result": short })),
                    Err(e) => return Err(ApiError::new(400, e.0)),
                }
            }
            ("GET", "/api/file") => {
                let (text, drawio) = deck.read_file(&query("path"))?;
                send_json(&mut stream, 200, json!({ "text": text, "drawio": drawio }));
            }
            ("PUT", "/api/file") => {
                deck.write_file(&query("path"), &req.body)?;
                send_json(&mut stream, 200, json!({ "ok": true }));
            }
            ("POST", "/api/new-figure") => {
                let path = deck.new_figure()?;
                send_json(&mut stream, 200, json!({ "path": path }));
            }
            ("POST", "/api/open-drawio") => {
                deck.open_drawio(&query("path"))?;
                send_json(&mut stream, 200, json!({ "ok": true }));
            }
            ("POST", "/api/export") => {
                let fmt = query("format");
                let info = deck.run_export(&fmt)?;
                send_json(&mut stream, 200, info);
            }
            ("GET", "/api/export-file") => {
                let fmt = query("format");
                match deck.export_file(&fmt) {
                    Some((path, name)) => {
                        let mime = Deck::export_mime(&fmt).unwrap_or("application/octet-stream");
                        let ext = Deck::export_ext(&fmt).unwrap_or("bin");
                        let data =
                            std::fs::read(&path).map_err(|e| ApiError::new(404, e.to_string()))?;
                        let encoded: String = percent_encode(&name);
                        write_response(
                            &mut stream,
                            200,
                            mime,
                            &[("content-disposition", format!("attachment; filename=\"export.{ext}\"; filename*=UTF-8''{encoded}"))],
                            &data,
                        );
                    }
                    None => send_json(
                        &mut stream,
                        404,
                        json!({ "error": "まだ書き出していません" }),
                    ),
                }
            }
            ("POST", "/api/reveal") => {
                let fmt = query("format");
                match deck.export_file(&fmt) {
                    Some((path, _)) => {
                        let _ = std::process::Command::new("open")
                            .arg("-R")
                            .arg(&path)
                            .spawn();
                        send_json(&mut stream, 200, json!({ "ok": true }));
                    }
                    None => send_json(
                        &mut stream,
                        404,
                        json!({ "error": "まだ書き出していません" }),
                    ),
                }
            }
            ("POST", "/api/import-pages") => {
                let v: Value = json_body(&req.body).unwrap_or(json!({}));
                let text = v.get("text").and_then(|t| t.as_str()).unwrap_or("");
                let from = v.get("from").and_then(|f| f.as_str()).map(PathBuf::from);
                let r: BringResult = deck.bring_figures(text, from.as_deref(), &deck.deck_dir)?;
                send_json(
                    &mut stream,
                    200,
                    json!({ "text": r.text, "copied": r.copied, "renamed": r.renamed }),
                );
            }
            ("GET", "/api/copy-targets") => {
                let Some(hub) = ctx.hub.url() else {
                    send_json(
                        &mut stream,
                        200,
                        json!({ "targets": [], "error": "ライブラリーが動いていません" }),
                    );
                    return Ok(());
                };
                match copy_targets(&hub, &deck.deck_path) {
                    Ok(targets) => send_json(&mut stream, 200, json!({ "targets": targets })),
                    Err(e) => send_json(&mut stream, 200, json!({ "targets": [], "error": e })),
                }
            }
            ("POST", "/api/send-pages") => {
                let v: Value = json_body(&req.body).unwrap_or(json!({}));
                let text = v.get("text").and_then(|t| t.as_str()).unwrap_or("");
                let target = v.get("target").and_then(|t| t.as_str()).unwrap_or("");
                let (copied, renamed) = deck.send_pages(text, target)?;
                send_json(
                    &mut stream,
                    200,
                    json!({ "ok": true, "copied": copied, "renamed": renamed }),
                );
            }
            ("POST", "/api/check") => {
                let v: Value = json_body(&req.body).unwrap_or(json!({}));
                let text = v.get("text").and_then(|t| t.as_str()).unwrap_or("");
                let result = deck.run_check(text)?;
                send_json(&mut stream, 200, result);
            }
            ("GET", "/api/events") => {
                // SSE。接続を開いたまま、資料の変化を送る
                let head = "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncache-control: no-store\r\nconnection: keep-alive\r\n\r\n: ok\n\n";
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.flush();
                let rx = deck.subscribe();
                while let Ok(ev) = rx.recv() {
                    let msg = format!("event: {}\ndata: {}\n\n", ev.name, ev.data);
                    if stream.write_all(msg.as_bytes()).is_err() || stream.flush().is_err() {
                        break;
                    }
                }
            }
            _ => {
                write_response(
                    &mut stream,
                    404,
                    "text/plain; charset=utf-8",
                    &[],
                    b"not found",
                );
            }
        }
        Ok(())
    })();

    if let Err(e) = result {
        send_json(
            &mut stream,
            e.status,
            json!({ "error": e.message, "detail": e.detail }),
        );
    }
    Ok(())
}

/// `/cheat/` で配る名前（Node 版の `/^\/cheat\/[a-z-]+\.svg$/` と同じ）
pub(crate) fn is_cheat_name(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".svg") else {
        return false;
    };
    !stem.is_empty() && stem.chars().all(|c| c.is_ascii_lowercase() || c == '-')
}

/// 名前の要素が `..` のときだけ弾く（`figs/a..b.png` のような名前は通す）
pub(crate) fn safe_join(base: &Path, rel: &str) -> Option<PathBuf> {
    if rel.split(['/', '\\']).any(|part| part == "..") {
        return None;
    }
    crate::deck::inside(base, rel)
}

fn percent_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.as_bytes() {
        match *b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// テーマの CSS（画像・フォントは data URI にせず、URL で配る）
pub fn themes_json(root: &Path) -> Vec<String> {
    let dir = root.join("marp/themes");
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().to_string())
                .filter(|f| f.ends_with(".css"))
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    let mut css: Vec<String> = names
        .iter()
        .filter_map(|f| std::fs::read_to_string(dir.join(f)).ok())
        .map(|c| c.replace("url(\"assets/", "url(\"/theme-assets/"))
        .collect();
    css.sort_by_key(|c| if c.contains("@import") { 1 } else { 0 });
    css
}

/// 貼り付け先に選べる資料（ハブの一覧から）。アプリの中からも使う
pub fn copy_targets_pub(hub: &str, deck_path: &Path) -> Result<Vec<Value>, String> {
    copy_targets(hub, deck_path)
}

fn copy_targets(hub: &str, deck_path: &Path) -> Result<Vec<Value>, String> {
    let host = hub.trim_start_matches("http://").trim_end_matches('/');
    let host = host.split('/').next().unwrap_or(host).to_string();
    let (code, body) =
        http_get(&host, "/api/libraries", 2000).ok_or("ライブラリーに接続できません")?;
    if code != 200 {
        return Err("ライブラリーに接続できません".into());
    }
    let libs: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let mut targets = Vec::new();
    for l in libs
        .get("libraries")
        .and_then(|x| x.as_array())
        .cloned()
        .unwrap_or_default()
    {
        let id = l.get("id").and_then(|x| x.as_str()).unwrap_or("");
        let name = l.get("name").and_then(|x| x.as_str()).unwrap_or("");
        let path = l
            .get("path")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .replace('~', &std::env::var("HOME").unwrap_or_default());
        let (code, body) = match http_get(
            &host,
            &format!("/api/decks?lib={}", percent_encode(id)),
            5000,
        ) {
            Some(v) => v,
            None => continue,
        };
        if code != 200 {
            continue;
        }
        let decks: Value = serde_json::from_str(&body).unwrap_or(json!({}));
        for d in decks
            .get("decks")
            .and_then(|x| x.as_array())
            .cloned()
            .unwrap_or_default()
        {
            let archived = d.get("archived").and_then(|x| x.as_bool()).unwrap_or(false);
            if archived {
                continue;
            }
            let slug = d.get("slug").and_then(|x| x.as_str()).unwrap_or("");
            let file = PathBuf::from(&path).join(slug).join("slides.md");
            if file == deck_path {
                continue;
            }
            targets.push(json!({
                "lib": name,
                "slug": slug,
                "title": d.get("title").cloned().unwrap_or(json!("")),
                "pages": d.get("pages").cloned().unwrap_or(json!(0)),
                "updated": d.get("updated").cloned().unwrap_or(json!(0)),
                "file": file.to_string_lossy(),
            }));
        }
    }
    targets.sort_by_key(|t| -(t.get("updated").and_then(|u| u.as_f64()).unwrap_or(0.0) as i64));
    Ok(targets)
}

// --- ライブラリー（ハブ）の画面のサーバー ------------------------------------------------
// アプリの中では、ライブラリーの画面もアプリ自身が配る（API は invoke）。
// ブラウザで使うときは、今までどおり Node のハブのサーバー（marp/hub/server.mjs）を使う。

struct HubContext {
    root: PathBuf,
    bundle_dir: PathBuf,
}

pub fn start_hub(root: PathBuf, bundle_dir: PathBuf) -> Result<u16, String> {
    ensure_bundle(&root, &bundle_dir)?;
    let listener =
        TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let ctx = Arc::new(HubContext { root, bundle_dir });
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let ctx = Arc::clone(&ctx);
            std::thread::spawn(move || {
                let _ = handle_hub(ctx, stream);
            });
        }
    });
    Ok(port)
}

fn handle_hub(ctx: Arc<HubContext>, mut stream: TcpStream) -> std::io::Result<()> {
    let Some(req) = read_request(&mut stream)? else {
        return Ok(());
    };
    let p = req.path.clone();
    let query = |k: &str| req.query.get(k).cloned().unwrap_or_default();
    let client = ctx.root.join("marp/hub/client");

    match (req.method.as_str(), p.as_str()) {
        ("GET", "/") | ("GET", "/index.html") => {
            serve_file(&mut stream, &client.join("index.html"))
        }
        ("GET", "/hub.css") => serve_file(&mut stream, &client.join("hub.css")),
        ("GET", "/hub.js") => serve_file(&mut stream, &ctx.bundle_dir.join("hub.js")),
        ("GET", "/favicon.ico") => {
            write_response(&mut stream, 204, "text/plain; charset=utf-8", &[], b"")
        }
        _ => {
            if let Some(rest) = p.strip_prefix("/app/") {
                serve_file(
                    &mut stream,
                    &safe_join(&client.join("app"), rest)
                        .unwrap_or_else(|| client.join("__none__")),
                );
            } else if let Some(rest) = p.strip_prefix("/theme-assets/") {
                let base = ctx.root.join("marp/themes/assets");
                serve_file(
                    &mut stream,
                    &safe_join(&base, rest).unwrap_or_else(|| base.join("__none__")),
                );
            } else if let Some(rest) = p.strip_prefix("/template-files/") {
                let base=ctx.root.join("marp/templates");
                serve_file(&mut stream,&safe_join(&base,rest).unwrap_or_else(||base.join("__none__")));
            } else if let Some(rest) = p.strip_prefix("/files/") {
                // /files/<lib>/<slug>/<path>
                let parts: Vec<&str> = rest.splitn(3, '/').collect();
                let libs = crate::library::load_config();
                // ライブラリーの外に出ない（Node 版の inside() と同じ）
                let found: Option<PathBuf> = if parts.len() == 3 {
                    libs.iter()
                        .find(|l| l.id == parts[0])
                        .and_then(|l| safe_join(&l.path, &format!("{}/{}", parts[1], parts[2])))
                } else {
                    None
                };
                match found {
                    Some(f) => serve_file(&mut stream, &f),
                    None => write_response(&mut stream, 403, "text/plain; charset=utf-8", &[], b""),
                }
            } else if p.starts_with("/git-file/") {
                // /git-file/<lib>?rev=&path=（path はライブラリーからの相対）
                let id = p.trim_start_matches("/git-file/").to_string();
                let libs = crate::library::load_config();
                match libs.iter().find(|l| l.id == id) {
                    Some(lib) => match crate::git::repo_root(&lib.path) {
                        Some(repo) => {
                            let repo_path = PathBuf::from(&repo);
                            let rel = lib
                                .path
                                .strip_prefix(&repo_path)
                                .map(|x| x.to_string_lossy().to_string())
                                .unwrap_or_else(|_| ".".into());
                            let file = if rel.is_empty() || rel == "." {
                                query("path")
                            } else {
                                format!("{rel}/{}", query("path"))
                            };
                            match crate::git::show(&repo_path, &query("rev"), &file) {
                                Some(buf) => {
                                    let ct = mime_of(Path::new(&file)).to_string();
                                    write_response(
                                        &mut stream,
                                        200,
                                        &ct,
                                        &[("cache-control", "max-age=3600".into())],
                                        &buf,
                                    );
                                }
                                None => write_response(
                                    &mut stream,
                                    404,
                                    "text/plain; charset=utf-8",
                                    &[],
                                    b"",
                                ),
                            }
                        }
                        None => {
                            write_response(&mut stream, 404, "text/plain; charset=utf-8", &[], b"")
                        }
                    },
                    None => write_response(&mut stream, 404, "text/plain; charset=utf-8", &[], b""),
                }
            } else {
                write_response(
                    &mut stream,
                    404,
                    "text/plain; charset=utf-8",
                    &[],
                    b"not found",
                );
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addr_of_keeps_the_port() {
        assert!(addr_of("127.0.0.1:4860").is_some());
        assert_eq!(addr_of("127.0.0.1:4860").unwrap().port(), 4860);
        assert_eq!(addr_of("http://127.0.0.1:4860/").unwrap().port(), 4860);
        assert_eq!(addr_of("127.0.0.1").unwrap().port(), 80);
        assert!(addr_of("").is_none());
    }

    #[test]
    fn http_get_reads_a_response() {
        // 小さなサーバーを立てて、ハブの検出と同じ手順で読めるか確かめる
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = listener.accept() {
                let mut buf = [0u8; 1024];
                let _ = s.read(&mut buf);
                let body = "{\"themes\":[]}";
                let _ = s.write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    )
                    .as_bytes(),
                );
            }
        });
        std::thread::sleep(std::time::Duration::from_millis(100));
        let got = http_get(&format!("127.0.0.1:{port}"), "/api/info", 2000);
        assert!(got.is_some(), "127.0.0.1:{port} に接続できません");
        let (code, body) = got.unwrap();
        assert_eq!(code, 200);
        assert!(body.contains("themes"));
    }

    #[test]
    fn percent_decode_handles_multibyte_and_broken_escapes() {
        assert_eq!(percent_decode("/deck/%E3%81%82.svg"), "/deck/あ.svg");
        assert_eq!(percent_decode("/deck/%あ"), "/deck/%あ"); // 壊れていても panic しない
        assert_eq!(percent_decode("a+b%20c"), "a+b c");
    }

    #[test]
    fn safe_join_blocks_the_outside() {
        let base = Path::new("/tmp/x/deck");
        assert!(safe_join(base, "figs/a.svg").is_some());
        assert!(safe_join(base, "../secret").is_none());
        assert!(safe_join(base, "figs/../../secret").is_none());
        // 名前に .. が入っているだけの図は通す（アップロードで作られる名前）
        assert!(safe_join(base, "figs/a..b.png").is_some());
    }

    #[test]
    fn cheat_only_serves_the_sample_figures() {
        assert!(is_cheat_name("graph.svg"));
        assert!(is_cheat_name("face-a.svg"));
        assert!(!is_cheat_name("../../../../etc/hosts"));
        assert!(!is_cheat_name("/etc/hosts"));
        assert!(!is_cheat_name("Graph.svg"));
        assert!(!is_cheat_name("graph.svg/../../x"));
        assert!(!is_cheat_name("graph.png"));
    }

    #[test]
    fn cheat_requests_do_not_read_the_outside() {
        // 小さなサーバーを立てて、実際に要求を送ってみる
        let dir = std::env::temp_dir().join(format!("marp-cheat-{}", std::process::id()));
        let client = dir.join("marp/editor/client");
        std::fs::create_dir_all(client.join("cheat")).unwrap();
        std::fs::write(client.join("cheat/graph.svg"), "<svg/>").unwrap();
        std::fs::write(client.join("secret.txt"), "ないしょ").unwrap();
        std::fs::write(client.join("index.html"), "<!doctype html><title>x</title>").unwrap();
        std::fs::write(dir.join("slides.md"), "# 見本\n").unwrap();
        let bundle = dir.join(".check/rust-bundle");
        std::fs::create_dir_all(&bundle).unwrap();
        std::fs::write(dir.join("manifest.json"), br#"{"api":1}"#).unwrap();
        for f in ["app.js", "present.js", "hub.js", "export.js", "render-worker.js"] {
            std::fs::write(bundle.join(f), "// x").unwrap();
        }
        let port = start(Config {
            root: dir.clone(),
            deck_path: dir.join("slides.md"),
            port: 0,
            hub: None,
            bundle_dir: bundle,
        })
        .map(|r| r.port)
        .unwrap();
        let host = format!("127.0.0.1:{port}");
        // 見本の図は配る
        let (code, body) = http_get(&host, "/cheat/graph.svg", 5000).expect("応答がない");
        assert_eq!(code, 200, "見本の図が配られない");
        assert!(body.contains("<svg"), "見本の図の中身が違う");
        // 外のファイルは配らない（Node 版と同じ 404）
        for path in [
            "/cheat//etc/hosts",
            "/cheat/../../../../etc/hosts",
            "/cheat/../secret.txt",
            "/cheat/secret.txt",
        ] {
            let (code, body) = http_get(&host, path, 5000).expect("応答がない");
            assert_eq!(code, 404, "{path} が 404 にならない");
            assert!(!body.contains("root:"), "{path} で /etc/hosts が読めた");
            assert!(!body.contains("ないしょ"), "{path} で別のファイルが読めた");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
    #[test]
    fn json_preserves_pairs_and_literal_escapes_but_replaces_lone_surrogates() {
        let parsed = json_body(br#"{"pair":"\ud83d\ude80","high":"\ud800x","low":"\udfff","literal":"\\ud800","quote":"\"\ud800"}"#).unwrap();
        assert_eq!(parsed["pair"], "🚀");
        assert_eq!(parsed["high"], "�x");
        assert_eq!(parsed["low"], "�");
        assert_eq!(parsed["literal"], "\\ud800");
        assert_eq!(parsed["quote"], "\"�");
    }
}
