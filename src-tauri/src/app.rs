// アプリの中のウインドウと Tauri のコマンド。
// 画面（エディター・発表・発表者・プレビュー）は、アプリの中の画面のサーバー（http.rs）から配る。
// API は invoke でここを通る（HTTP の互換層と同じ処理を api.rs が行う）。
use crate::api;
use crate::deck::{ApiError, Deck};
use crate::http::{self, Context};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, Window};

type Windows = Arc<Mutex<Vec<String>>>;

#[derive(Default)]
pub struct AppState {
    /// 資料ごとの画面のサーバー（同じ資料を2つのウインドウで開いても1つ）
    decks: Mutex<HashMap<String, DeckServer>>,
    opening: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    /// ウインドウ → 資料の場所
    windows: Mutex<HashMap<String, String>>,
    /// Marp キットのフォルダ（ライブラリーの API で使う）
    pub kit: Mutex<Option<PathBuf>>,
    /// ライブラリーの画面のサーバーのポート
    pub hub_port: Mutex<Option<u16>>,
    /// 閉じる確認を出しているウインドウ（二重に出さない）
    closing: Mutex<std::collections::HashSet<String>>,
    /// 画面が close-requested を受け取れるようになったウインドウ
    close_guard_ready: Mutex<std::collections::HashSet<String>>,
    /// ⌘Q で終了の途中か（D01）
    quitting: std::sync::atomic::AtomicBool,
}

struct DeckServer {
    port: u16,
    deck: Arc<Deck>,
    ctx: Arc<Context>,
    windows: Windows,
}

fn err_json(e: ApiError) -> String {
    json!({ "status": e.status, "error": e.message, "detail": e.detail }).to_string()
}

impl AppState {
    pub fn deck_of(&self, label: &str) -> Option<String> {
        self.windows.lock().ok()?.get(label).cloned()
    }
    fn server(&self, deck_path: &str) -> Option<(u16, Arc<Deck>, Arc<Context>, Windows)> {
        let d = self.decks.lock().ok()?;
        let s = d.get(deck_path)?;
        Some((s.port, s.deck.clone(), s.ctx.clone(), s.windows.clone()))
    }
    pub(crate) fn context_for(&self, label: &str) -> Option<Arc<Context>> {
        self.server(&self.deck_of(label)?).map(|(_, _, ctx, _)| ctx)
    }
    pub fn begin_quit(&self) -> bool {
        !self
            .quitting
            .swap(true, std::sync::atomic::Ordering::SeqCst)
    }
    pub fn cancel_quit(&self) {
        self.quitting
            .store(false, std::sync::atomic::Ordering::SeqCst);
    }
    /// アプリを終える前に、走っている書き出し・検査へ中止を伝える（E03）
    pub fn cancel_running(&self) -> bool {
        let any = self.decks.lock().map(|d| !d.is_empty()).unwrap_or(false);
        if let Ok(decks) = self.decks.lock() {
            for d in decks.values() {
                d.deck.cancel_export();
                d.deck.cancel_check();
            }
        }
        any
    }

    pub fn quitting(&self) -> bool {
        self.quitting.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// 閉じる確認を出してよいか（同じウインドウで二重に出さない）
    pub fn begin_close(&self, label: &str) -> bool {
        self.closing
            .lock()
            .map(|mut s| s.insert(label.to_string()))
            .unwrap_or(false)
    }
    pub fn end_close(&self, label: &str) {
        if let Ok(mut s) = self.closing.lock() {
            s.remove(label);
        }
    }
    /// 閉じる確認の返事を待っているウインドウがあるか
    pub fn has_pending_close(&self) -> bool {
        self.close_guard_ready
            .lock()
            .map(|s| !s.is_empty())
            .unwrap_or(false)
            || self.closing.lock().map(|s| !s.is_empty()).unwrap_or(false)
    }

    pub fn mark_close_guard(&self, label: &str) {
        if let Ok(mut s) = self.close_guard_ready.lock() {
            s.insert(label.to_string());
        }
    }
    pub fn close_guard_ready(&self, label: &str) -> bool {
        self.close_guard_ready
            .lock()
            .map(|s| s.contains(label))
            .unwrap_or(false)
    }
    pub fn clear_close_guard(&self, label: &str) {
        if let Ok(mut s) = self.close_guard_ready.lock() {
            s.remove(label);
        }
    }

    pub fn close_window(&self, label: &str) {
        self.end_close(label);
        self.clear_close_guard(label);
        let closed = self.windows.lock().ok().and_then(|mut w| w.remove(label));
        if let Some(deck) = closed {
            // 同じ資料のウインドウ（発表画面・発表者画面・プレビュー）が残っていれば、一覧からは外さない
            let still_open = self
                .windows
                .lock()
                .map(|w| w.values().any(|p| p == &deck))
                .unwrap_or(false);
            // ⌘Q の途中は、次回の起動で開き直せるよう一覧に残す（D01）
            if !still_open {
                if !self.quitting() {
                    forget_open_deck(&deck);
                }
                if let Some(server) = self
                    .decks
                    .lock()
                    .ok()
                    .and_then(|mut decks| decks.remove(&deck))
                {
                    server.deck.stop();
                }
                if let Ok(mut opening) = self.opening.lock() {
                    opening.remove(&deck);
                }
            }
        }
        if let Ok(mut d) = self.decks.lock() {
            for s in d.values_mut() {
                s.windows.lock().map(|mut v| v.retain(|l| l != label)).ok();
            }
        }
    }
}

/// 資料の場所を絶対パスにそろえる（`~…` と絶対パスで別のウインドウにならないように）
fn abs_deck_path(deck_path: &str) -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let expanded = if let Some(rest) = deck_path.strip_prefix("~/") {
        format!("{home}/{rest}")
    } else {
        deck_path.to_string()
    };
    std::fs::canonicalize(&expanded)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or(expanded)
}

