// エディターのバックエンド（marp/editor/server.mjs の中身を Rust に写したもの）。
// HTTP の形は http.rs が持つ。ここは「資料1つ分」の仕事をする。
use crate::git as G;
use crate::hash::sha1_hex;
pub use crate::hash::sha1_hex as sha1_for_label;
use crate::history::History;
use crate::LockExt;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};

/// 子の process の英語のエラーを、画面に出す短い日本語にする（E04）
pub fn friendly_error(raw: &str) -> String {
    let text = raw.trim();
    let low = text.to_lowercase();
    if low.contains("node: not found") || low.contains("env: node") {
        return "Node が見つかりません。検査と書き出しには Node が要ります".to_string();
    }
    if low.contains("no suitable browser")
        || (low.contains("chrome") && (low.contains("not found") || low.contains("could not find")))
    {
        return "Google Chrome が見つかりません。検査と書き出しには Chrome が要ります".to_string();
    }
    if low.contains("enoent") || low.contains("no such file or directory") {
        return "書き出しに必要なファイルが見つかりません".to_string();
    }
    if low.contains("enospc") || low.contains("no space left") {
        return "ディスクの空きが足りません".to_string();
    }
    let last = text
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("書き出しに失敗しました");
    // スタックトレースや長いパスは画面に出さず、最後の1行だけにする
    last.chars().take(300).collect::<String>()
}
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
pub const MIME_JSON: &str = "application/json";

/// 詳しい内容として渡す、出力の末尾（長すぎないように行数で切る）
pub fn tail(text: &str, lines: usize) -> String {
    let all: Vec<&str> = text.lines().collect();
    let start = all.len().saturating_sub(lines);
    all[start..].join("\n")
}

#[derive(Debug)]
pub struct ApiError {
    pub status: u16,
    pub message: String,
    /// 画面には出さず［詳しい内容をコピー］で渡す元の出力（E04）
    pub detail: Option<String>,
}

impl ApiError {
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        ApiError {
            status,
            message: message.into(),
            detail: None,
        }
    }
    pub fn not_found(message: impl Into<String>) -> Self {
        ApiError::new(404, message)
    }
    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }
}

/// 保存の一時ファイルの名前に付ける連番
static NEXT_SAVE: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

pub fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// エディターから出るイベント（SSE）
#[derive(Clone)]
pub struct Event {
    pub name: String,
    pub data: String,
}

pub struct Deck {
    /// 閉じたときに立てる（watch のループとサーバーを止める）
    stopped: std::sync::atomic::AtomicBool,
    /// 書き出しの「やめる」（E03）
    cancel_export: std::sync::Arc<std::sync::atomic::AtomicBool>,
    /// 検査の「やめる」（E03）
    cancel_check: std::sync::Arc<std::sync::atomic::AtomicBool>,
    pub root: PathBuf,
    pub deck_path: PathBuf,
    pub deck_dir: PathBuf,
    pub history: History,
    hub: Option<String>,
    state: Mutex<State>,
    events: Mutex<Vec<Sender<Event>>>,
    /// Tauri のウインドウへ知らせる口（アプリの中ではこちらも使う）
    sink: Mutex<Option<EventSink>>,
    fig_memo: Mutex<HashMap<String, String>>,
    /// 図の変更（Some(Some(bytes))＝変わった・Some(None)＝消えた・入っていない＝触っていない）
    fig_pending: Mutex<HashMap<String, Option<Option<Vec<u8>>>>>,
    /// 図を戻したときのラベル（どの図に付けるか, ラベル）。その図の変化にだけ付ける
    fig_label: Mutex<Option<(String, String)>>,
}

struct State {
    last_written: String,
    restoring: String,
}

pub fn inside(base: &Path, rel: &str) -> Option<PathBuf> {
    if rel.is_empty() {
        // 空は base 自体（Node 版の path.resolve(base, '') と同じ）
        return Some(base.to_path_buf());
    }
    if rel.starts_with('/') {
        return None;
    }
    let p = base.join(rel);
    let norm = normalize(&p);
    let b = normalize(base);
    if (norm == b || norm.starts_with(format!("{}/", b.display())))
        && resolved_parent(&norm)?.starts_with(resolved_parent(&b)?)
    {
        Some(norm)
    } else {
        None
    }
}

// 存在しない保存先も、実在する親まで解決してシンボリックリンクの外への脱出を拒む。
pub(crate) fn resolved_parent(path: &Path) -> Option<PathBuf> {
    if let Ok(real) = path.canonicalize() {
        return Some(real);
    }
    if std::fs::symlink_metadata(path).is_ok() {
        return None;
    }
    Some(resolved_parent(path.parent()?)?.join(path.file_name()?))
}

/// 図の版を戻すときの相対パス。`figs/` の下だけで、`..` を含まない（S03）
pub fn is_fig_rel(rel: &str) -> bool {
    rel.starts_with("figs/")
        && !rel.contains('\\')
        && rel
            .split('/')
            .all(|p| !p.is_empty() && p != "." && p != "..")
}

/// 同じ場所を指しているか（`~` や `..` を畳んだ上で比べる）
pub fn same_dir(a: &Path, b: &Path) -> bool {
    normalize(a) == normalize(b)
}

/// `..` や `.` を畳む（存在しないファイルでも使えるように、文字の上で処理する）
fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

