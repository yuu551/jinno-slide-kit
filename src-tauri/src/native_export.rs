// 書き出し専用の隠した画面。操作できる資料と出力先は Rust が決める。
use crate::deck::{ApiError, Deck};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc, Mutex, OnceLock,
};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

enum Completed {
    Json(Value),
    Bytes(Vec<u8>),
}
struct Job {
    deck: Arc<Deck>,
    owner: String,
    format: String,
    text: String,
    cancel: Arc<AtomicBool>,
    sender: Mutex<Option<mpsc::Sender<Result<Completed, String>>>>,
    pages: Mutex<Vec<Vec<u8>>>,
}
static JOBS: OnceLock<Mutex<HashMap<String, Arc<Job>>>> = OnceLock::new();
fn jobs() -> &'static Mutex<HashMap<String, Arc<Job>>> {
    JOBS.get_or_init(Default::default)
}
pub fn busy() -> bool {
    jobs().lock().is_ok_and(|all| !all.is_empty())
}
pub fn cancel_all() {
    if let Ok(all) = jobs().lock() {
        for j in all.values() {
            j.cancel.store(true, Ordering::SeqCst);
        }
    }
}
fn job(label: &str) -> Result<Arc<Job>, String> {
    jobs()
        .lock()
        .map_err(|e| e.to_string())?
        .get(label)
        .cloned()
        .ok_or_else(|| "書き出しは既に終了しています".into())
}
pub fn deck_dir(label: &str) -> Option<PathBuf> {
    job(label).ok().map(|j| j.deck.deck_dir.clone())
}
pub fn cancel(deck: &Deck, check: bool) {
    if let Ok(jobs) = jobs().lock() {
        for j in jobs
            .values()
            .filter(|j| j.deck.deck_path == deck.deck_path && (j.format == "check") == check)
        {
            j.cancel.store(true, Ordering::SeqCst);
        }
    }
}
pub fn cancel_owner(owner: &str) {
    if let Ok(all) = jobs().lock() {
        for j in all.values().filter(|j| j.owner == owner) {
            j.cancel.store(true, Ordering::SeqCst);
        }
    }
}
fn complete(job: &Job, result: Result<Completed, String>) -> Result<(), String> {
    if let Some(sender) = job.sender.lock().map_err(|e| e.to_string())?.take() {
        let _ = sender.send(result);
    }
    Ok(())
}
struct Cleanup(AppHandle, String);
impl Drop for Cleanup {
    fn drop(&mut self) {
        if let Some(w) = self.0.get_webview_window(&self.1) {
            let _ = w.destroy();
        }
        if let Ok(mut all) = jobs().lock() {
            all.remove(&self.1);
        }
    }
}

pub async fn run(
    app: AppHandle,
    owner: String,
    deck: Arc<Deck>,
    format: String,
    text: String,
) -> Result<Value, ApiError> {
    run_to(app, owner, deck, format, text, None).await
}
pub fn chrome_available() -> bool {
    cfg!(debug_assertions) && crate::hub::find_chrome().is_some()
}