/// 画面のサーバーを（無ければ）立ち上げて、資料の場所を返す
fn ensure_server(
    app: &AppHandle,
    deck_path: &str,
) -> Result<(u16, Arc<Deck>, Arc<Context>, Windows), String> {
    let state = app.state::<AppState>();
    let gate = state
        .opening
        .lock()
        .map_err(|e| e.to_string())?
        .entry(deck_path.to_string())
        .or_default()
        .clone();
    let _opening = gate.lock().map_err(|e| e.to_string())?;
    if let Some(s) = state.server(deck_path) {
        return Ok(s);
    }
    let root = crate::hub::find_root()?;
    let path = expand(deck_path);
    if !path.exists() {
        return Err(format!("資料が見つかりません: {}", path.display()));
    }
    crate::document_gate::validate(&path)?;
    let bundle_dir = root.join(".check/rust-bundle");
    // 「← 一覧」の行き先は、アプリの中で配っているライブラリーの画面
    let hub = app
        .state::<AppState>()
        .hub_port
        .lock()
        .ok()
        .and_then(|p| *p)
        .map(|_| "marp://localhost/hub/".to_string());
    http::ensure_bundle(&root, &bundle_dir)?;
    crate::deck::read_text_lossy(&path).map_err(|e| format!("資料を読めません: {e}"))?;
    let deck = Arc::new(Deck::open(&root, &path, hub.clone()).map_err(err_json)?);
    deck.clone().watch();
    let ctx = Arc::new(Context {
        deck: deck.clone(),
        root: root.clone(),
        bundle_dir,
        hub: http::HubProbe::new(hub),
    });
    let windows: Windows = Arc::new(Mutex::new(Vec::new()));
    {
        let deck = deck.clone();
        let app2 = app.clone();
        let list = windows.clone();
        deck.set_sink(move |name, data| {
            if let Ok(ls) = list.lock() {
                for label in ls.iter() {
                    let _ = app2.emit_to(label.as_str(), name, data);
                }
            }
        });
    }
    state.decks.lock().map_err(|e| e.to_string())?.insert(
        deck_path.to_string(),
        DeckServer {
            port: 0,
            deck: deck.clone(),
            ctx: ctx.clone(),
            windows: windows.clone(),
        },
    );
    Ok((0, deck, ctx, windows))
}

fn expand(p: &str) -> PathBuf {
    let s = if let Some(rest) = p.strip_prefix("~/") {
        format!("{}/{rest}", std::env::var("HOME").unwrap_or_default())
    } else {
        p.to_string()
    };
    let path = PathBuf::from(&s);
    if path.is_absolute() {
        path
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    }
}

fn register_window(app: &AppHandle, label: &str, deck_path: &str, windows: &Windows) {
    if let Ok(mut w) = app.state::<AppState>().windows.lock() {
        w.insert(label.to_string(), deck_path.to_string());
    }
    if let Ok(mut l) = windows.lock() {
        if !l.iter().any(|x| x == label) {
            l.push(label.to_string());
        }
    }
}

/// 同じ名前のウインドウがあれば見せて、URL を移す。無ければ作る
fn open_or_focus(
    app: &AppHandle,
    label: &str,
    url: &str,
    title: &str,
    size: (f64, f64),
) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(label) {
        if label == "library" {
            let _ = w.unminimize();
            let _ = w.set_focus();
            return Ok(());
        }
        let _ = w.eval(format!(
            "location.href = {}",
            serde_json::to_string(url).unwrap_or_else(|_| "\"/\"".into())
        ));
        let _ = w.set_focus();
        return Ok(());
    }
    let parsed: tauri::Url = url.parse().map_err(|e| format!("URL が読めません: {e}"))?;
    crate::window_geometry::prepare(label);
    let window = WebviewWindowBuilder::new(app, label, WebviewUrl::External(parsed))
        .title(title)
        .on_document_title_changed(|window, title| {
            let dirty = title.starts_with("● ");
            let _ = window.set_title(title.trim_start_matches("● "));
            #[cfg(target_os = "macos")]
            if let Ok(ptr) = window.ns_window() {
                unsafe {
                    let native = &*(ptr as *const objc2_app_kit::NSWindow);
                    native.setDocumentEdited(dirty);
                }
            }
        })
        .inner_size(size.0, size.1)
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
        // 外の URL へは移らない（リンクはブラウザで開く想定。S01）
        .on_navigation(is_own_url)
        .build()
        .map_err(|e| e.to_string())?;
    if label == "library" {
        let _ = window.set_min_size(Some(tauri::LogicalSize::new(900.0, 600.0)));
    }
    crate::window_geometry::restore(&window.as_ref().window());
    Ok(())
}

/// アプリ自身の画面（ローカルの HTTP）か。外の URL へは移らない（S01）
pub(crate) fn is_own_url(u: &tauri::Url) -> bool {
    u.scheme() == "marp"
        && u.host_str() == Some("localhost")
        && matches!(
            u.path(),
            "/hub/"
                | "/editor/"
                | "/editor/present"
                | "/editor/presenter"
                | "/editor/preview"
                | "/svgedit/marpkit-host.html"
        )
}

