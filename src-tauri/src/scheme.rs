// アプリの画面と資料をカスタムスキームで配る。書き込みは invoke だけで行う。
use std::path::{Path, PathBuf};
use tauri::http::{Response, StatusCode};
use tauri::{AppHandle, Manager, Runtime};

type Body = std::borrow::Cow<'static, [u8]>;

pub fn register<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.register_asynchronous_uri_scheme_protocol("marp", |ctx, request, responder| {
        let app = ctx.app_handle().clone();
        let label = ctx.webview_label().to_string();
        let path = request.uri().path().to_string();
        if !matches!(request.method().as_str(), "GET" | "HEAD") || request.uri().host() != Some("localhost") {
            responder.respond(Response::builder().status(403).body(Vec::<u8>::new()).unwrap());
            return;
        }
        let query = crate::http::parse_query(request.uri().query().unwrap_or(""));
        if path == "/" {
            respond_redirect(responder, "marp://localhost/hub/");
            return;
        }
        if path == "/split" {
            respond_redirect(responder, "/editor/?view=split");
            return;
        }
        if path == "/favicon.ico" {
            let response: Response<Body> = Response::builder()
                .status(StatusCode::NO_CONTENT)
                .body(Body::Owned(Vec::new()))
                .unwrap();
            responder.respond(response);
            return;
        }
        std::thread::spawn(move || {
            let (status, mime, mut body) = serve(&app, &label, &path, &query);
            let etag = format!("\"{}\"", crate::hash::sha256_hex(&body));
            let cache = if mime.starts_with("font/") || query.get("v").is_some_and(|v| etag == format!("\"{v}\"")) { "public, max-age=31536000, immutable" } else { "no-cache" };
            let unchanged = request.headers().get("if-none-match").is_some_and(|v| v.as_bytes() == etag.as_bytes());
            let mut status = if unchanged { StatusCode::NOT_MODIFIED } else { status };
            let mut range_header = None;
            if !unchanged && status == StatusCode::OK {
                if let Some(range) = request.headers().get("range").and_then(|h| h.to_str().ok()) {
                    let len = body.len();
                    if let Some((start, end)) = byte_range(range, len) {
                        range_header = Some(format!("bytes {start}-{end}/{len}"));
                        body = body[start..=end].to_vec();
                        status = StatusCode::PARTIAL_CONTENT;
                    } else { status = StatusCode::RANGE_NOT_SATISFIABLE; body.clear(); range_header = Some(format!("bytes */{len}")); }
                }
            }
            if unchanged || request.method() == "HEAD" { body.clear(); }
            let mut response = Response::builder().status(status).header("content-type", mime)
                .header("cache-control", cache).header("etag", etag).header("accept-ranges", "bytes")
                .header("content-security-policy", "default-src 'self' ipc: http://ipc.localhost; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self' data:; frame-src 'self'; connect-src 'self' ipc: http://ipc.localhost");
            if let Some(value) = range_header { response = response.header("content-range", value); }
            let response: Response<Body> = response
                .body(Body::Owned(body))
                .unwrap_or_else(|_| {
                    Response::builder()
                        .status(StatusCode::INTERNAL_SERVER_ERROR)
                        .body(Body::Owned(Vec::new()))
                        .unwrap()
                });
            responder.respond(response);
        });
    })
}

fn respond_redirect(responder: tauri::UriSchemeResponder, location: &str) {
    let response: Response<Body> = Response::builder()
        .status(StatusCode::FOUND)
        .header("location", location)
        .body(Body::Owned(Vec::new()))
        .unwrap();
    responder.respond(response);
}

fn root() -> Option<PathBuf> {
    crate::hub::find_root().ok()
}

fn mime(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "pdf" => "application/pdf",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        _ => "application/octet-stream",
    }
}

fn read(path: &Path) -> Option<(StatusCode, &'static str, Vec<u8>)> {
    type Cached = (std::time::SystemTime, Vec<u8>);
    static CACHE: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<PathBuf, Cached>>,
    > = std::sync::OnceLock::new();
    let content_type = mime(path);
    let cacheable = content_type.starts_with("font/")
        || matches!(
            path.file_name().and_then(|n| n.to_str()),
            Some("app.js" | "hub.js" | "present.js" | "render-worker.js")
        );
    let data = if cacheable {
        let at = std::fs::metadata(path).ok()?.modified().ok()?;
        let mut cache = CACHE.get_or_init(Default::default).lock().ok()?;
        if let Some((saved, bytes)) = cache.get(path).filter(|(saved, _)| *saved == at) {
            let _ = saved;
            bytes.clone()
        } else {
            let bytes = std::fs::read(path).ok()?;
            cache.insert(path.to_path_buf(), (at, bytes.clone()));
            bytes
        }
    } else {
        std::fs::read(path).ok()?
    };
    Some((StatusCode::OK, content_type, data))
}