pub fn atomic_write(file: &Path, data: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let target = if std::fs::symlink_metadata(file).is_ok_and(|m| m.file_type().is_symlink()) {
        file.canonicalize()?
    } else {
        file.to_path_buf()
    };
    let serial = NEXT_SAVE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = target.with_file_name(format!(
        ".{}.{}.{}.{}.tmp",
        target.file_name().unwrap_or_default().to_string_lossy(),
        std::process::id(),
        now_ms(),
        serial
    ));
    let result = (|| {
        let mut output = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)?;
        output.write_all(data)?;
        if let Ok(metadata) = std::fs::metadata(&target) {
            output.set_permissions(metadata.permissions())?;
            #[cfg(target_os = "macos")]
            {
                use std::os::unix::ffi::OsStrExt;
                unsafe extern "C" {
                    fn copyfile(
                        from: *const libc::c_char,
                        to: *const libc::c_char,
                        state: *mut libc::c_void,
                        flags: u32,
                    ) -> i32;
                }
                let from = std::ffi::CString::new(target.as_os_str().as_bytes())?;
                let to = std::ffi::CString::new(tmp.as_os_str().as_bytes())?;
                if unsafe { copyfile(from.as_ptr(), to.as_ptr(), std::ptr::null_mut(), 7) } != 0 {
                    return Err(std::io::Error::last_os_error());
                }
            }
        }
        output.set_modified(SystemTime::now())?;
        output.sync_all()?;
        std::fs::rename(&tmp, &target)?;
        if let Some(parent) = target.parent() {
            std::fs::File::open(parent)?.sync_all()?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// 文字を置き換える（Node の replace(/[/\\]/g, '-') と同じ）
fn sanitize_name(name: &str) -> String {
    name.chars()
        .map(|c| if c == '/' || c == '\\' { '-' } else { c })
        .collect()
}

fn placeholder(w: u32, h: u32) -> String {
    format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {w} {h}\" width=\"{w}\" height=\"{h}\">\n  \
<rect x=\"2\" y=\"2\" width=\"{}\" height=\"{}\" rx=\"6\" fill=\"#fafafa\" stroke=\"#b9bec2\" stroke-width=\"2\" stroke-dasharray=\"10 8\"/>\n  \
<text x=\"{}\" y=\"{}\" text-anchor=\"middle\" font-family=\"Hiragino Sans, sans-serif\" font-size=\"28\" fill=\"#8a9196\">図をここに描く</text>\n</svg>\n",
        w - 4,
        h - 4,
        w / 2,
        h / 2 + 10
    )
}

#[derive(Serialize)]
pub struct BringResult {
    pub text: String,
    pub copied: Vec<String>,
    pub renamed: Vec<Renamed>,
}

#[derive(Serialize)]
pub struct Renamed {
    pub from: String,
    pub to: String,
}

pub enum SaveOutcome {
    Ok { hash: String },
    Conflict { text: String, hash: String },
}

impl Deck {
    pub fn open(root: &Path, deck_path: &Path, hub: Option<String>) -> Result<Deck, ApiError> {
        let deck_dir = deck_path.parent().unwrap_or(root).to_path_buf();
        let deck_file = deck_path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "slides.md".into());
        let history = History::open(&deck_dir, &deck_file);
        let text = read_text_lossy(deck_path)
            .map_err(|e| ApiError::new(400, format!("資料を読めません: {e}")))?;
        let deck = Deck {
            stopped: std::sync::atomic::AtomicBool::new(false),
            cancel_export: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            cancel_check: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            root: root.to_path_buf(),
            deck_path: deck_path.to_path_buf(),
            deck_dir: deck_dir.clone(),
            history,
            hub,
            state: Mutex::new(State {
                last_written: sha1_hex(text.as_bytes()),
                restoring: String::new(),
            }),
            events: Mutex::new(Vec::new()),
            sink: Mutex::new(None),
            fig_memo: Mutex::new(HashMap::new()),
            fig_pending: Mutex::new(HashMap::new()),
            fig_label: Mutex::new(None),
        };
        deck.remember_figures();
        // 開いたことを履歴に残す
        let _ = deck.history.record(&text, "open", "エディターで開いたとき");
        Ok(deck)
    }

    fn remember_figures(&self) {
        if let Ok(rd) = std::fs::read_dir(self.deck_dir.join("figs")) {
            let mut memo = self.fig_memo.lock_ok();
            for e in rd.filter_map(|e| e.ok()) {
                let name = e.file_name().to_string_lossy().to_string();
                if is_image(&name) {
                    if let Ok(b) = std::fs::read(e.path()) {
                        memo.insert(format!("figs/{name}"), self.history.pin_figure(&b));
                    }
                }
            }
        }
    }

    // --- 資料の中身 ---------------------------------------------------------------

    pub fn read_deck(&self) -> Result<(String, String), ApiError> {
        let mut st = self.state.lock_ok();
        let text =
            read_text_lossy(&self.deck_path).map_err(|e| ApiError::new(500, e.to_string()))?;
        let hash = sha1_hex(text.as_bytes());
        st.last_written = hash.clone();
        Ok((text, hash))
    }

    pub fn save_deck(&self, text: &str, base: &str, force: bool) -> Result<SaveOutcome, ApiError> {
        let mut st = self.state.lock_ok();
        let current =
            read_text_lossy(&self.deck_path).map_err(|e| ApiError::new(500, e.to_string()))?;
        let cur_hash = sha1_hex(current.as_bytes());
        if !base.is_empty() && !force && cur_hash != base && current != text {
            return Ok(SaveOutcome::Conflict {
                text: current,
                hash: cur_hash,
            });
        }
        let hash = sha1_hex(text.as_bytes());
        atomic_write(&self.deck_path, text.as_bytes()).map_err(|e| {
            ApiError::new(
                500,
                if e.raw_os_error() == Some(libc::ENOSPC) {
                    "ディスクの空きが足りません".into()
                } else {
                    e.to_string()
                },
            )
        })?;
        st.last_written = hash.clone();
        let restoring = std::mem::take(&mut st.restoring);
        drop(st);
        let (kind, label) = if restoring.is_empty() {
            ("save", "")
        } else {
            ("restore", restoring.as_str())
        };
        let _ = self.history.record(text, kind, label);
        Ok(SaveOutcome::Ok { hash })
    }

    pub fn title(&self) -> String {
        read_text_lossy(&self.deck_path)
            .map(|t| crate::slides::deck_title(&t))
            .unwrap_or_default()
    }

    // --- メモ（.agent-notes.json） -------------------------------------------------

    pub fn notes_get(&self) -> Value {
        std::fs::read_to_string(self.deck_dir.join(".agent-notes.json"))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_else(|| json!({ "notes": [], "draft": "", "scope": "slide" }))
    }

    pub fn notes_save(&self, data: &Value) -> Result<(), ApiError> {
        let notes: Vec<Value> = data
            .get("notes")
            .and_then(|n| n.as_array())
            .map(|a| a.iter().take(100).cloned().collect())
            .unwrap_or_default();
        let draft: String = data
            .get("draft")
            .and_then(|d| d.as_str())
            .unwrap_or("")
            .chars()
            .take(5000)
            .collect();
        let scope = data
            .get("scope")
            .and_then(|s| s.as_str())
            .unwrap_or("slide")
            .to_string();
        let f = self.deck_dir.join(".agent-notes.json");
        if notes.is_empty() && draft.is_empty() {
            let _ = std::fs::remove_file(&f);
            return Ok(());
        }
        let body = serde_json::to_string_pretty(
            &json!({ "notes": notes, "draft": draft, "scope": scope }),
        )
        .unwrap_or_default();
        atomic_write(&f, format!("{body}\n").as_bytes())
            .map_err(|e| ApiError::new(500, e.to_string()))
    }

    // --- 図と画像 ------------------------------------------------------------------

    pub fn upload(&self, name: &str, buf: &[u8]) -> Result<String, ApiError> {
        let raw = sanitize_name(if name.is_empty() { "image.png" } else { name });
        let lower = raw.to_lowercase();
        if !(lower.ends_with(".png")
            || lower.ends_with(".jpg")
            || lower.ends_with(".jpeg")
            || lower.ends_with(".gif")
            || lower.ends_with(".webp")
            || lower.ends_with(".svg"))
        {
            return Err(ApiError::new(400, "画像だけ保存できます"));
        }
        if buf.is_empty() || buf.len() > 30 << 20 {
            return Err(ApiError::new(400, "画像が空か、大きすぎます（30MBまで）"));
        }
        let _ = std::fs::create_dir_all(self.deck_dir.join("figs"));
        let stem = match raw.rfind('.') {
            Some(i) => &raw[..i],
            None => raw.as_str(),
        };
        let ext = &raw[stem.len()..];
        let mut rel = format!("figs/{stem}{ext}");
        let mut n = 2;
        while self.deck_dir.join(&rel).exists() {
            rel = format!("figs/{stem}-{n}{ext}");
            n += 1;
        }
        atomic_write(&self.deck_dir.join(&rel), buf)
            .map_err(|e| ApiError::new(500, e.to_string()))?;
        Ok(rel)
    }

    pub fn read_file(&self, rel: &str) -> Result<(String, bool), ApiError> {
        let f = inside(&self.deck_dir, rel)
            .ok_or_else(|| ApiError::new(403, "デッキの外は読めません"))?;
        let text = read_text_lossy(&f).map_err(|e| ApiError::new(404, e.to_string()))?;
        let drawio = f.with_extension("drawio").exists();
        Ok((text, drawio))
    }

    pub fn write_file(&self, rel: &str, body: &[u8]) -> Result<(), ApiError> {
        let f = inside(&self.deck_dir, rel)
            .ok_or_else(|| ApiError::new(403, "デッキ内のSVGだけ保存できます"))?;
        let is_svg = f
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase() == "svg")
            .unwrap_or(false);
        if !is_svg {
            return Err(ApiError::new(403, "デッキ内のSVGだけ保存できます"));
        }
        atomic_write(&f, body).map_err(|e| ApiError::new(500, e.to_string()))
    }

    pub fn new_figure(&self) -> Result<String, ApiError> {
        let _ = std::fs::create_dir_all(self.deck_dir.join("figs"));
        let mut n = 1;
        let rel;
        loop {
            let cand = format!("figs/new-figure-{n}.svg");
            n += 1;
            if !self.deck_dir.join(&cand).exists() {
                rel = cand;
                break;
            }
        }
        std::fs::write(self.deck_dir.join(&rel), placeholder(1160, 380))
            .map_err(|e| ApiError::new(500, e.to_string()))?;
        Ok(rel)
    }

    pub fn open_drawio(&self, rel: &str) -> Result<(), ApiError> {
        let f = inside(&self.deck_dir, rel)
            .ok_or_else(|| ApiError::new(404, ".drawio がありません"))?;
        let drawio = f.with_extension("drawio");
        if !drawio.exists() {
            return Err(ApiError::new(404, ".drawio がありません"));
        }
        let out = std::process::Command::new("/usr/bin/open")
            .arg("-a")
            .arg("draw.io")
            .arg(&drawio)
            .output()
            .map_err(|e| {
                ApiError::new(500, "draw.io を開けませんでした").with_detail(e.to_string())
            })?;
        drawio_open_result(out)
    }

    /// text の中の図（figs/…）を from の資料のフォルダから dest の figs/ へ写す。
    /// 同じ名前で中身が違う図があれば名前を変えて写し、text の参照も書き換える
    pub fn bring_figures(
        &self,
        text: &str,
        from: Option<&Path>,
        dest: &Path,
    ) -> Result<BringResult, ApiError> {
        let mut copied = Vec::new();
        let mut renamed: Vec<Renamed> = Vec::new();
        let src = from.map(|f| f.parent().unwrap_or(Path::new("")).to_path_buf());
        let dest_norm = normalize(dest);
        let src_norm = src.as_ref().map(|s| normalize(s));
        if src_norm.is_none() || src_norm.as_deref() == Some(dest_norm.as_path()) {
            return Ok(BringResult {
                text: text.to_string(),
                copied,
                renamed,
            });
        }
        let src_norm = src_norm.unwrap();
        let mut out = text.to_string();
        for rel in figure_refs(text) {
            let from1 = src_norm.join(&rel);
            let figs_dir = normalize(&src_norm.join("figs"));
            if !normalize(&from1).starts_with(&figs_dir) || !from1.exists() {
                continue;
            }
            let Ok(buf) = std::fs::read(&from1) else {
                continue;
            };
            let mut target = rel.clone();
            let mut to = dest_norm.join(&target);
            if to.exists() && std::fs::read(&to).map(|b| b != buf).unwrap_or(false) {
                let (stem, ext) = split_ext(&rel);
                let mut n = 2;
                loop {
                    let cand = format!("{stem}-{n}{ext}");
                    let p = dest_norm.join(&cand);
                    if !p.exists() || std::fs::read(&p).map(|b| b == buf).unwrap_or(false) {
                        target = cand;
                        to = p;
                        break;
                    }
                    n += 1;
                }
                out = out.replace(&rel, &target);
                renamed.push(Renamed {
                    from: rel.clone(),
                    to: target.clone(),
                });
            }
            if !to.exists() {
                if let Some(dir) = to.parent() {
                    let _ = std::fs::create_dir_all(dir);
                }
                std::fs::write(&to, &buf).map_err(|e| ApiError::new(500, e.to_string()))?;
                copied.push(target);
            }
        }
        Ok(BringResult {
            text: out,
            copied,
            renamed,
        })
    }

    /// 別の資料の最後（裏表紙があればその前）へページを足す。図も写す
    pub fn send_pages(
        &self,
        text: &str,
        target: &str,
    ) -> Result<(Vec<String>, Vec<Renamed>), ApiError> {
        let file = normalize(Path::new(target));
        let is_slides = file.file_name().map(|f| f == "slides.md").unwrap_or(false);
        let same = match (
            std::fs::canonicalize(&file),
            std::fs::canonicalize(&self.deck_path),
        ) {
            (Ok(a), Ok(b)) => a == b,
            _ => file == normalize(&self.deck_path),
        };
        if !is_slides || !file.exists() || same {
            return Err(ApiError::new(400, "送り先の資料が見つかりません"));
        }
        let dest = file.parent().map(|p| p.to_path_buf()).unwrap_or_default();
        let bring = self.bring_figures(text, Some(&self.deck_path), &dest)?;
        let body = bring.text.trim().to_string();
        let cur = read_text_lossy(&file).map_err(|e| ApiError::new(400, e.to_string()))?;
        // 最後の「\n---\n」を探す（Node 版と同じ）
        let seps: Vec<usize> = cur.match_indices("\n---\n").map(|(i, _)| i).collect();
        let last_start = seps.last().copied();
        let last_page = last_start
            .map(|i| cur[i + 5..].to_string())
            .unwrap_or_default();
        let next = match last_start {
            Some(i) if i > 0 && is_closing_page(&last_page) => {
                format!(
                    "{}\n\n---\n\n{body}\n\n---\n{}",
                    cur[..i].trim_end(),
                    last_page
                )
            }
            _ => format!("{}\n\n---\n\n{body}\n", cur.trim_end()),
        };
        let dest_history = History::open(&dest, "slides.md");
        let _ = dest_history.record(&cur, "save", "別の資料からページを受け取る前");
        atomic_write(&file, next.as_bytes()).map_err(|e| ApiError::new(500, e.to_string()))?;
        let name = self
            .deck_dir
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let _ = dest_history.record(
            &next,
            "external",
            &format!("「{name}」からページを受け取った"),
        );
        Ok((bring.copied, bring.renamed))
    }

    // --- 検査と書き出し（Node の CLI を呼ぶ） ------------------------------------------

    pub fn cancel_export(&self) {
        self.cancel_export
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }

    pub fn cancel_check(&self) {
        self.cancel_check
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }

    pub fn run_check(&self, text: &str) -> Result<Value, ApiError> {
        self.cancel_check
            .store(false, std::sync::atomic::Ordering::SeqCst);
        // 同時に2つ走ってもぶつからないよう、呼び出しごとに別の名前を使う
        let stem = format!(".editor-check-{}-{}", std::process::id(), now_ms());
        let tmp = self.deck_dir.join(format!("{stem}.md"));
        let out = std::env::temp_dir().join(format!("marp-check-{stem}"));
        let _ = std::fs::create_dir_all(&out);
        std::fs::write(&tmp, text).map_err(|e| ApiError::new(500, e.to_string()))?;
        let mut cmd = crate::hub::node_command();
        cmd.arg(self.root.join("marp/scripts/check.mjs"))
            .arg(&tmp)
            .arg("--no-shots")
            .arg("--json")
            .arg("--out")
            .arg(&out)
            .current_dir(&self.root);
        let res = crate::hub::run_with_cancel(
            cmd,
            std::time::Duration::from_secs(300),
            Some(self.cancel_check.clone()),
        );
        let _ = std::fs::remove_file(&tmp);
        let _ = std::fs::remove_file(self.deck_dir.join(format!(".render-{stem}.html")));
        let _ = std::fs::remove_dir_all(&out);
        let out = res.map_err(|e| ApiError::new(500, friendly_error(&e)))?;
        if out.cancelled {
            return Err(ApiError::new(500, "検査を中止しました"));
        }
        if out.timed_out {
            return Err(ApiError::new(
                500,
                "検査に時間がかかりすぎたので止めました（5分）。Chrome が固まっていないか確かめてください",
            ));
        }
        let stdout = String::from_utf8_lossy(&out.stdout).to_string();
        let last = stdout.trim().lines().last().unwrap_or("").to_string();
        if last.is_empty() {
            return Err(
                ApiError::new(500, friendly_error(&String::from_utf8_lossy(&out.stderr)))
                    .with_detail(tail(&String::from_utf8_lossy(&out.stderr), 20)),
            );
        }
        serde_json::from_str(&last)
            .map_err(|e| ApiError::new(500, e.to_string()).with_detail(tail(&stdout, 20)))
    }

    pub(crate) fn export_path(&self, fmt: &str) -> Option<PathBuf> {
        let (ext, suffix) = match fmt {
            "pdf" => ("pdf", ""),
            "pdf-chrome" => ("pdf", "-chrome"),
            "pdf-notes" => ("pdf", "-notes"),
            "pptx" => ("pptx", ""),
            "html" => ("html", ""),
            _ => return None,
        };
        let stem = self
            .deck_path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "slides".into());
        Some(
            self.deck_dir
                .join("dist")
                .join(format!("{stem}{suffix}.{ext}")),
        )
    }

    pub fn export_mime(fmt: &str) -> Option<&'static str> {
        match fmt {
            "pdf" | "pdf-notes" | "pdf-chrome" => Some("application/pdf"),
            "pptx" => {
                Some("application/vnd.openxmlformats-officedocument.presentationml.presentation")
            }
            "html" => Some("text/html; charset=utf-8"),
            _ => None,
        }
    }

    pub fn export_ext(fmt: &str) -> Option<&'static str> {
        match fmt {
            "pdf" | "pdf-notes" | "pdf-chrome" => Some("pdf"),
            "pptx" => Some("pptx"),
            "html" => Some("html"),
            _ => None,
        }
    }

    pub fn run_export(&self, fmt: &str) -> Result<Value, ApiError> {
        if fmt == "pdf-chrome" {
            return Err(ApiError::new(
                400,
                "Chrome の書き出しはアプリから選んでください",
            ));
        }
        self.cancel_export
            .store(false, std::sync::atomic::Ordering::SeqCst);
        let Some(path) = self.export_path(fmt) else {
            return Err(ApiError::new(400, "書き出せない形式です"));
        };
        let t0 = now_ms();
        let mut cmd = crate::hub::node_command();
        cmd.arg(self.root.join("marp/bin/slides.mjs"))
            .arg("build")
            .arg(&self.deck_path);
        match fmt {
            "pdf" => {
                cmd.arg("--pdf");
            }
            "pdf-notes" => {
                cmd.arg("--pdf").arg("--notes");
            }
            "pptx" => {
                cmd.arg("--pptx");
            }
            "html" => {
                cmd.arg("--html");
            }
            _ => {
                cmd.arg("--pdf");
            }
        }
        cmd.current_dir(&self.root);
        let out = crate::hub::run_with_cancel(
            cmd,
            std::time::Duration::from_secs(600),
            Some(self.cancel_export.clone()),
        )
        .map_err(|e| ApiError::new(500, friendly_error(&e)))?;
        if out.cancelled {
            return Err(ApiError::new(500, "書き出しを中止しました"));
        }
        if out.timed_out {
            return Err(ApiError::new(
                500,
                "書き出しに時間がかかりすぎたので止めました（10分）。Chrome が固まっていないか確かめてください",
            ));
        }
        if !out.status.success() {
            let se = String::from_utf8_lossy(&out.stderr);
            let msg = friendly_error(&se);
            return Err(ApiError::new(500, msg).with_detail(tail(&se, 60)));
        }
        let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        Ok(json!({
            "file": crate::http::display_path(&self.root, &path),
            "ms": now_ms() - t0,
            "size": size,
            "download": format!("/api/export-file?format={fmt}"),
        }))
    }

    pub fn export_file(&self, fmt: &str) -> Option<(PathBuf, String)> {
        let path = self.export_path(fmt)?;
        if !path.exists() {
            return None;
        }
        let stem = self.title();
        let stem = if stem.is_empty() {
            self.deck_dir
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default()
        } else {
            stem
        };
        let notes = if fmt == "pdf-notes" {
            "（発表者用）"
        } else {
            ""
        };
        let ext = Self::export_ext(fmt)?;
        let raw = format!("{stem}{notes}.{ext}");
        let name: String = raw
            .chars()
            .map(|c| if "\\/:*?\"<>|".contains(c) { '_' } else { c })
            .collect();
        Some((path, name))
    }

    // --- Git（この資料のフォルダ） ---------------------------------------------------

    pub fn repo_root(&self) -> Option<String> {
        G::repo_root(&self.deck_dir)
    }

    pub fn git_log(&self) -> Option<Value> {
        let root = self.repo_root()?;
        let root_path = PathBuf::from(&root);
        let dir = relative_posix(&root_path, &self.deck_dir);
        let log = G::log(&root_path, &dir, 100).ok()?;
        let changes = G::status(&root_path, &dir).map(|s| s.count).unwrap_or(0);
        Some(json!({ "log": log, "changes": changes }))
    }

    pub fn git_text(&self, rev: &str) -> Option<String> {
        let root = self.repo_root()?;
        let root_path = PathBuf::from(&root);
        let file = relative_posix(&root_path, &self.deck_path);
        G::show(&root_path, rev, &file).map(|b| String::from_utf8_lossy(&b).to_string())
    }

    // --- 知らせ（SSE） --------------------------------------------------------------

    pub fn subscribe(&self) -> std::sync::mpsc::Receiver<Event> {
        let (tx, rx) = channel();
        self.events.lock_ok().push(tx);
        rx
    }

    /// 閉じた（watch のループとサーバーを止める）
    pub fn stop(&self) {
        crate::native_export::cancel(self, false);
        crate::native_export::cancel(self, true);
        self.stopped
            .store(true, std::sync::atomic::Ordering::Relaxed);
    }

    pub fn is_stopped(&self) -> bool {
        self.stopped.load(std::sync::atomic::Ordering::Relaxed)
    }

    pub fn broadcast(&self, name: &str, data: Value) {
        let ev = Event {
            name: name.to_string(),
            data: data.to_string(),
        };
        {
            let mut list = self.events.lock_ok();
            list.retain(|tx| tx.send(ev.clone()).is_ok());
        }
        if let Some(sink) = self.sink.lock_ok().as_ref() {
            sink(name, &ev.data);
        }
    }

    /// Tauri のウインドウへ知らせる口を付ける（アプリの中で開いたとき）
    pub fn set_sink(&self, f: impl Fn(&str, &str) + Send + Sync + 'static) {
        *self.sink.lock_ok() = Some(Box::new(f));
    }

    pub fn mark_restoring(&self, label: &str) {
        self.state.lock_ok().restoring = label.chars().take(120).collect();
    }

    pub fn set_fig_label(&self, path: &str, label: &str) {
        *self.fig_label.lock_ok() = Some((path.to_string(), label.chars().take(120).collect()));
    }

    pub fn hub_url(&self) -> Option<String> {
        self.hub.clone()
    }

    // --- 外部の変更の監視（OS の通知で読み直す。通知が使えないときだけポーリング） -----

    pub fn watch(self: Arc<Self>) {
        let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(0);
        std::thread::spawn(move || {
            use notify::Watcher;
            let (tx, rx) = std::sync::mpsc::channel();
            let deck_path =
                std::fs::canonicalize(&self.deck_path).unwrap_or_else(|_| self.deck_path.clone());
            let figs_dir = std::fs::canonicalize(&self.deck_dir)
                .unwrap_or_else(|_| self.deck_dir.clone())
                .join("figs");
            let deck_dir = figs_dir.parent().map(Path::to_path_buf);
            let original_dir = self.deck_dir.clone();
            let mut watcher =
                notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                    if event
                        .map(|e| {
                            e.need_rescan()
                                || e.paths.iter().any(|p| {
                                    p == &deck_path
                                        || p.starts_with(&figs_dir)
                                        || Some(p) == deck_dir.as_ref()
                                        || p == &original_dir
                                        || p == &original_dir.join("slides.md")
                                        || p.starts_with(original_dir.join("figs"))
                                })
                        })
                        .unwrap_or(false)
                    {
                        let _ = tx.send(());
                    }
                })
                .ok();
            let watching = watcher.as_mut().is_some_and(|w| {
                w.watch(&self.deck_dir, notify::RecursiveMode::Recursive)
                    .is_ok()
            });
            let mut figs: HashMap<String, (u64, u64)> = scan_images(&self.deck_dir);
            let mut pending_at: Option<u128> = None;
            let mut deck_stamp = stamp(&self.deck_path);
            let mut ticks = 0u32;
            // 呼び出し元が編集を始める前に監視と比較元の取得を済ませる。
            let _ = ready_tx.send(());
            loop {
                let event = rx.recv_timeout(Duration::from_millis(400)).is_ok();
                if !event && watching && pending_at.is_none() && !self.is_stopped() {
                    continue;
                }
                if self.is_stopped() {
                    return;
                }
                // 大きさか時刻が変わったとき、または5秒ごとに中身のハッシュを見る
                // （毎回ハッシュを取ると CPU を使うため。review-P4-2 の should）
                let now_stamp = stamp(&self.deck_path);
                ticks += 1;
                let check_now = event || now_stamp != deck_stamp || ticks % 12 == 0;
                deck_stamp = now_stamp;
                if check_now {
                    let mut st = self.state.lock_ok();
                    if let Ok(text) = read_text_lossy(&self.deck_path) {
                        let h = sha1_hex(text.as_bytes());
                        let changed = st.last_written != h;
                        if changed {
                            st.last_written = h.clone();
                            self.broadcast("deck", json!({ "text": text, "hash": h }));
                            let _ =
                                self.history
                                    .record(&text, "external", "エディター以外での変更");
                        }
                    }
                }
                let now_figs = scan_images(&self.deck_dir);
                for (rel, meta) in now_figs.iter() {
                    if figs.get(rel) != Some(meta) {
                        self.broadcast("asset", json!({ "path": rel, "t": now_ms() }));
                        if rel.starts_with("figs/") {
                            let after = std::fs::read(self.deck_dir.join(rel)).ok();
                            self.fig_pending.lock_ok().insert(rel.clone(), Some(after));
                            pending_at = Some(now_ms());
                        }
                    }
                }
                // 消えた図も「変化」として記録する（Node 版と同じ。review-P4 の must 5）
                for rel in figs.keys() {
                    if !now_figs.contains_key(rel) && rel.starts_with("figs/") {
                        self.broadcast("asset", json!({ "path": rel, "t": now_ms() }));
                        self.fig_pending.lock_ok().insert(rel.clone(), Some(None));
                        pending_at = Some(now_ms());
                    }
                }
                figs = now_figs;
                // 何枚も作り直すときは、まとめて1つの版にする（Node 版は 1500ms 待つ）
                if let Some(at) = pending_at {
                    if now_ms().saturating_sub(at) > 1500 {
                        pending_at = None;
                        let pending: Vec<(String, Option<Option<Vec<u8>>>)> =
                            self.fig_pending.lock_ok().drain().collect();
                        // ラベルは、その図がこの回の変化に含まれるときだけ使う。
                        // 含まれていなければ捨てずに戻す（次にその図が変わったときに使う。must 5）
                        let next_label = self.fig_label.lock_ok().take();
                        let label = match next_label {
                            Some((path, l)) if pending.iter().any(|(rel, _)| rel == &path) => l,
                            Some(other) => {
                                *self.fig_label.lock_ok() = Some(other);
                                String::new()
                            }
                            None => String::new(),
                        };
                        let changes: Vec<FigureChangeBytes> = pending
                            .into_iter()
                            .filter_map(|(rel, after)| {
                                // 「触っていない」は記録しない。「消えた」は after: null として残す
                                let after = after?;
                                let before = self
                                    .fig_memo
                                    .lock_ok()
                                    .get(&rel)
                                    .and_then(|hash| self.history.object(hash).ok());
                                Some((rel, before, after))
                            })
                            .collect();
                        for (rel, _, after) in changes.iter() {
                            let mut memo = self.fig_memo.lock_ok();
                            match after {
                                Some(b) => memo.insert(rel.clone(), self.history.pin_figure(b)),
                                None => memo.remove(rel),
                            };
                        }
                        let _ = self.history.record_figures(changes, &label);
                    }
                }
            }
        });
        let _ = ready_rx.recv();
    }
}