fn url_for(port: u16, path: &str) -> String {
    if port == 0 {
        format!("marp://localhost/editor{path}")
    } else {
        format!("http://127.0.0.1:{port}{path}")
    }
}

/// 画面から呼ぶ API（invoke）
#[tauri::command]
pub async fn api_call(
    window: Window,
    state: tauri::State<'_, AppState>,
    name: String,
    args: Option<Value>,
) -> Result<Value, String> {
    let label = window.label().to_string();
    if !label.starts_with("editor-")
        && !matches!(name.as_str(), "info" | "deckGet" | "notesGet" | "readFile")
    {
        return Err("この画面では変更できません".into());
    }
    let Some(deck_path) = state.deck_of(&label) else {
        return Err(
            json!({ "status": 404, "error": "このウインドウの資料が分かりません" }).to_string(),
        );
    };
    let Some((_, deck, ctx, _)) = state.server(&deck_path) else {
        return Err(
            json!({ "status": 404, "error": "資料のサーバーが動いていません" }).to_string(),
        );
    };
    // 検査・書き出し・gitは時間がかかるので、別のスレッドで動かす
    // （その間もほかのウインドウが動けるように。review-P4-2 の should）
    let args = args.unwrap_or(json!({}));
    if name == "revealExport" || name == "openExport" {
        return crate::export_destination::open(
            &deck,
            args["format"].as_str().unwrap_or("pdf"),
            name == "revealExport",
        )
        .map_err(err_json);
    }
    if name == "info" {
        let mut value = api::call(&deck, Some(&ctx), &name, &args).map_err(err_json)?;
        value["exports"] = json!(["pdf", "pdf-notes", "pdf-chrome", "pptx", "html"]
            .into_iter()
            .filter(|f| crate::export_destination::previous(&deck, f).is_some()
                || deck.export_file(f).is_some())
            .collect::<Vec<_>>());
        if !deck.root.join("marp/bin/slides.mjs").is_file() {
            value["slides"] = Value::Null;
        }
        return Ok(value);
    }
    if name == "cancelExport" || name == "cancelCheck" {
        crate::native_export::cancel(&deck, name == "cancelCheck");
    }
    if name == "exportDeck" || name == "checkAll" {
        let format = if name == "checkAll" {
            "check".to_string()
        } else {
            args.get("format")
                .and_then(Value::as_str)
                .unwrap_or("pdf")
                .to_string()
        };
        let text = if name == "checkAll" {
            args.get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
        } else {
            deck.read_deck().map_err(err_json)?.0
        };
        return crate::native_export::run(window.app_handle().clone(), label, deck, format, text)
            .await
            .map_err(err_json);
    }
    tauri::async_runtime::spawn_blocking(move || api::call(&deck, Some(&ctx), &name, &args))
        .await
        .map_err(|e| e.to_string())?
        .map_err(err_json)
}

/// 大きな画像は JSON の数値配列にせず、そのままの bytes で受け取る。
#[tauri::command]
pub async fn upload_image(
    window: Window,
    request: tauri::ipc::Request<'_>,
) -> Result<Value, String> {
    let state = window.state::<AppState>();
    let ctx = state
        .context_for(window.label())
        .ok_or("資料がありません")?;
    if !window.label().starts_with("editor-") {
        return Err("この画面では変更できません".into());
    }
    let name = request
        .headers()
        .get("x-marpkit-name")
        .and_then(|v| v.to_str().ok())
        .map(crate::http::percent_decode)
        .unwrap_or_else(|| "image.png".into());
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("画像の形式が正しくありません".into());
    };
    if bytes.len() > 32 * 1024 * 1024 {
        return Err("画像は32MBまでです".into());
    }
    let bytes = bytes.clone();
    tauri::async_runtime::spawn_blocking(move || {
        ctx.deck
            .upload(&name, &bytes)
            .map(|path| json!({ "ok": true, "path": path }))
            .map_err(err_json)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// ウインドウの名前に使える形にする。
/// Tauri は `.` `(` `+` `&` などを受け付けないので、英数字とハイフンだけにして、
/// 同じ名前の資料（別のライブラリー・_archive/ の下）でもぶつからないよう、場所の番号を付ける
fn window_label(prefix: &str, deck_path: &str) -> String {
    let slug: String = std::path::Path::new(deck_path)
        .parent()
        .and_then(|p| p.file_name())
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_else(|| "deck".into());
    let safe: String = slug
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let safe = safe.trim_matches('-').to_string();
    let safe = if safe.is_empty() {
        "deck".to_string()
    } else {
        safe.chars().take(40).collect()
    };
    // 同じ名前でも場所が違えば別のウインドウにする
    let full =
        std::fs::canonicalize(deck_path).unwrap_or_else(|_| std::path::PathBuf::from(deck_path));
    let short = crate::deck::sha1_for_label(full.to_string_lossy().as_bytes());
    format!("{prefix}-{safe}-{}", &short[..6])
}

/// 資料をエディターのウインドウで開く（ライブラリーから呼ぶ。別の process のサーバーは立てない）
#[tauri::command]
pub async fn open_editor(
    app: AppHandle,
    deck_path: String,
    view: Option<String>,
    page: Option<u32>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || open_editor_sync(app, deck_path, view, page))
        .await
        .map_err(|e| e.to_string())?
}

/// 画面の外（起動時の復元・ファイルを開く）から呼ぶ、その場で終わる版
pub fn open_editor_sync(
    app: AppHandle,
    deck_path: String,
    view: Option<String>,
    page: Option<u32>,
) -> Result<Value, String> {
    let deck_path = abs_deck_path(&deck_path);
    let (port, deck, _, windows) = ensure_server(&app, &deck_path)?;
    let slug = deck
        .deck_dir
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "deck".into());
    let label = window_label("editor", &deck_path);
    let query = match view.as_deref() {
        Some("split") => "?view=split",
        _ => "",
    };
    let hash = page.map(|p| format!("#{p}")).unwrap_or_default();
    let url = url_for(port, &format!("/{query}{hash}"));
    let title = deck.title();
    let title = if title.is_empty() {
        format!("{slug} — Marpエディター")
    } else {
        format!("{title} — Marpエディター")
    };
    // ウインドウの確認と作成を主スレッドの1回の処理にまとめる。
    // サーバーの準備は完了済みで、Mutex を持ったまま build しない。
    let (tx, rx) = std::sync::mpsc::channel();
    let app_ui = app.clone();
    let label_ui = label.clone();
    let path_ui = deck_path.clone();
    let url_ui = url.clone();
    app.run_on_main_thread(move || {
        let result = (|| {
            if let Some(w) = app_ui.get_webview_window(&label_ui) {
                let _ = w.unminimize();
                let _ = w.set_focus();
                if let Some(p) = page {
                    let _ = w.eval(format!(
                        "window.__marpkit && window.__marpkit.go({})",
                        p.saturating_sub(1)
                    ));
                }
                if view.as_deref() == Some("split") {
                    let _ = w.eval("window.__marpkit && window.__marpkit.toggleSource(true)");
                }
            } else {
                register_window(&app_ui, &label_ui, &path_ui, &windows);
                open_or_focus(&app_ui, &label_ui, &url_ui, &title, (1440.0, 900.0))?;
                if let Some(w) = app_ui.get_webview_window(&label_ui) {
                    let _ = w.set_min_size(Some(tauri::Size::Logical(tauri::LogicalSize::new(
                        1024.0, 640.0,
                    ))));
                }
            }
            crate::menus::remember(&app_ui, &path_ui);
            Ok::<(), String>(())
        })();
        let _ = tx.send(result);
    })
    .map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())??;

    remember_open_deck(&deck_path);
    Ok(json!({ "url": url, "label": label }))
}