fn rewrite_html(mut html: String, prefix: &str) -> String {
    // base は一括置換の対象から外す（そのまま置換すると /editor/editor/deck/ になる）
    html = html.replace("<base href=\"/deck/\">", "__MARPKIT_BASE__");
    html = html.replace("href=\"/", &format!("href=\"{prefix}/"));
    html = html.replace("src=\"/", &format!("src=\"{prefix}/"));
    html = html.replace("url(\"/", &format!("url(\"{prefix}/"));
    html = html.replace(
        "__MARPKIT_BASE__",
        &format!("<base href=\"{prefix}/deck/\">"),
    );
    if let Some(root) = root() {
        for name in ["app.js", "hub.js", "present.js"] {
            if let Ok(bytes) = std::fs::read(root.join(".check/rust-bundle").join(name)) {
                html = html.replace(
                    &format!("/{name}\""),
                    &format!("/{name}?v={}\"", crate::hash::sha256_hex(&bytes)),
                );
            }
        }
    }
    html
}

fn serve<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    path: &str,
    query: &std::collections::HashMap<String, String>,
) -> (StatusCode, &'static str, Vec<u8>) {
    let p = crate::http::percent_decode(path);
    let Some(root) = root() else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "text/plain; charset=utf-8",
            "MARP_ROOT がありません".as_bytes().to_vec(),
        );
    };
    let client = root.join("marp/editor/client");
    let hub_client = root.join("marp/hub/client");
    let bundle = root.join(".check/rust-bundle");
    let missing = || {
        (
            StatusCode::NOT_FOUND,
            "text/plain; charset=utf-8",
            b"not found".to_vec(),
        )
    };
    // 要求を出したウインドウの資料。ライブラリーのウインドウには資料がない。
    let deck_path = app.state::<crate::app::AppState>().deck_of(label);
    let deck_dir = deck_path
        .as_deref()
        .and_then(|p| Path::new(p).parent().map(|x| x.to_path_buf()))
        .or_else(|| crate::native_export::deck_dir(label));
    if let Some(rest) = p.strip_prefix("/export/") {
        if crate::native_export::deck_dir(label).is_none() {
            return missing();
        }
        return if rest.is_empty() {
            read(&root.join("marp/export/index.html"))
        } else {
            crate::http::safe_join(&bundle, rest)
                .as_deref()
                .and_then(read)
        }
        .unwrap_or_else(missing);
    }

    if let Some(ctx) = app.state::<crate::app::AppState>().context_for(label) {
        if let Some(hash) = p.strip_prefix("/api/history/object/") {
            return ctx
                .deck
                .history
                .object(hash)
                .ok()
                .map(|bytes| (StatusCode::OK, "image/svg+xml", bytes))
                .unwrap_or_else(missing);
        }
        if p == "/api/export-file" {
            return query
                .get("format")
                .and_then(|fmt| ctx.deck.export_file(fmt))
                .as_ref()
                .and_then(|(file, _)| read(file))
                .unwrap_or_else(missing);
        }
    }
    if let Some(rest) = p.strip_prefix("/files/") {
        let parts: Vec<_> = rest.splitn(2, '/').collect();
        if parts.len() == 2 {
            return crate::library::load_config()
                .iter()
                .find(|l| l.id == parts[0])
                .and_then(|lib| crate::http::safe_join(&lib.path, parts[1]))
                .as_deref()
                .and_then(read)
                .unwrap_or_else(missing);
        }
        return missing();
    }
    if let Some(id) = p.strip_prefix("/git-file/") {
        let libs = crate::library::load_config();
        if let (Some(lib), Some(rev), Some(file)) = (
            libs.iter().find(|l| l.id == id),
            query.get("rev"),
            query.get("path"),
        ) {
            if let Some(repo) = crate::git::repo_root(&lib.path) {
                if crate::http::safe_join(&lib.path, file).is_some() {
                    let repo = PathBuf::from(repo);
                    let rel = lib
                        .path
                        .strip_prefix(&repo)
                        .unwrap_or(Path::new(""))
                        .join(file);
                    return crate::git::show(&repo, rev, &rel.to_string_lossy())
                        .map(|bytes| (StatusCode::OK, mime(&rel), bytes))
                        .unwrap_or_else(missing);
                }
            }
        }
        return missing();
    }
    if p == "/hub" || p == "/hub/" {
        let html = std::fs::read_to_string(hub_client.join("index.html")).unwrap_or_default();
        let html = rewrite_html(html, "/hub");
        return (
            StatusCode::OK,
            "text/html; charset=utf-8",
            html.into_bytes(),
        );
    }
    if let Some(rest) = p.strip_prefix("/hub/") {
        let rest = rest.trim_start_matches('/');
        let candidate = match rest {
            "hub.js" => Some(bundle.join("hub.js")),
            _ if rest.starts_with("chunks/") => crate::http::safe_join(&bundle, rest),
            "hub.css" => Some(hub_client.join("hub.css")),
            "manifest.webmanifest" => Some(hub_client.join("app/manifest.webmanifest")),
            _ if rest.starts_with("app/") => crate::http::safe_join(&hub_client, rest),
            _ if rest.starts_with("theme-assets/") => crate::http::safe_join(
                &root.join("marp/themes/assets"),
                &rest["theme-assets/".len()..],
            ),
            _ => crate::http::safe_join(&hub_client, rest),
        };
        return candidate.as_deref().and_then(read).unwrap_or_else(missing);
    }

    // 画面の JS が実行時に作る絶対パス（/svgedit/…・/deck/…）も、同じ場所へ配る
    if p == "/svgedit/marpkit-host.js" {
        return read(&client.join("shape-host.mjs")).unwrap_or_else(missing);
    }
    if p == "/svgedit/marpkit-host.html" {
        return read(&client.join("shape-host.html")).unwrap_or_else(missing);
    }
    if let Some(rest) = p.strip_prefix("/svgedit/") {
        return crate::http::safe_join(&root.join("node_modules/svgedit/dist/editor"), rest)
            .as_deref()
            .and_then(read)
            .unwrap_or_else(missing);
    }
    if let Some(rest) = p.strip_prefix("/deck/") {
        let Some(deck_dir) = deck_dir else {
            return missing();
        };
        return crate::http::safe_join(&deck_dir, rest)
            .as_deref()
            .and_then(read)
            .unwrap_or_else(missing);
    }
    if let Some(rest) = p.strip_prefix("/template-files/") {
        return crate::http::safe_join(&root.join("marp/templates"),rest).as_deref().and_then(read).unwrap_or_else(missing);
    }
    if let Some(rest) = p.strip_prefix("/theme-assets/") {
        return crate::http::safe_join(&root.join("marp/themes/assets"), rest)
            .as_deref()
            .and_then(read)
            .unwrap_or_else(missing);
    }
    if let Some(rest) = p.strip_prefix("/cheat/") {
        if !crate::http::is_cheat_name(rest) {
            return missing();
        }
        return read(&client.join("cheat").join(rest)).unwrap_or_else(missing);
    }

    if p == "/editor" || p == "/editor/" {
        let html = std::fs::read_to_string(client.join("index.html")).unwrap_or_default();
        let html = rewrite_html(html, "/editor");
        return (
            StatusCode::OK,
            "text/html; charset=utf-8",
            html.into_bytes(),
        );
    }
    if let Some(rest) = p.strip_prefix("/editor/") {
        let rest = rest.trim_start_matches('/');
        let candidate: Option<PathBuf> = match rest {
            "app.js" => Some(bundle.join("app.js")),
            "present.js" => Some(bundle.join("present.js")),
            "render-worker.js" => Some(bundle.join("render-worker.js")),
            _ if rest.starts_with("chunks/") => crate::http::safe_join(&bundle, rest),
            // http.rs と同じく、画面の .mjs を .js の名前で配る
            "present-launch.js" => Some(client.join("present-launch.mjs")),
            "app.css" | "present.css" | "preview.css" => Some(client.join(rest)),
            "present" | "presenter" | "preview" => {
                let name = format!("{rest}.html");
                let html = std::fs::read_to_string(client.join(&name)).unwrap_or_default();
                let html = rewrite_html(html, "/editor");
                return (
                    StatusCode::OK,
                    "text/html; charset=utf-8",
                    html.into_bytes(),
                );
            }
            _ if rest.starts_with("deck/") => {
                let Some(deck_dir) = deck_dir else {
                    return missing();
                };
                crate::http::safe_join(&deck_dir, &rest["deck/".len()..])
            }
            _ if rest.starts_with("svgedit/") => crate::http::safe_join(
                &root.join("node_modules/svgedit/dist/editor"),
                &rest["svgedit/".len()..],
            ),
            _ if rest.starts_with("cheat/") => {
                let name = &rest["cheat/".len()..];
                if !crate::http::is_cheat_name(name) {
                    None
                } else {
                    crate::http::safe_join(&client.join("cheat"), name)
                }
            }
            _ if rest.starts_with("theme-assets/") => crate::http::safe_join(
                &root.join("marp/themes/assets"),
                &rest["theme-assets/".len()..],
            ),
            _ => crate::http::safe_join(&client, rest),
        };
        return candidate.as_deref().and_then(read).unwrap_or_else(missing);
    }

    missing()
}

fn byte_range(value: &str, len: usize) -> Option<(usize, usize)> {
    let (start, end) = value.strip_prefix("bytes=")?.split_once('-')?;
    if len == 0 {
        return None;
    }
    if start.is_empty() {
        let count: usize = end.parse().ok()?;
        return (count > 0).then_some((len.saturating_sub(count), len - 1));
    }
    let start: usize = start.parse().ok()?;
    let end = if end.is_empty() {
        len - 1
    } else {
        end.parse::<usize>().ok()?.min(len - 1)
    };
    (start < len && start <= end).then_some((start, end))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ranges_are_bounded() {
        assert_eq!(byte_range("bytes=0-9", 100), Some((0, 9)));
        assert_eq!(byte_range("bytes=95-", 100), Some((95, 99)));
        assert_eq!(byte_range("bytes=-20", 100), Some((80, 99)));
        assert_eq!(byte_range("bytes=100-", 100), None);
        assert_eq!(byte_range("bytes=3-1", 100), None);
        assert_eq!(byte_range("bytes=0-1,3-4", 100), None);
    }
}