async fn run_to(
    app: AppHandle,
    owner: String,
    deck: Arc<Deck>,
    format: String,
    text: String,
    chosen: Option<PathBuf>,
) -> Result<Value, ApiError> {
    if !matches!(
        format.as_str(),
        "check" | "pdf" | "pdf-notes" | "pdf-chrome" | "pptx" | "html"
    ) {
        return Err(ApiError::new(400, "書き出しの種類が正しくありません"));
    }
    if format == "pdf-chrome" && !chrome_available() {
        return Err(ApiError::new(
            400,
            "この版ではChromeのPDFは使えません。PDFまたは発表者用PDFを選んでください",
        ));
    }
    let destination = if chosen.is_some() {
        chosen
    } else if format == "check" {
        None
    } else {
        let Some(path) = crate::export_destination::choose(app.clone(), &deck, &format).await?
        else {
            return Ok(json!({"ok":true,"cancelled":true}));
        };
        Some(path)
    };
    let started = crate::deck::now_ms();
    let label = format!("export-{}", crate::hash::random_hex(16));
    let (tx, rx) = mpsc::channel();
    let j = Arc::new(Job {
        deck: deck.clone(),
        owner,
        format: format.clone(),
        text,
        cancel: Arc::new(AtomicBool::new(false)),
        sender: Mutex::new(Some(tx)),
        pages: Mutex::new(Vec::new()),
    });
    jobs()
        .lock()
        .map_err(|e| ApiError::new(500, e.to_string()))?
        .insert(label.clone(), j.clone());
    let _cleanup = Cleanup(app.clone(), label.clone());
    let handle = app.clone();
    let window_label = label.clone();
    let pending = j.clone();
    app.run_on_main_thread(move || {
        let opened = (|| -> Result<(), String> {
            WebviewWindowBuilder::new(
                &handle,
                &window_label,
                WebviewUrl::External(
                    "marp://localhost/export/"
                        .parse::<tauri::Url>()
                        .map_err(|e| e.to_string())?,
                ),
            )
            .title("書き出し")
            .inner_size(1280.0, 720.0)
            .visible(false)
            .focused(false)
            .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
            .on_navigation(|url| {
                url.scheme() == "marp"
                    && url.host_str() == Some("localhost")
                    && url.path() == "/export/"
            })
            .build()
            .map_err(|e| e.to_string())?;
            Ok(())
        })();
        if let Err(e) = opened {
            let _ = complete(&pending, Err(e));
        }
    })
    .map_err(|e| {
        if let Ok(mut all) = jobs().lock() {
            all.remove(&label);
        }
        ApiError::new(500, e.to_string())
    })?;
    let waiting = j.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let deadline = std::time::Instant::now()
            + std::time::Duration::from_secs(if waiting.format == "check" { 300 } else { 600 });
        loop {
            if waiting.cancel.load(Ordering::SeqCst) {
                return Err("処理を中止しました".to_string());
            }
            if std::time::Instant::now() > deadline {
                return Err("処理に時間がかかりすぎたので止めました".to_string());
            }
            match rx.recv_timeout(std::time::Duration::from_millis(100)) {
                Ok(result) => return result,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err("書き出しの画面が閉じられました".to_string())
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
        }
    })
    .await;
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.destroy();
    }
    let result = result
        .map_err(|e| ApiError::new(500, e.to_string()))?
        .map_err(|e| {
            ApiError::new(
                500,
                if e.contains("中止") || e.contains("時間がかかり") {
                    e.clone()
                } else {
                    "書き出し・検査を完了できませんでした。詳しい内容を確認してください".into()
                },
            )
            .with_detail(e)
        })?;
    if format == "check" {
        return match result {
            Completed::Json(value) => Ok(value),
            _ => Err(ApiError::new(500, "検査の結果を読み取れません")),
        };
    }
    let bytes = match result {
        Completed::Bytes(bytes) => bytes,
        Completed::Json(metadata) if format.starts_with("pdf") => {
            if format == "pdf-chrome" {
                chrome_pdf(&deck, &metadata, j.cancel.clone())?
            } else {
                let pages = j
                    .pages
                    .lock()
                    .map_err(|e| ApiError::new(500, e.to_string()))?;
                let merged = crate::native_capture::merge_pdf_pages(&pages)
                    .map_err(|e| ApiError::new(500, e))?;
                crate::native_pdf::finish(&merged, &metadata, format == "pdf-notes")
                    .map_err(|e| ApiError::new(500, e))?
            }
        }
        _ => return Err(ApiError::new(500, "書き出しの結果を読み取れません")),
    };
    let destination =
        destination.ok_or_else(|| ApiError::new(400, "書き出し先を決められません"))?;
    if format == "html" {
        copy_figures(&deck, &destination)
            .map_err(|e| ApiError::new(500, &e).with_detail(e.clone()))?;
    }
    if let Some(dir) = destination.parent() {
        std::fs::create_dir_all(dir).map_err(|e| {
            ApiError::new(500, "書き出し先のフォルダを作れませんでした").with_detail(e.to_string())
        })?;
    }
    crate::deck::atomic_write(&destination, &bytes).map_err(|e| {
        ApiError::new(500, "書き出したファイルを保存できませんでした").with_detail(e.to_string())
    })?;
    crate::export_destination::remember(&deck, &format, &destination)
        .map_err(|e| ApiError::new(500, e))?;
    Ok(
        json!({"ok":true,"data":{"file":destination,"ms":crate::deck::now_ms()-started,"size":bytes.len(),"download":format!("/api/export-file?format={format}")}}),
    )
}