/// 資料を閉じる（名前の変更・アーカイブのときに呼ぶ。Node 版の stopEditor と同じ）
/// 画面の save() が終わったことを待つための合図（D10）
static SAVE_WAIT: std::sync::OnceLock<
    Mutex<std::collections::HashMap<String, std::sync::mpsc::Sender<bool>>>,
> = std::sync::OnceLock::new();

#[tauri::command]
pub fn deck_saved(label: String, ok: bool) {
    if let Some(tx) = SAVE_WAIT
        .get_or_init(Default::default)
        .lock()
        .ok()
        .and_then(|mut m| m.remove(&label))
    {
        let _ = tx.send(ok);
    }
}

pub fn close_deck_windows(app: &AppHandle, deck_path: &str) -> bool {
    let deck_path = &abs_deck_path(deck_path);
    let labels: Vec<String> = {
        let state = app.state::<AppState>();
        state
            .windows
            .lock()
            .map(|w| {
                w.iter()
                    .filter(|(_, p)| p.as_str() == deck_path)
                    .map(|(l, _)| l.clone())
                    .collect()
            })
            .unwrap_or_default()
    };
    let mut saved = true;
    for label in labels.iter() {
        if let Some(w) = app.get_webview_window(label) {
            let (tx, rx) = std::sync::mpsc::channel();
            if let Ok(mut m) = SAVE_WAIT.get_or_init(Default::default).lock() {
                m.insert(label.clone(), tx);
            }
            let l = serde_json::to_string(label).unwrap_or_else(|_| "\"\"".into());
            let js = format!(
                "(() => {{ const inv = (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) || (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke); const done = (ok) => inv && inv('deck_saved', {{ label: {l}, ok: !!ok }}); const ed = window.__marpkit; const fig = (typeof window.__figureSave === 'function') ? window.__figureSave() : true; Promise.resolve(fig).then((f) => (f === false ? false : (ed && ed.save ? ed.save() : true))).then((ok) => done(ok === true), () => done(false)); }})()"
            );
            let _ = w.eval(&js);
            // 保存の返事を待つ。返事が無ければ、閉じずに失敗として返す（D10）
            if !matches!(rx.recv_timeout(std::time::Duration::from_secs(8)), Ok(true)) {
                saved = false;
                if let Ok(mut m) = SAVE_WAIT.get_or_init(Default::default).lock() {
                    m.remove(label);
                }
            }
        }
    }
    if !saved {
        return false;
    }
    for label in labels {
        if let Some(w) = app.get_webview_window(&label) {
            let _ = w.close();
        }
    }
    // 資料のサーバーと監視も止めて、覚えを外す（次に開いたときは新しい場所で立て直す）
    let state = app.state::<AppState>();
    let removed = state
        .decks
        .lock()
        .map(|mut d| d.remove(deck_path))
        .unwrap_or(None);
    if let Some(server) = removed {
        server.deck.stop();
        // 待ち受けているスレッドを起こす（ブロッキングの accept なので、自分に1本つなぐ）
        let _ = std::net::TcpStream::connect_timeout(
            &std::net::SocketAddr::from(([127, 0, 0, 1], server.port)),
            std::time::Duration::from_millis(300),
        );
    }
    true
}