fn is_image(name: &str) -> bool {
    let l = name.to_lowercase();
    [".svg", ".png", ".jpg", ".jpeg", ".webp", ".gif"]
        .iter()
        .any(|e| l.ends_with(e))
}

fn stamp(p: &Path) -> (u64, u64) {
    match std::fs::metadata(p) {
        Ok(m) => {
            let t = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            (t, m.len())
        }
        Err(_) => (0, 0),
    }
}

/// デッキのフォルダの中の画像（figs/ の下も見る）
fn scan_images(dir: &Path) -> HashMap<String, (u64, u64)> {
    let mut out = HashMap::new();
    collect_images(dir, dir, &mut out, 0);
    out
}

fn collect_images(base: &Path, dir: &Path, out: &mut HashMap<String, (u64, u64)>, depth: usize) {
    if depth > 3 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for e in rd.filter_map(|e| e.ok()) {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name == "dist" || name == "node_modules" {
            continue;
        }
        let p = e.path();
        if p.is_dir() {
            collect_images(base, &p, out, depth + 1);
        } else if is_image(&name) {
            if let Ok(rel) = p.strip_prefix(base) {
                out.insert(rel.to_string_lossy().replace('\\', "/"), stamp(&p));
            }
        }
    }
}

fn split_ext(rel: &str) -> (String, String) {
    match rel.rfind('.') {
        Some(i) => (rel[..i].to_string(), rel[i..].to_string()),
        None => (rel.to_string(), String::new()),
    }
}