/// 配布版の検証。任意の JS は受け取らず、一時 HOME 内の資料だけを固定の手順で書き出す。
pub async fn verify(app: AppHandle, root: PathBuf, path: PathBuf) -> Result<Value, String> {
    let home = std::fs::canonicalize(std::env::var_os("HOME").ok_or("HOME がありません")?)
        .map_err(|e| e.to_string())?;
    let path = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
    if !(home.starts_with("/private/tmp") || home.starts_with("/tmp"))
        || !path.starts_with(home.join("lib"))
    {
        return Err("検証は一時 HOME の lib 内の資料だけに使えます".into());
    }
    let deck = Arc::new(Deck::open(&root, &path, None).map_err(|e| e.message)?);
    let text = deck.read_deck().map_err(|e| e.message)?.0;
    if !cfg!(debug_assertions) {
        if crate::app::node_status()["chrome"] != false {
            return Err("配布版でChromeの選択肢が有効です".into());
        }
        let blocked = run_to(
            app.clone(),
            "verification".into(),
            deck.clone(),
            "pdf-chrome".into(),
            text.clone(),
            deck.export_path("pdf-chrome"),
        )
        .await;
        if !matches!(blocked, Err(ref e) if e.status == 400 && e.message.contains("この版ではChrome"))
        {
            return Err("配布版でChromeの書き出しを拒否できません".into());
        }
        eprintln!("VERIFY chrome-disabled: true (status and export API)");
    }
    let mut output = serde_json::Map::new();
    for format in ["check", "html", "pdf", "pdf-notes", "pptx", "pdf-chrome"] {
        if format == "pdf-chrome" && !chrome_available() {
            continue;
        }
        let result = run_to(
            app.clone(),
            "verification".into(),
            deck.clone(),
            format.into(),
            text.clone(),
            deck.export_path(format),
        )
        .await
        .map_err(|e| format!("{format}: {}\n{}", e.message, e.detail.unwrap_or_default()))?;
        eprintln!("VERIFY {format}: {result}");
        output.insert(format.into(), result);
    }
    Ok(Value::Object(output))
}

fn chrome_pdf(deck: &Deck, payload: &Value, cancel: Arc<AtomicBool>) -> Result<Vec<u8>, ApiError> {
    let chrome = crate::hub::find_chrome().ok_or_else(|| {
        ApiError::new(
            400,
            "Chrome が見つかりません。PDF または発表者用PDFを選んでください",
        )
    })?;
    let dir = std::env::temp_dir().join(format!("marp-chrome-{}", crate::hash::random_hex(16)));
    struct Temp(PathBuf);
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let _temp = Temp(dir.clone());
    std::fs::create_dir(&dir).map_err(|e| ApiError::new(500, e.to_string()))?;
    let html = dir.join("slides.html");
    let pdf = dir.join("slides.pdf");
    copy_figures(deck, &html).map_err(|e| ApiError::new(500, e))?;
    std::fs::write(
        &html,
        payload["html"]
            .as_str()
            .ok_or_else(|| ApiError::new(500, "HTML がありません"))?,
    )
    .map_err(|e| ApiError::new(500, e.to_string()))?;
    let mut cmd = std::process::Command::new(chrome);
    cmd.arg("--headless")
        .arg("--no-pdf-header-footer")
        .arg("--disable-extensions")
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg("--virtual-time-budget=10000")
        .arg(format!("--user-data-dir={}", dir.join("profile").display()))
        .arg(format!("--print-to-pdf={}", pdf.display()))
        .arg(
            tauri::Url::from_file_path(&html)
                .map_err(|_| ApiError::new(500, "HTML の場所が正しくありません"))?
                .as_str(),
        );
    let out = crate::hub::run_with_cancel(cmd, std::time::Duration::from_secs(300), Some(cancel))
        .map_err(|e| ApiError::new(500, "Chrome を起動できませんでした").with_detail(e))?;
    if out.cancelled {
        return Err(ApiError::new(500, "書き出しを中止しました"));
    }
    if out.timed_out {
        return Err(ApiError::new(
            500,
            "書き出しに時間がかかりすぎたので止めました",
        ));
    }
    if !out.status.success() {
        return Err(ApiError::new(500, "Chrome で書き出せませんでした")
            .with_detail(String::from_utf8_lossy(&out.stderr)));
    }
    let bytes = std::fs::read(pdf).map_err(|e| ApiError::new(500, e.to_string()))?;
    crate::native_pdf::finish_chrome(&bytes, &payload["metadata"])
        .map_err(|e| ApiError::new(500, e))
}

fn copy_figures(deck: &Deck, destination: &std::path::Path) -> Result<(), String> {
    copy_figure_tree(&deck.deck_dir, destination)
}