/// 資料の場所が変わったとき（名前の変更・アーカイブ）に、開いているウインドウを閉じる
#[tauri::command]
pub async fn close_deck(app: AppHandle, deck_path: String) -> Result<Value, String> {
    // 画面に保存を頼んで待つあいだ、ほかのウインドウを止めないよう別のスレッドで行う
    let saved = tauri::async_runtime::spawn_blocking(move || close_deck_windows(&app, &deck_path))
        .await
        .map_err(|e| e.to_string())?;
    if !saved {
        return Err("保存できなかったため、名前の変更・アーカイブをやめました".into());
    }
    Ok(json!({ "ok": true }))
}

/// smoke 用：読み直しの直後に閉じる要求を出す（デバッグのビルドだけ）
#[tauri::command]
pub fn debug_reload_and_close(window: tauri::WebviewWindow) {
    if cfg!(debug_assertions) {
        let _ = window.eval("location.reload()");
        let _ = window.close();
    }
}

/// smoke 用：ウインドウのラベル一覧（デバッグのビルドだけ）
#[tauri::command]
pub fn debug_window_labels(app: AppHandle) -> Vec<String> {
    if !cfg!(debug_assertions) {
        return Vec::new();
    }
    app.webview_windows().keys().cloned().collect()
}

/// smoke 用：いまのウインドウの大きさ（デバッグのビルドだけ）
#[tauri::command]
pub fn debug_inner_size(window: Window) -> serde_json::Value {
    if !cfg!(debug_assertions) {
        return json!({ "width": 0, "height": 0 });
    }
    window
        .inner_size()
        .map(|s| {
            json!({ "width": s.width, "height": s.height,
                "fullscreen": presentation_is_fullscreen(&window).ok(),
                "position": window.outer_position().ok(),
                "monitor": window.current_monitor().ok().flatten(),
                "monitors": window.available_monitors().ok(),
            })
        })
        .unwrap_or(json!({ "width": 0, "height": 0 }))
}

/// smoke から ⌘Q と同じ流れを試す（デバッグのビルドだけ）
#[tauri::command]
pub fn debug_quit(app: AppHandle) {
    if cfg!(debug_assertions) {
        crate::quit_app(&app);
    }
}

/// ライブラリーの画面をアプリの中で開く（ハブの URL をそのまま使う）
#[tauri::command]
pub fn open_library(app: AppHandle, url: String) -> Result<Value, String> {
    let _ = url; // 互換の引数。呼び出し元にかかわらず同梱の画面だけを開く。
    let url = "marp://localhost/hub/";
    open_or_focus(&app, "library", url, "Marp キット", (1440.0, 900.0))?;
    Ok(json!({ "url": url }))
}

/// 資料のウインドウを開く共通の処理（発表・発表者・プレビュー）
fn open_deck_window(
    app: &AppHandle,
    deck_path: &str,
    kind: &str,
    page: Option<u32>,
) -> Result<(), String> {
    let deck_path = &abs_deck_path(deck_path);
    let (port, _deck, _, windows) = ensure_server(app, deck_path)?;
    let (path, label, title, size) = match kind {
        "present" => (
            format!(
                "/present{}",
                page.map(|p| format!("#{p}")).unwrap_or_default()
            ),
            window_label("present", deck_path),
            "発表".to_string(),
            (1280.0, 760.0),
        ),
        "presenter" => (
            format!(
                "/presenter{}",
                page.map(|p| format!("#{p}")).unwrap_or_default()
            ),
            window_label("presenter", deck_path),
            "発表者".to_string(),
            (1440.0, 900.0),
        ),
        _ => (
            "/preview".to_string(),
            window_label("preview", deck_path),
            "プレビュー".to_string(),
            (1280.0, 760.0),
        ),
    };
    let url = url_for(port, &path);
    open_or_focus(app, &label, &url, &title, size)?;
    register_window(app, &label, deck_path, &windows);
    position_presentation(app, deck_path, &label, kind)?;
    Ok(())
}