/// text の中の `figs/…` の参照（重複なし。? や # の後ろは落とす）
pub fn figure_refs(text: &str) -> Vec<String> {
    // Node 版の /figs\/[^\s)"'<>\]]+/g と同じ。区切りは「空白・引用符・括弧」だけで、
    // `?` や `#` では終わらない（`figs/a.svg?v=1` も `figs/b.svg#figs/c.svg` も1つとして数え、
    // 最後に `[?#]` から後ろを落とす）。review-P4-2 の should
    let mut out: Vec<String> = Vec::new();
    let mut from = 0usize;
    while let Some(pos) = text[from..].find("figs/") {
        let start = from + pos;
        let mut end = text.len();
        for (off, c) in text[start..].char_indices() {
            if is_js_space(c) || ")\"'<>]".contains(c) {
                end = start + off;
                break;
            }
        }
        let raw = &text[start..end];
        let cut = raw.find(['?', '#']).unwrap_or(raw.len());
        let r = raw[..cut].to_string();
        if !out.contains(&r) {
            out.push(r);
        }
        from = end.max(start + 1);
        if from >= text.len() {
            break;
        }
    }
    out
}

/// JavaScript の `\s` と同じ扱い（Node 版と合わせるため。U+0085 は入らず、U+FEFF は入る）
pub fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