fn copy_figure_tree(root: &std::path::Path, destination: &std::path::Path) -> Result<(), String> {
    use std::io::Write;
    const CONFLICT: &str = "同じ名前で中身の違う画像があります。空のフォルダを選んでください";
    let source = root.join("figs");
    if !source.exists() {
        return Ok(());
    }
    let out = destination.parent().ok_or("出力先がありません")?;
    let resolved = crate::deck::resolved_parent(destination).ok_or("出力先を確認できません")?;
    let source_real = source.canonicalize().map_err(|e| e.to_string())?;
    if resolved.starts_with(&source_real) {
        return Err(
            "資料の画像フォルダの中には書き出せません。空のフォルダを選んでください".into(),
        );
    }
    fn plan(
        root: &std::path::Path,
        relative: &std::path::Path,
        out: &std::path::Path,
        files: &mut Vec<(PathBuf, PathBuf)>,
    ) -> Result<(), String> {
        let src = crate::deck::inside(root, &relative.to_string_lossy())
            .ok_or("資料の外の画像は書き出せません")?;
        let meta = std::fs::symlink_metadata(&src).map_err(|e| e.to_string())?;
        if meta.file_type().is_symlink() {
            return Err("画像フォルダのシンボリックリンクは書き出せません".into());
        }
        let dest = crate::deck::inside(out, &relative.to_string_lossy())
            .ok_or("書き出し先の外に画像を置けません")?;
        let existing = match std::fs::symlink_metadata(&dest) {
            Ok(m) => Some(m),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e.to_string()),
        };
        if existing
            .as_ref()
            .is_some_and(|m| m.file_type().is_symlink() || m.is_dir() != meta.is_dir())
        {
            return Err(CONFLICT.into());
        }
        if meta.is_dir() {
            for entry in std::fs::read_dir(src).map_err(|e| e.to_string())? {
                plan(
                    root,
                    &relative.join(entry.map_err(|e| e.to_string())?.file_name()),
                    out,
                    files,
                )?;
            }
        } else if meta.is_file() {
            if existing.is_some() {
                if std::fs::read(&src).map_err(|e| e.to_string())?
                    != std::fs::read(&dest).map_err(|e| e.to_string())?
                {
                    return Err(CONFLICT.into());
                }
            } else {
                files.push((src, dest));
            }
        }
        Ok(())
    }
    // 一つでも衝突があれば、既存の図にも新しい図にも書き込まない。
    let mut files = Vec::new();
    plan(root, std::path::Path::new("figs"), out, &mut files)?;
    for (src, dest) in files {
        let bytes = std::fs::read(src).map_err(|e| e.to_string())?;
        std::fs::create_dir_all(dest.parent().ok_or("画像の保存先がありません")?)
            .map_err(|e| e.to_string())?;
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&dest)
        {
            Ok(mut file) => file.write_all(&bytes).map_err(|e| e.to_string())?,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                if std::fs::read(&dest).map_err(|e| e.to_string())? != bytes {
                    return Err(CONFLICT.into());
                }
            }
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn native_job(
    window: WebviewWindow,
    name: String,
    args: Option<Value>,
) -> Result<Value, String> {
    let j = job(window.label())?;
    let args = args.unwrap_or(json!({}));
    if j.cancel.load(Ordering::SeqCst) {
        return Err("処理を中止しました".into());
    }
    match name.as_str() {
        "input" => {
            let mut figures: Vec<_> = std::fs::read_dir(j.deck.deck_dir.join("figs"))
                .into_iter()
                .flatten()
                .filter_map(|e| e.ok())
                .filter(|e| e.path().is_file())
                .map(|e| format!("figs/{}", e.file_name().to_string_lossy()))
                .collect();
            figures.sort();
            Ok(
                json!({"debug":cfg!(debug_assertions),"text":j.text,"format":j.format,"themes":crate::http::themes_json(&j.deck.root),"figures":figures}),
            )
        }
        #[cfg(debug_assertions)]
        "trace" => {
            if let Ok(dir) = std::env::var("MARP_EXPORT_TRACE") {
                let dir = PathBuf::from(dir);
                if !dir.starts_with("/tmp") && !dir.starts_with("/private/tmp") {
                    return Err("検証の出力は一時フォルダだけです".into());
                }
                std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                let dir = std::fs::canonicalize(dir).map_err(|e| e.to_string())?;
                if !dir.starts_with("/tmp") && !dir.starts_with("/private/tmp") {
                    return Err("検証の出力は一時フォルダだけです".into());
                }
                std::fs::write(
                    dir.join(format!("{}.json", j.format)),
                    serde_json::to_vec(&args).map_err(|e| e.to_string())?,
                )
                .map_err(|e| e.to_string())?;
            }
            Ok(json!({}))
        }
        "progress" => {
            let _ = window
                .app_handle()
                .emit_to(&j.owner, "export-progress", &args);
            Ok(json!({}))
        }
        "pdfPage" => {
            let rect: [f64; 4] =
                serde_json::from_value(args.get("rect").cloned().ok_or("範囲がありません")?)
                    .map_err(|e| e.to_string())?;
            let bytes = crate::native_capture::capture(window, rect, false).await?;
            j.pages.lock().map_err(|e| e.to_string())?.push(bytes);
            Ok(json!({}))
        }
        "finish" => {
            complete(&j, Ok(Completed::Json(args)))?;
            Ok(json!({}))
        }
        "error" => {
            complete(
                &j,
                Err(args
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("書き出しに失敗しました")
                    .to_string()),
            )?;
            Ok(json!({}))
        }
        _ => Err("この書き出し操作は使えません".into()),
    }
}
#[tauri::command]
pub async fn native_snapshot(
    window: WebviewWindow,
    rect: [f64; 4],
) -> Result<tauri::ipc::Response, String> {
    let _ = job(window.label())?;
    Ok(tauri::ipc::Response::new(
        crate::native_capture::capture(window, rect, true).await?,
    ))
}
#[tauri::command]
pub fn native_job_bytes(
    window: WebviewWindow,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let j = job(window.label())?;
    if !matches!(j.format.as_str(), "html" | "pptx") {
        return Err("この形式ではバイナリーを受け取れません".into());
    }
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("書き出しデータが正しくありません".into());
    };
    if bytes.len() > 256 * 1024 * 1024 {
        return Err("書き出しデータが大きすぎます".into());
    }
    complete(&j, Ok(Completed::Bytes(bytes.clone())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    fn copy_tree(src: &Path, dst: &Path) {
        std::fs::create_dir_all(dst).unwrap();
        for e in std::fs::read_dir(src).unwrap() {
            let e = e.unwrap();
            if e.file_type().unwrap().is_dir() {
                copy_tree(&e.path(), &dst.join(e.file_name()));
            } else {
                std::fs::copy(e.path(), dst.join(e.file_name())).unwrap();
            }
        }
    }
    fn snapshot(dir: &Path) -> std::collections::BTreeMap<PathBuf, Vec<u8>> {
        fn collect(
            base: &Path,
            dir: &Path,
            all: &mut std::collections::BTreeMap<PathBuf, Vec<u8>>,
        ) {
            for e in std::fs::read_dir(dir).unwrap() {
                let e = e.unwrap();
                if e.file_type().unwrap().is_dir() {
                    collect(base, &e.path(), all);
                } else {
                    all.insert(
                        e.path().strip_prefix(base).unwrap().to_path_buf(),
                        std::fs::read(e.path()).unwrap(),
                    );
                }
            }
        }
        let mut all = std::collections::BTreeMap::new();
        collect(dir, dir, &mut all);
        all
    }
    #[test]
    fn html_export_never_changes_another_decks_figures() {
        let tmp = std::env::temp_dir().join(format!(
            "marp-figure-conflict-{}",
            crate::hash::random_hex(12)
        ));
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("../marp/templates/talk");
        let a = tmp.join("a");
        let b = tmp.join("b");
        copy_tree(&fixture, &a);
        copy_tree(&fixture, &b);
        std::fs::create_dir_all(b.join("figs/src")).unwrap();
        std::fs::write(b.join("figs/src/make_figs.py"), b"new script").unwrap();
        std::fs::write(b.join("figs/reading.svg"), b"different diagram").unwrap();
        std::fs::write(b.join("figs/new-review-only.svg"), b"new diagram").unwrap();
        let before = snapshot(&a);
        let error = copy_figure_tree(&b, &a.join("B.html")).unwrap_err();
        assert!(error.contains("空のフォルダ"));
        assert_eq!(snapshot(&a), before);
        assert!(!a.join("figs/new-review-only.svg").exists());
        assert!(copy_figure_tree(&b, &b.join("figs/nested/B.html")).is_err());
        assert!(!b.join("figs/nested").exists());
        let target = tmp.join("empty/B.html");
        copy_figure_tree(&b, &target).unwrap();
        assert_eq!(snapshot(&b.join("figs")), snapshot(&tmp.join("empty/figs")));
        let before = snapshot(&tmp.join("empty"));
        copy_figure_tree(&b, &target).unwrap();
        assert_eq!(snapshot(&tmp.join("empty")), before);
        std::fs::remove_dir_all(tmp).unwrap();
    }
}