fn position_presentation(
    app: &AppHandle,
    deck_path: &str,
    label: &str,
    kind: &str,
) -> Result<(), String> {
    if !matches!(kind, "present" | "presenter") {
        return Ok(());
    }
    let w = app
        .get_webview_window(label)
        .ok_or("発表のウインドウがありません")?;
    let monitors = w.available_monitors().map_err(|e| e.to_string())?;
    let local = app
        .get_webview_window(&window_label("editor", deck_path))
        .and_then(|editor| editor.current_monitor().ok().flatten())
        .or_else(|| w.primary_monitor().ok().flatten());
    let target = if kind == "present" {
        monitors
            .iter()
            .find(|m| local.as_ref().is_some_and(|l| m.position() != l.position()))
            .or(local.as_ref())
            .or(monitors.first())
    } else {
        local.as_ref().or(monitors.first())
    };
    if let Some(monitor) = target {
        if kind == "present" {
            if monitors.is_empty() {
                // macOS が一覧を返さなくても、現在の画面では全画面にできる。
                w.set_simple_fullscreen(true).map_err(|e| e.to_string())?;
            } else {
                w.set_fullscreen_on_monitor(tauri::PhysicalPosition::new(
                    f64::from(monitor.position().x),
                    f64::from(monitor.position().y),
                ))
                .map_err(|e| e.to_string())?;
            }
        } else {
            let area = monitor.work_area();
            w.set_size(tauri::PhysicalSize::new(
                area.size
                    .width
                    .min((1440.0 * monitor.scale_factor()) as u32),
                area.size
                    .height
                    .min((900.0 * monitor.scale_factor()) as u32),
            ))
            .map_err(|e| e.to_string())?;
            w.set_position(area.position).map_err(|e| e.to_string())?;
            if monitors.len() == 1 {
                if let Some(audience) = app.get_webview_window(&window_label("present", deck_path))
                {
                    audience.set_focus().map_err(|e| e.to_string())?;
                }
            }
        }
    } else if kind == "present" {
        w.set_fullscreen(true).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn presentation_is_fullscreen(window: &Window) -> Result<bool, String> {
    if window.is_fullscreen().map_err(|e| e.to_string())? {
        return Ok(true);
    }
    // simple fullscreen は Tauri の is_fullscreen に含まれない。実際の枠と画面を照合する。
    use objc2_app_kit::{NSWindow, NSWindowStyleMask};
    let _mtm = objc2::MainThreadMarker::new().ok_or("主スレッドで確認してください")?;
    let ptr = window.ns_window().map_err(|e| e.to_string())?;
    let native = unsafe { &*ptr.cast::<NSWindow>() };
    Ok(!native.styleMask().contains(NSWindowStyleMask::Titled)
        && native
            .screen()
            .is_some_and(|screen| native.frame() == screen.frame()))
}

/// 自分の発表ウインドウだけを操作する。WebKit の DOM 全画面 API に依存しない。
#[tauri::command]
pub fn presentation_fullscreen(
    window: Window,
    active: Option<bool>,
    toggle: Option<bool>,
) -> Result<bool, String> {
    if !window.label().starts_with("present-") && !window.label().starts_with("presenter-") {
        return Err("発表画面から操作してください".into());
    }
    let current = presentation_is_fullscreen(&window)?;
    let next = active.or_else(|| toggle.filter(|v| *v).map(|_| !current));
    if let Some(value) = next {
        if window
            .available_monitors()
            .map_err(|e| e.to_string())?
            .is_empty()
        {
            window
                .set_simple_fullscreen(value)
                .map_err(|e| e.to_string())?;
        } else {
            window.set_fullscreen(value).map_err(|e| e.to_string())?;
        }
        Ok(value)
    } else {
        Ok(current)
    }
}

async fn prepare_deck_window(
    app: AppHandle,
    deck_path: String,
    kind: &'static str,
    page: Option<u32>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || open_deck_window(&app, &deck_path, kind, page))
        .await
        .map_err(|e| e.to_string())?
}

/// 発表画面を開く（エディターの画面から）
#[tauri::command]
pub async fn open_present(app: AppHandle, window: Window, page: Option<u32>) -> Result<(), String> {
    let deck_path = deck_of_window(&window)?;
    prepare_deck_window(app, deck_path, "present", page).await
}

/// 発表者画面を開く（エディターの画面から。発表画面の S キーからも呼ばれる）
#[tauri::command]
pub async fn open_presenter(
    app: AppHandle,
    window: Window,
    page: Option<u32>,
) -> Result<(), String> {
    let deck_path = deck_of_window(&window)?;
    prepare_deck_window(app, deck_path, "presenter", page).await
}

/// 読むだけのプレビューを開く
#[tauri::command]
pub async fn open_preview(app: AppHandle, window: Window) -> Result<(), String> {
    let deck_path = deck_of_window(&window)?;
    prepare_deck_window(app, deck_path, "preview", None).await
}

/// ライブラリーから、資料を指定して発表画面を開く
#[tauri::command]
pub async fn open_present_for(
    app: AppHandle,
    deck_path: String,
    page: Option<u32>,
) -> Result<Value, String> {
    prepare_deck_window(app, deck_path, "present", page).await?;
    Ok(json!({ "ok": true }))
}

/// 書き出したファイルを、そのためのウインドウで開く（ライブラリーのウインドウは使わない）
#[tauri::command]
pub fn open_file_window(
    app: AppHandle,
    url: String,
    label: String,
    title: String,
) -> Result<Value, String> {
    open_or_focus(&app, &label, &url, &title, (1100.0, 800.0))?;
    Ok(json!({ "ok": true }))
}

/// そのウインドウが開いている資料の場所
fn deck_of_window(window: &Window) -> Result<String, String> {
    let state = window.state::<AppState>();
    state
        .deck_of(window.label())
        .ok_or_else(|| "このウインドウの資料が分かりません".to_string())
}

/// ウインドウを閉じる（画面から）
#[tauri::command]
pub fn close_window(_app: AppHandle, window: Window) {
    // 実際の後片付けは Destroyed で行う。ここで先に消すと、閉じる確認をキャンセルしたときに
    // ウインドウと資料の結び付きが失われる（D01）
    let _ = window.close();
}

/// 閉じる確認で「閉じる」が選ばれたとき（CloseRequested を通さずに閉じる）
#[tauri::command]
pub fn close_window_now(app: AppHandle, window: Window) {
    let state = app.state::<AppState>();
    state.close_window(window.label());
    let _ = window.destroy();
}

/// 閉じる確認で「キャンセル」が選ばれたとき
#[tauri::command]
pub fn close_window_cancel(app: AppHandle, window: Window) {
    let state = app.state::<AppState>();
    state.end_close(window.label());
    state.cancel_quit();
    #[cfg(target_os = "macos")]
    crate::native_shutdown::reply(&app, false);
}

/// 画面が close-requested の受け手を用意できたことを知らせる
#[tauri::command]
pub fn close_guard_ready(window: Window) {
    window.state::<AppState>().mark_close_guard(window.label());
}

/// 動作を確かめるとき用：画面から送られた文字を標準出力に出す（SMOKE: で始まる行）
/// 画面からパスを入力させず、macOS のフォルダ選択を使う。
#[tauri::command]
pub async fn pick_library_folder(
    app: AppHandle,
    window: Window,
    purpose: String,
) -> Result<Option<String>, String> {
    if window.label() != "library" {
        return Err("ライブラリーから選んでください".into());
    }
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || {
        let title = if purpose == "library" {
            "ライブラリーのフォルダを選ぶ"
        } else {
            "取り込む資料のフォルダを選ぶ"
        };
        let mut picker = app.dialog().file().set_title(title);
        if let Some(lib) = crate::library::load_config().first() {
            picker = picker.set_directory(&lib.path);
        }
        picker
            .blocking_pick_folder()
            .map(|p| {
                p.into_path()
                    .map(|p| p.to_string_lossy().to_string())
                    .map_err(|e| e.to_string())
            })
            .transpose()
    })
    .await
    .map_err(|e| e.to_string())?
}