fn is_closing_page(page: &str) -> bool {
    // Node 版の /_class:\s*[^>]*\bclosing\b/ と同じ。
    // 複数行のコメントでも見つかり、「enclosing」のような語には当たらない（review-P4 の must 6・should）
    let target: Vec<char> = "closing".chars().collect();
    // JS の `\b` と同じで、語の字は ASCII だけ（`日本closing` や `éclosing` でも当たる）
    let word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    let mut at = 0;
    while let Some(pos) = page[at..].find("_class:") {
        let from = at + pos + "_class:".len();
        let rest: Vec<char> = page[from..].chars().collect();
        let mut i = 0;
        while i < rest.len() {
            if rest[i] == '>' {
                break; // コメントが閉じたら、そこから先は見ない
            }
            if i + target.len() <= rest.len() && rest[i..i + target.len()] == target[..] {
                let before_ok = i == 0 || !word(rest[i - 1]);
                let after_ok = i + target.len() == rest.len() || !word(rest[i + target.len()]);
                if before_ok && after_ok {
                    return true;
                }
            }
            i += 1;
        }
        at = from;
    }
    false
}

/// リポジトリからの相対パス（区切りは /。同じなら "."）
pub fn relative_posix(root: &Path, path: &Path) -> String {
    match path.strip_prefix(root) {
        Ok(r) if r.as_os_str().is_empty() => ".".into(),
        Ok(r) => r.to_string_lossy().replace('\\', "/"),
        Err(_) => path.to_string_lossy().replace('\\', "/"),
    }
}

/// 図の変更（前の中身・後の 中身）。watch の中で組み立てる
type FigureChangeBytes = (String, Option<Vec<u8>>, Option<Vec<u8>>);

/// Tauri のウインドウへ知らせる口（イベント名と JSON の文字列を渡す）
type EventSink = Box<dyn Fn(&str, &str) + Send + Sync>;

/// 一時ファイルを作らずに、テストから使える小さな道具
pub fn read_to_string(p: &Path) -> std::io::Result<String> {
    let mut s = String::new();
    std::fs::File::open(p)?.read_to_string(&mut s)?;
    Ok(s)
}

/// 資料のファイルを読む。UTF-8 として正しくない所は U+FFFD に置き換える
/// （Node の fsp.readFile(file, 'utf8') と同じ。review-P4 の must 4）
pub fn read_text_lossy(p: &Path) -> std::io::Result<String> {
    let buf = std::fs::read(p)?;
    Ok(String::from_utf8_lossy(&buf).to_string())
}

fn drawio_open_result(out: std::process::Output) -> Result<(), ApiError> {
    if !out.status.success() {
        return Err(ApiError::new(
            500,
            "draw.io を開けませんでした。アプリがインストールされているか確かめてください",
        )
        .with_detail(String::from_utf8_lossy(&out.stderr)));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_drawio_has_actionable_error_and_details() {
        let out = std::process::Command::new("/usr/bin/open")
            .args(["-a", "MarpKit-test-application-that-does-not-exist"])
            .output()
            .unwrap();
        let err = drawio_open_result(out).unwrap_err();
        assert!(err.message.contains("インストール"));
        assert!(!err.detail.unwrap().is_empty());
    }

    #[test]
    fn friendly_error_covers_browser_and_missing_file() {
        assert!(friendly_error(
            "No suitable browser found. Please ensure one of the following browsers is installed"
        )
        .contains("Chrome"));
        assert!(
            friendly_error("Error: No such file or directory (os error 2)").contains("ファイル")
        );
        assert_eq!(tail("a\nb\nc", 2), "b\nc");
    }

    #[test]
    fn finds_figure_references() {
        let text = "![h:380](figs/a.svg)\n![](figs/b.png?v=1)\n本文\n(figs/a.svg)\n";
        assert_eq!(
            figure_refs(text),
            vec!["figs/a.svg".to_string(), "figs/b.png".to_string()]
        );
        // `#` のあとに続けて書いても1つとして数える（Node 版と同じ。review-P4-2 の should）
        assert_eq!(
            figure_refs("![](figs/b.svg#figs/c.svg)\n"),
            vec!["figs/b.svg".to_string()]
        );
    }

    #[test]
    fn restore_figure_rel_stays_under_figs() {
        assert!(is_fig_rel("figs/a.svg"));
        assert!(is_fig_rel("figs/sub/a.svg"));
        assert!(!is_fig_rel("figs/../slides.md"));
        assert!(!is_fig_rel("figs/a/../../slides.md"));
        assert!(!is_fig_rel("slides.md"));
        assert!(!is_fig_rel("figs/"));
    }

    #[test]
    fn inside_blocks_the_outside() {
        let base = Path::new("/tmp/x/deck");
        assert!(inside(base, "figs/a.svg").is_some());
        assert!(inside(base, "../secret").is_none());
        assert!(inside(base, "/etc/passwd").is_none());
    }

    #[test]
    fn closing_page_is_detected() {
        assert!(is_closing_page(
            "\n<!-- _class: closing lead-1 -->\n\n# ありがとう\n"
        ));
        assert!(!is_closing_page("\n# ふつうのページ\n"));
        // 複数行のコメントでも見つかる（Node 版と同じ。review-P4 の must 6）
        assert!(is_closing_page(
            "\n<!--\n_class: closing\n-->\n\n# ありがとう\n"
        ));
        // enclosing のような語には当たらない（Node 版の \bclosing\b。should）
        assert!(!is_closing_page(
            "\n<!-- _class: lead enclosing-x -->\n\n# まだ続く\n"
        ));
        assert!(is_closing_page(
            "\n<!-- _class: lead enclosing-x -->\n<!-- _class: closing -->\n"
        ));
        // 語の境目は ASCII の語字だけ（Node の \b と同じ。review-P4-2 の should）
        assert!(is_closing_page("\n<!-- _class: 日本closing -->\n"));
        assert!(is_closing_page("\n<!-- _class: éclosing -->\n"));
    }

    #[test]
    fn finds_figure_references_with_japanese_names() {
        // 日本語の名前・全角空白でも落ちない（review-P4 の must 3）
        let text = "![](figs/全体像.svg)\n![](figs/だ.svg)\n![](figs/a.svg?v=1#x)\n本文 図はfigs/全体像.svg のとおり\n";
        assert_eq!(
            figure_refs(text),
            vec![
                "figs/全体像.svg".to_string(),
                "figs/だ.svg".to_string(),
                "figs/a.svg".to_string()
            ]
        );
        let zen = "![](figs/全体\u{3000}像.svg)\n";
        assert_eq!(figure_refs(zen), vec!["figs/全体".to_string()]);
    }

    #[test]
    fn reads_a_deck_that_is_not_utf8() {
        // UTF-8 として正しくない所は U+FFFD に置き換える（review-P4 の must 4）
        let dir = std::env::temp_dir().join(format!("marp-lossy-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("slides.md");
        std::fs::write(&file, b"# A\n\xff\xfe broken\n").unwrap();
        let text = read_text_lossy(&file).unwrap();
        assert!(text.starts_with("# A\n"), "先頭が読めていない: {text:?}");
        assert!(text.contains("\u{fffd}"), "置き換えられていない: {text:?}");
        assert!(text.contains("broken"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sends_pages_the_same_way_as_node() {
        use std::process::Command;
        let dir = std::env::temp_dir().join(format!("marp-send-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(
            dir.join("src/slides.md"),
            "# 送る資料\n\n---\n\n## 送るページ\n",
        )
        .unwrap();
        let body = "## 送ったページ\n";

        // Node 版と同じ文字の組み立て（server.mjs の send-pages から）
        // JS の正規表現は、Rust の文字列の中で実改行にならないよう \\n で渡す
        let js = concat!(
            "const fs = require('fs');\n",
            "const [file, body] = process.argv.slice(1);\n",
            "const cur = fs.readFileSync(file, 'utf8');\n",
            "const seps = [...cur.matchAll(/\\n---\\n/g)].map((m) => m.index);\n",
            "const lastStart = seps.length ? seps[seps.length - 1] : -1;\n",
            "const lastPage = lastStart >= 0 ? cur.slice(lastStart + 5) : '';\n",
            "let next;\n",
            "if (lastStart > 0 && /_class:\\s*[^>]*\\bclosing\\b/.test(lastPage)) next = `${cur.slice(0, lastStart).replace(/\\s*$/, '')}\\n\\n---\\n\\n${body.trim()}\\n\\n---\\n${lastPage}`;\n",
            "else next = `${cur.replace(/\\s*$/, '')}\\n\\n---\\n\\n${body.trim()}\\n`;\n",
            "process.stdout.write(next);\n",
        );
        let cases = [
            ("複数行のコメントの裏表紙", "# 送り先\n\n---\n\n# ふつう\n\n---\n\n<!--\n_class: closing\n-->\n\n# ありがとう\n"),
            ("enclosing は裏表紙ではない", "# 送り先\n\n---\n\n# ふつう\n\n---\n\n<!-- _class: lead enclosing-x -->\n\n# まだ続く\n"),
            ("普通の裏表紙", "# 送り先\n\n---\n\n<!-- _class: closing lead-1 -->\n\n# ありがとう\n"),
        ];
        for (i, (name, target_text)) in cases.iter().enumerate() {
            let dest = dir.join(format!("dest{i}"));
            std::fs::create_dir_all(&dest).unwrap();
            let target = dest.join("slides.md");
            std::fs::write(&target, target_text).unwrap();
            // Rust
            let deck = Deck::open(&dir.join("src"), &dir.join("src/slides.md"), None).unwrap();
            deck.send_pages(body, &target.to_string_lossy())
                .expect("送れなかった");
            let rust_out = std::fs::read_to_string(&target).unwrap();
            // Node（同じ組み立てを node で実行して比べる）
            std::fs::write(&target, target_text).unwrap();
            let out = Command::new(crate::hub::find_node().unwrap_or_else(|| "node".into()))
                .arg("-e")
                .arg(js)
                .arg(&target)
                .arg(body)
                .output()
                .expect("node を呼べない");
            let node_out = String::from_utf8_lossy(&out.stdout).to_string();
            assert!(
                out.status.success(),
                "{name}: node が失敗した: {}",
                String::from_utf8_lossy(&out.stderr)
            );
            assert_eq!(
                rust_out, node_out,
                "{name} で Node と結果が違う\nRust:\n{rust_out}\nNode:\n{node_out}"
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn records_a_deleted_figure_in_history() {
        let dir = std::env::temp_dir().join(format!("marp-figdel-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("figs")).unwrap();
        std::fs::write(dir.join("slides.md"), "# 資料\n\n![](figs/a.svg)\n").unwrap();
        std::fs::write(dir.join("figs/a.svg"), "<svg>a</svg>").unwrap();
        let deck = std::sync::Arc::new(Deck::open(&dir, &dir.join("slides.md"), None).unwrap());
        deck.clone().watch();
        // 監視の開始を待つ sleep は不要。返った直後の変更も拾う。
        // 外で図を消す
        std::fs::remove_file(dir.join("figs/a.svg")).unwrap();
        // OS の通知＋まとめ（1500ms）を待つ
        std::thread::sleep(std::time::Duration::from_millis(3000));
        let items = deck.history.list().expect("履歴が読めない");
        let deleted = items.iter().find(|e| {
            e.figures
                .as_ref()
                .map(|fs| {
                    fs.iter()
                        .any(|f| f.path == "figs/a.svg" && f.after.is_none())
                })
                .unwrap_or(false)
        });
        assert!(
            deleted.is_some(),
            "図を消した版が履歴にない: {:#?}",
            items
                .iter()
                .map(|e| (&e.kind, &e.label))
                .collect::<Vec<_>>()
        );
        deck.stop();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn labels_a_figure_that_was_restored() {
        // 図を戻したときのラベルが、その図の版に付く（review-P4 の must 5）
        let dir = std::env::temp_dir().join(format!("marp-figlabel-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("figs")).unwrap();
        std::fs::write(dir.join("slides.md"), "# 資料\n\n![](figs/a.svg)\n").unwrap();
        std::fs::write(dir.join("figs/a.svg"), "<svg>old</svg>").unwrap();
        let deck = std::sync::Arc::new(Deck::open(&dir, &dir.join("slides.md"), None).unwrap());
        deck.clone().watch();
        // 監視の開始を待つ sleep は不要。返った直後の変更も拾う。
        // 履歴に1つ版を作ってから、図を戻す（ラベル付き）
        let _ = deck
            .history
            .record("# 資料\n\n![](figs/a.svg)\n", "save", "はじめ");
        deck.set_fig_label("figs/a.svg", "figs/a.svg を戻した");
        std::fs::write(dir.join("figs/a.svg"), "<svg>new</svg>").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(3000));
        let items = deck.history.list().expect("履歴が読めない");
        let e = items
            .iter()
            .rev()
            .find(|e| e.kind == "figure")
            .expect("図の版がない");
        assert_eq!(
            e.label,
            "figs/a.svg を戻した",
            "ラベルが付いていない: {:#?}",
            items
                .iter()
                .map(|x| (&x.kind, &x.label))
                .collect::<Vec<_>>()
        );
        assert!(e
            .figures
            .as_ref()
            .map(|f| f
                .iter()
                .any(|x| x.path == "figs/a.svg" && x.after.is_some()))
            .unwrap_or(false));
        deck.stop();
        let _ = std::fs::remove_dir_all(&dir);
    }
    #[test]
    fn atomic_save_preserves_symlink_permissions_and_attributes() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let dir = std::env::temp_dir().join(format!("marp-atomic-{}", crate::hash::random_hex(12)));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("real.md");
        let link = dir.join("slides.md");
        std::fs::write(&file, "old").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o640)).unwrap();
        symlink(&file, &link).unwrap();
        #[cfg(target_os = "macos")]
        assert!(std::process::Command::new("/usr/bin/xattr")
            .args(["-w", "jp.jinno.test", "kept"])
            .arg(&file)
            .status()
            .unwrap()
            .success());
        atomic_write(&link, b"new").unwrap();
        assert!(std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "new");
        assert_eq!(
            std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o640
        );
        #[cfg(target_os = "macos")]
        assert_eq!(
            std::process::Command::new("/usr/bin/xattr")
                .args(["-p", "jp.jinno.test"])
                .arg(&file)
                .output()
                .unwrap()
                .stdout,
            b"kept\n"
        );
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 2);
        assert!(Deck::open(&dir, &dir.join("missing.md"), None).is_err());
        assert!(!dir.join(".editor-history").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