/// ライブラリーの API（invoke）
#[tauri::command]
pub async fn hub_call(
    app: AppHandle,
    window: Window,
    state: tauri::State<'_, AppState>,
    name: String,
    args: Option<Value>,
) -> Result<Value, String> {
    if window.label() != "library" {
        return Err("ライブラリーの画面から操作してください".into());
    }
    // 中断はファイルの読み取りや待機列を通さず、受け付けた順に反映する。
    if name == "cancelPdf" {
        crate::native_export::cancel_owner("library");
        crate::hub_api::cancel_pdf().store(true, std::sync::atomic::Ordering::SeqCst);
        return Ok(json!({ "ok": true }));
    }
    if name == "pdf" {
        crate::hub_api::cancel_pdf().store(false, std::sync::atomic::Ordering::SeqCst);
    }
    let args = args.unwrap_or(json!({}));
    if name == "git"
        && matches!(
            args.get("op").and_then(Value::as_str),
            Some("push" | "remote")
        )
    {
        use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
        let detail = if args["op"] == "push" {
            "記録をリモートへ送信しますか？".to_string()
        } else {
            format!(
                "同期先を変更しますか？\n{}",
                args.get("url").and_then(Value::as_str).unwrap_or("")
            )
        };
        let confirm_app = app.clone();
        let accepted = tauri::async_runtime::spawn_blocking(move || {
            confirm_app
                .dialog()
                .message(detail)
                .title("同期の確認")
                .buttons(MessageDialogButtons::OkCancelCustom(
                    "続ける".into(),
                    "キャンセル".into(),
                ))
                .blocking_show()
        })
        .await
        .map_err(|e| e.to_string())?;
        if !accepted {
            return Err("キャンセルしました".into());
        }
    }
    let kit = state.kit.lock().map_err(|e| e.to_string())?.clone();
    let Some(kit) = kit else {
        return Err(
            json!({ "status": 500, "error": "Marp キットのフォルダが見つかりません" }).to_string(),
        );
    };
    if matches!(name.as_str(), "pdf" | "openExport" | "revealExport") {
        let dir = crate::hub_api::export_deck_dir(&args).map_err(err_json)?;
        let deck = std::sync::Arc::new(
            crate::deck::Deck::open(&kit, &dir.join("slides.md"), None).map_err(err_json)?,
        );
        if name != "pdf" {
            return crate::export_destination::open(&deck, "pdf", name == "revealExport")
                .map_err(err_json);
        }
        let text = deck.read_deck().map_err(err_json)?.0;
        return crate::native_export::run(app, "library".into(), deck, "pdf".into(), text)
            .await
            .map_err(err_json);
    }
    tauri::async_runtime::spawn_blocking(move || crate::hub_api::call(&kit, &name, &args))
        .await
        .map_err(|e| e.to_string())?
        .map_err(err_json)
}

/// ライブラリーの画面の場所（アプリの中で配っている URL）
#[tauri::command]
pub fn hub_url(state: tauri::State<AppState>) -> Value {
    let port = state.hub_port.lock().ok().and_then(|p| *p);
    json!({ "url": port.map(|_| "marp://localhost/hub/") })
}

/// 動作を確かめるとき用：画面から送られた文字を標準出力に出す（SMOKE: で始まる行）
#[tauri::command]
pub fn log_report(msg: String) {
    // リリースのビルドでは何もしない
    #[cfg(debug_assertions)]
    println!("SMOKE: {msg}");
    #[cfg(not(debug_assertions))]
    let _ = msg;
}

/// MARP_SMOKE_DIR で流した JS の結果を受け取り、<名前>.out.json に書く（デバッグのビルドだけ）。
#[tauri::command]
pub fn smoke_report(
    name: String,
    ok: bool,
    result: Option<Value>,
    error: Option<String>,
) -> Result<(), String> {
    #[cfg(not(debug_assertions))]
    {
        let _ = (name, ok, result, error);
        return Err("この版では使えません".to_string());
    }
    #[cfg(debug_assertions)]
    {
        let dir = std::env::var("MARP_SMOKE_DIR")
            .map_err(|_| "MARP_SMOKE_DIR がありません".to_string())?;
        // 名前はファイル名だけにする（画面から渡される値をそのままパスに使わない）
        let safe = Path::new(&name)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "smoke".into());
        let path = Path::new(&dir).join(format!("{safe}.out.json"));
        let body = json!({
            "name": safe,
            "ok": ok,
            "result": result.unwrap_or(Value::Null),
            "error": error,
            "at": std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0),
        });
        std::fs::write(&path, body.to_string()).map_err(|e| e.to_string())
    }
}

/// Finder で見せる
#[tauri::command]
pub fn reveal_path(path: String) -> Result<(), String> {
    let p = expand(&path);
    std::process::Command::new("open")
        .arg("-R")
        .arg(&p)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Node と Chrome があるか（検査と書き出しの前に見る）
#[tauri::command]
pub fn node_status() -> Value {
    json!({"native":true,"chrome":crate::native_export::chrome_available(),"message":""})
}

/// 実際の WKWebView で測った結果を受け取る（parity の追試。MARP_PARITY_OUT に書いて終わる）
#[tauri::command]
pub fn parity_report(app: AppHandle, json: String) -> Result<(), String> {
    // 動作を確かめるとき用。リリースのビルドでは受け取らない
    #[cfg(not(debug_assertions))]
    {
        let _ = (&app, json);
        return Err("この版では使えません".to_string());
    }
    #[cfg(debug_assertions)]
    {
        if let Ok(out) = std::env::var("MARP_PARITY_OUT") {
            std::fs::write(&out, &json).map_err(|e| e.to_string())?;
        }
        app.exit(0);
        Ok(())
    }
}

/// 画面のサーバーの場所（ログ用）
pub fn port_of(state: &AppState, deck_path: &str) -> Option<u16> {
    state.server(deck_path).map(|(p, _, _, _)| p)
}

/// デッキのフォルダの名前（ウインドウの名前に使う）
pub fn deck_slug(deck_path: &Path) -> String {
    deck_path
        .parent()
        .and_then(|p| p.file_name())
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "deck".into())
}

// --- メニュー・前回のウインドウ ---

fn windows_file() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home).join(".config/jinno-marp/app-windows.json")
}

/// いま開いている資料の場所を覚えておく（次に開いたときに戻す）
pub fn remember_open_deck(deck_path: &str) {
    let abs = abs_deck_path(deck_path);
    let mut decks = last_open_decks();
    if !decks.iter().any(|d| d == &abs) {
        decks.push(abs);
        write_open_decks(&decks);
    }
}

/// 閉じた資料は一覧から外す（開き直せなかった資料は残す）
pub fn forget_open_deck(deck_path: &str) {
    let abs = abs_deck_path(deck_path);
    let mut decks = last_open_decks();
    let before = decks.len();
    decks.retain(|d| d != &abs);
    if decks.len() != before {
        write_open_decks(&decks);
    }
}

/// 前回開いていた資料の場所（`~` を広げて返す）
pub fn last_open_decks() -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(windows_file()) else {
        return Vec::new();
    };
    let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    let list: Vec<String> = v
        .get("decks")
        .and_then(|d| d.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(abs_deck_path))
                .collect()
        })
        .unwrap_or_default();
    // 同じ資料を2つ覚えない（`~…` と絶対パス、`/tmp` と `/private/tmp` など）
    let mut seen = std::collections::HashSet::new();
    list.into_iter()
        .filter(|d| seen.insert(d.clone()))
        .collect()
}

fn write_open_decks(decks: &[String]) {
    let file = windows_file();
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let body = serde_json::to_string_pretty(&json!({ "decks": decks })).unwrap_or_default();
    let _ = std::fs::write(file, format!("{body}\n"));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closing_a_presenter_window_keeps_the_deck_remembered() {
        // 発表者画面を閉じただけで、開いているエディターの資料を一覧から消さない（review-P4-2 の must 3）
        let dir = std::env::temp_dir().join(format!("marp-remember-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".config/jinno-marp")).unwrap();
        let old_home = std::env::var("HOME").ok();
        std::env::set_var("HOME", &dir);

        let deck = dir.join("lib/deck-a/slides.md");
        std::fs::create_dir_all(deck.parent().unwrap()).unwrap();
        std::fs::write(&deck, "# 資料\n").unwrap();
        // 覚えるときは絶対パス（/tmp は /private/tmp に直る）なので、同じ形にして比べる
        let path = abs_deck_path(&deck.to_string_lossy());

        let state = AppState::default();
        remember_open_deck(&path);
        {
            let mut w = state.windows.lock().unwrap();
            w.insert("editor-deck-a".into(), path.clone());
            w.insert("presenter-deck-a".into(), path.clone());
        }
        let deck_state = Arc::new(Deck::open(&dir, &deck, None).unwrap());
        let windows = Arc::new(Mutex::new(vec![
            "editor-deck-a".into(),
            "presenter-deck-a".into(),
        ]));
        let ctx = Arc::new(Context {
            deck: deck_state.clone(),
            root: dir.clone(),
            bundle_dir: dir.clone(),
            hub: http::HubProbe::new(None),
        });
        state.decks.lock().unwrap().insert(
            path.clone(),
            DeckServer {
                port: 0,
                deck: deck_state.clone(),
                ctx,
                windows,
            },
        );
        state.close_window("presenter-deck-a");
        assert!(!deck_state.is_stopped());
        assert!(state.server(&path).is_some());
        assert!(
            last_open_decks().iter().any(|d| d == &path),
            "発表者画面を閉じただけで一覧から消えた"
        );
        state.close_window("editor-deck-a");
        assert!(deck_state.is_stopped());
        assert!(state.server(&path).is_none());
        assert!(
            last_open_decks().is_empty(),
            "エディターも閉じたのに残っている"
        );

        match old_home {
            Some(h) => std::env::set_var("HOME", h),
            None => std::env::remove_var("HOME"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
