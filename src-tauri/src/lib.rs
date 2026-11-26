// Marp キットの macOS アプリ。
//
// 起動するとライブラリー（marp/hub/server.mjs）を子の process として起こし、そのページをウインドウに出す。
// エディター・発表画面・発表者画面・プレビューは、アプリの中のウインドウで開く（API は invoke）。
// アプリを閉じると子の process も止まる。
mod hub;

// Rust のバックエンド（HTTP の互換層と、その下のモジュール）
pub mod api;
pub mod app;
pub mod deck;
mod document_gate;
pub mod export_destination;
pub mod git;
pub mod hash;
pub mod history;
pub mod http;
pub mod hub_api;
pub mod library;
mod menus;
#[cfg(target_os = "macos")]
pub mod native_capture;
pub mod native_export;
pub mod native_pdf;
#[cfg(target_os = "macos")]
mod native_shutdown;
pub mod scheme;
pub mod settings;
pub mod slides;
mod templates;
mod window_geometry;

/// `--http` で起動したときの入口（ウインドウを出さず、HTTP の互換層だけを動かす）。
/// 引数は Node のエディターのサーバーと同じ形にする。
pub fn http_main(args: &[String]) -> Result<(), String> {
    let opt = |k: &str| -> Option<String> {
        args.iter()
            .position(|a| a == k)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    // 値を取るオプション（--port・--hub）の次の語は飛ばして、最初の素の引数を資料の場所にする
    let with_value = ["--port", "--hub"];
    let mut deck_arg: Option<String> = None;
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        if with_value.contains(&a.as_str()) {
            i += 2;
            continue;
        }
        if !a.starts_with("--") && deck_arg.is_none() {
            deck_arg = Some(a.clone());
        }
        i += 1;
    }
    let deck_path = deck_arg.ok_or_else(|| "--http には slides.md の場所が要ります".to_string())?;
    let root = hub::find_root()?;
    let deck_path = std::path::PathBuf::from(shellexpand(&deck_path));
    let deck_path = if deck_path.is_absolute() {
        deck_path
    } else {
        std::env::current_dir().unwrap_or_default().join(deck_path)
    };
    if !deck_path.exists() {
        return Err(format!("見つかりません: {}", deck_path.display()));
    }
    let port: u16 = opt("--port").and_then(|p| p.parse().ok()).unwrap_or(4870);
    let bundle_dir = root.join(".check/rust-bundle");
    let config = http::Config {
        root,
        deck_path,
        port,
        hub: opt("--hub"),
        bundle_dir,
    };
    http::run(config)
}

/// 先頭の ~ をホームに開く
fn shellexpand(p: &str) -> String {
    if let Some(rest) = p.strip_prefix("~/") {
        if let Ok(home) = std::env::var("HOME") {
            return format!("{home}/{rest}");
        }
    }
    p.to_string()
}

use std::sync::Mutex;
use tauri::{Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};

/// lock が poison されていても中身を使う（1つの要求が panic しても、次が動けるように）
pub trait LockExt<T> {
    fn lock_ok(&self) -> std::sync::MutexGuard<'_, T>;
}

impl<T> LockExt<T> for Mutex<T> {
    fn lock_ok(&self) -> std::sync::MutexGuard<'_, T> {
        self.lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

// 二重起動を防ぐ（D09）。1つ目のアプリが ~/.config/jinno-marp/instance.sock で待ち、
// 2つ目は開こうとした資料の場所を送って終わる。1つ目はその資料を開く。
mod single_instance {
    use std::io::{BufRead, BufReader, Write};
    use std::os::fd::AsRawFd;
    use std::os::unix::net::{UnixListener, UnixStream};
    static LOCK: std::sync::OnceLock<std::fs::File> = std::sync::OnceLock::new();
    static STANDALONE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

    pub fn owner() -> bool {
        LOCK.get().is_some() || STANDALONE.load(std::sync::atomic::Ordering::SeqCst)
    }

    fn socket_path() -> Option<std::path::PathBuf> {
        let home = std::env::var("HOME").ok().filter(|h| !h.is_empty())?;
        Some(std::path::PathBuf::from(home).join(".config/jinno-marp/instance.sock"))
    }

    /// 2つ目が開こうとしている資料（環境変数か、コマンドラインの .md）
    pub fn requested_deck() -> Option<String> {
        if let Ok(p) = std::env::var("MARP_OPEN_DECK") {
            if p.ends_with(".md") {
                return Some(abs(p));
            }
        }
        std::env::args()
            .skip(1)
            .find(|a| a.ends_with(".md"))
            .map(abs)
    }

    fn abs(p: String) -> String {
        std::fs::canonicalize(&p)
            .or_else(|_| std::env::current_dir().map(|d| d.join(&p)))
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or(p)
    }

    pub fn send(deck: &str) -> bool {
        let Some(path) = socket_path() else {
            return false;
        };
        for _ in 0..100 {
            if let Ok(mut stream) = UnixStream::connect(&path) {
                return writeln!(stream, "{deck}").is_ok();
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        false
    }

    /// socket を作る前から所有者を決める。2つ目は所有者の socket を消さない。
    pub fn forward() -> bool {
        let Some(path) = socket_path() else {
            return false;
        };
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let file = match std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(path.with_extension("lock"))
        {
            Ok(file) => file,
            Err(e) => {
                eprintln!("起動ロックを作れません。二重起動の防止なしで続けます: {e}");
                STANDALONE.store(true, std::sync::atomic::Ordering::SeqCst);
                return false;
            }
        };
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            let _ = LOCK.set(file);
            return false;
        }
        if let Some(deck) = requested_deck() {
            send(&deck);
            return true;
        }
        // LaunchServices の資料は RunEvent::Opened で受け取り、1つ目に渡す。
        false
    }

    /// 1つ目のアプリとして待ち受ける。bind できなければ2つ目なので、送って終わる
    pub fn start(app: tauri::AppHandle) {
        let Some(path) = socket_path() else { return };
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if LOCK.get().is_none() {
            return;
        }
        // flock の所有者だけが、前回の終了時に残ったソケットを片付ける。
        let _ = std::fs::remove_file(&path);
        let listener = match UnixListener::bind(&path) {
            Ok(l) => l,
            Err(e) => {
                // ソケットを作れない環境でも、アプリは起動する（二重起動の防止だけあきらめる）
                eprintln!("二重起動の防止を始められません: {e}");
                return;
            }
        };
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let mut line = String::new();
                let _ = BufReader::new(stream).read_line(&mut line);
                let deck = line.trim().to_string();
                if deck.ends_with(".md") {
                    // メインスレッドに頼む（ライブラリーを閉じていても開ける）
                    let handle = app.clone();
                    std::thread::spawn(move || {
                        let _ = crate::app::open_editor_sync(handle, deck, None, None);
                    });
                } else {
                    let handle = app.clone();
                    let _ = app.run_on_main_thread(move || {
                        let _ = crate::app::open_library(handle, String::new());
                    });
                }
            }
        });
    }

    pub fn cleanup() {
        if LOCK.get().is_none() {
            return;
        }
        if let Some(path) = socket_path() {
            let _ = std::fs::remove_file(path);
        }
    }
}

fn finish_quit(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    if native_shutdown::reply(app, true) {
        return;
    }
    app.exit(0);
}

/// ⌘Q：未保存のエディターがあれば、閉じる確認を出してから終わる（D01）
pub fn quit_app(app: &tauri::AppHandle) {
    if std::env::var("MARP_NO_CLOSE_CONFIRM").is_ok() {
        finish_quit(app);
        return;
    }
    let state = app.state::<app::AppState>();
    let targets: Vec<String> = app
        .webview_windows()
        .values()
        .filter(|w| {
            w.label().starts_with("editor-")
                && state.deck_of(w.label()).is_some()
                && state.close_guard_ready(w.label())
        })
        .map(|w| w.label().to_string())
        .collect();
    eprintln!(
        "QUIT_APP pid={} targets={:?} windows={:?}",
        std::process::id(),
        targets,
        app.webview_windows()
            .keys()
            .map(|label| (
                label.clone(),
                state.deck_of(label).is_some(),
                state.close_guard_ready(label)
            ))
            .collect::<Vec<_>>()
    );
    if targets.is_empty() {
        finish_quit(app);
    } else {
        state.begin_quit();
        for label in targets {
            if state.begin_close(&label) {
                if let Some(window) = app.get_webview_window(&label) {
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
                let _ = app.emit_to(&label, "close-requested", ());
            }
        }
    }
}

pub fn run() {
    if !(cfg!(debug_assertions) && std::env::var("MARP_PARITY_HTML").is_ok())
        && single_instance::forward()
    {
        return;
    }
    // 計測の基準（この時刻からの経過で見る。デバッグのビルドだけ）
    #[cfg(debug_assertions)]
    println!(
        "APP_START: {}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );
    scheme::register(tauri::Builder::default())
        .plugin(tauri_plugin_dialog::init())
        .manage(app::AppState::default())
        .menu(menus::build)
        .on_menu_event(|app, event| menus::handle(app, event.id().as_ref()))
        .invoke_handler(tauri::generate_handler![
            app::api_call,
            menus::debug_macos,
            native_export::native_job,
            native_export::native_snapshot,
            native_export::native_job_bytes,
            export_destination::debug_export_panel,
            app::upload_image,
            settings::settings_get,
            settings::settings_set,
            app::hub_call,
            app::pick_library_folder,
            app::hub_url,
            app::open_editor,
            app::open_library,
            app::open_present,
            app::presentation_fullscreen,
            app::open_presenter,
            app::open_present_for,
            app::open_file_window,
            app::open_preview,
            app::close_window,
            app::close_window_now,
            app::close_window_cancel,
            app::close_guard_ready,
            app::close_deck,
            app::deck_saved,
            app::debug_quit,
            app::debug_reload_and_close,
            app::debug_window_labels,
            app::debug_inner_size,
            app::reveal_path,
            app::node_status,
            app::parity_report,
            app::log_report,
            app::smoke_report,
        ])
        .on_page_load(|webview, payload| {
            // 読み直しの途中は、前のページの「閉じる確認待ち」を消す（D01）
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                if let Some(state) = webview.app_handle().try_state::<app::AppState>() {
                    state.clear_close_guard(webview.label());
                    state.end_close(webview.label());
                }
            }
        })
        .setup(|app| {
            // 追試：実際の WKWebView で見た目を測る（MARP_PARITY_HTML を付けて起動したときだけ）
            #[cfg(debug_assertions)]
            if std::env::var("MARP_PARITY_HTML").is_ok() {
                setup_parity(app.handle().clone())?;
                return Ok(());
            }
            if !single_instance::owner() {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(2));
                    single_instance::send("");
                    handle.exit(0);
                });
                return Ok(());
            }
            single_instance::start(app.handle().clone());
            #[cfg(target_os = "macos")]
            if let Err(e) = native_shutdown::install(app.handle()) {
                eprintln!("終了確認を登録できません: {e}");
            }
            if let Err(e) = settings::prune_drafts() {
                eprintln!("古い下書きを整理できませんでした: {e}");
            }
            // 配布する画面は同梱した版を使う。
            if let Ok(dir) = app.path().resource_dir() {
                std::env::set_var("MARP_RESOURCE_DIR", dir);
            }
            let root = match hub::find_root() {
                Ok(root) => root,
                Err(e) => {
                    eprintln!("{e}");
                    WebviewWindowBuilder::new(
                        app,
                        "unavailable",
                        WebviewUrl::App("unavailable.html".into()),
                    )
                    .title("MarpKit")
                    .inner_size(520.0, 240.0)
                    .build()?;
                    return Ok(());
                }
            };
            {
                let state = app.state::<app::AppState>();
                *state
                    .kit
                    .lock()
                    .map_err(|e| Box::<dyn std::error::Error>::from(e.to_string()))? =
                    Some(root.clone());
            }
            let args: Vec<_> = std::env::args().collect();
            if let Some(path) = args
                .iter()
                .position(|a| a == "--verify-deck")
                .and_then(|i| args.get(i + 1))
                .map(std::path::PathBuf::from)
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let result = native_export::verify(handle.clone(), root, path).await;
                    let success = result.is_ok();
                    let mut value = match result {
                        Ok(data) => serde_json::json!({"ok":true,"data":data}),
                        Err(e) => serde_json::json!({"ok":false,"error":e}),
                    };
                    value["architecture"] = serde_json::json!(std::env::consts::ARCH);
                    value["debug"] = serde_json::json!(cfg!(debug_assertions));
                    let output = settings::support_dir().join("verification.json");
                    if let Some(dir) = output.parent() {
                        let _ = std::fs::create_dir_all(dir);
                    }
                    if let Ok(bytes) = serde_json::to_vec_pretty(&value) {
                        let _ = crate::deck::atomic_write(&output, &bytes);
                    }
                    handle.exit(if success { 0 } else { 1 });
                });
                return Ok(());
            }
            // 動作を確かめるとき用（デバッグのビルドだけ）：ライブラリーの URL を差し替える
            let override_url = {
                #[cfg(debug_assertions)]
                {
                    std::env::var("MARP_LIBRARY_URL").ok()
                }
                #[cfg(not(debug_assertions))]
                {
                    None::<String>
                }
            };
            let url_text = match override_url {
                Some(u) => u,
                None => {
                    // ライブラリーの画面もアプリ自身が配る（API は invoke。Node のサーバーは起こさない）
                    let bundle_dir = root.join(".check/rust-bundle");
                    if let Err(error) = http::ensure_bundle(&root, &bundle_dir) {
                        eprintln!("{error}");
                        WebviewWindowBuilder::new(
                            app,
                            "unavailable",
                            WebviewUrl::App("unavailable.html".into()),
                        )
                        .title("MarpKit")
                        .inner_size(520.0, 240.0)
                        .build()?;
                        return Ok(());
                    }
                    *app.state::<app::AppState>()
                        .hub_port
                        .lock()
                        .map_err(|e| e.to_string())? = Some(0);
                    "marp://localhost/hub/".to_string()
                }
            };
            let url = url_text
                .parse()
                .map_err(Box::<dyn std::error::Error>::from)?;
            window_geometry::prepare("library");
            let library = WebviewWindowBuilder::new(app, "library", WebviewUrl::External(url))
                .title("Marp キット")
                .inner_size(1440.0, 900.0)
                .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
                .min_inner_size(900.0, 600.0)
                .on_navigation(app::is_own_url)
                .build()?;
            window_geometry::restore(&library.as_ref().window());
            menus::refresh_recent(app.handle());
            // 前回開いていた資料を開き直す（ライブラリーの画面が出たころに）。
            // 配る .app でも動くように、デバッグのブロックの外に置く（review-P4 の must 11）
            if std::env::var("MARP_NO_RESTORE").is_err() {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(1500));
                    for deck in app::last_open_decks() {
                        if std::path::Path::new(&deck).exists() {
                            let _ = app::open_editor_sync(handle.clone(), deck, None, None);
                        }
                    }
                });
            }

            // --- 動作を確かめるとき用（デバッグのビルドだけ） ---
            #[cfg(debug_assertions)]
            {
                // 起動直後にエディターのウインドウを開く
                if let Ok(deck) = std::env::var("MARP_OPEN_DECK") {
                    let handle = app.handle().clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(2500));
                        match app::open_editor_sync(handle, deck, None, None) {
                            Ok(v) => println!("MARP_OPEN_DECK: {v}"),
                            Err(e) => println!("MARP_OPEN_DECK 失敗: {e}"),
                        }
                    });
                }
                // 画面の中を確かめる JS を流す（MARP_SMOKE_JS は1回だけ、MARP_SMOKE_DIR は順に何度でも）
                if std::env::var("MARP_SMOKE_JS").is_ok() || std::env::var("MARP_SMOKE_DIR").is_ok()
                {
                    let handle = app.handle().clone();
                    std::thread::spawn(move || {
                        // 1回だけの MARP_SMOKE_JS は、これまでの 6 秒待ちを残す。
                        // 何度も流す MARP_SMOKE_DIR は、測るときに待ちを 0 にできる。
                        let delay = if std::env::var("MARP_SMOKE_JS").is_ok() {
                            6000
                        } else {
                            std::env::var("MARP_SMOKE_DELAY_MS")
                                .ok()
                                .and_then(|v| v.parse::<u64>().ok())
                                .unwrap_or(2000)
                        };
                        std::thread::sleep(std::time::Duration::from_millis(delay));
                        run_smoke(handle);
                    });
                }
                // 指定した時間のあと、閉じたときと同じ道を通って終わる
                if let Ok(Ok(ms)) = std::env::var("MARP_QUIT_AFTER_MS").map(|v| v.parse::<u64>()) {
                    let handle = app.handle().clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(ms));
                        handle.exit(0);
                    });
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(
                event,
                WindowEvent::Moved(_)
                    | WindowEvent::Resized(_)
                    | WindowEvent::CloseRequested { .. }
            ) {
                window_geometry::remember(window);
                if matches!(event, WindowEvent::CloseRequested { .. }) {
                    window_geometry::flush();
                }
            }
            // エディターは、未保存の確認を画面の中で出してから閉じる（D01）
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                let confirm = std::env::var("MARP_NO_CLOSE_CONFIRM").is_err();
                let label = window.label().to_string();
                let state = app.state::<app::AppState>();
                let is_editor = label.starts_with("editor-") && state.deck_of(&label).is_some();
                // 画面が受け手を用意する前（読み込み中・読み込み失敗）は、閉じられなくならないよう通す
                if confirm && is_editor && state.close_guard_ready(&label) {
                    api.prevent_close();
                    if state.begin_close(&label) {
                        let _ = app.emit_to(&label, "close-requested", ());
                    }
                }
            }
            // 閉じたウインドウを記録から外す。アプリを終えるのは終了確認が済んだときだけ。
            if let WindowEvent::Destroyed = event {
                if window.label().starts_with("export-") {
                    return;
                }
                let app = window.app_handle();
                #[cfg(debug_assertions)]
                eprintln!(
                    "WINDOWS_REMAIN: {}",
                    app.webview_windows()
                        .keys()
                        .filter(|l| l.as_str() != window.label())
                        .count()
                );
                if let Some(state) = app.try_state::<app::AppState>() {
                    state.close_window(window.label());
                    if state.quitting() && !state.has_pending_close() {
                        finish_quit(app);
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("アプリを組み立てられません")
        .run(|app, event| {
            if let RunEvent::ExitRequested { api, code, .. } = &event {
                if code.is_none() && !native_shutdown::approved() {
                    api.prevent_exit();
                }
            }
            #[cfg(target_os = "macos")]
            if let RunEvent::Reopen { .. } = &event {
                let _ = app::open_library(app.clone(), String::new());
            }

            if let RunEvent::Exit = &event {
                window_geometry::flush();
                native_export::cancel_all();
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(6);
                while native_export::busy() && std::time::Instant::now() < deadline {
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
                // 走っている書き出し・検査の子を残さない（E03）
                if let Some(state) = app.try_state::<app::AppState>() {
                    if state.cancel_running() {
                        std::thread::sleep(std::time::Duration::from_millis(300));
                    }
                }
                let _ =
                    crate::hub_api::cancel_pdf().swap(true, std::sync::atomic::Ordering::SeqCst);
                single_instance::cleanup();
            }
            // ファイルの関連づけ：slides.md をダブルクリックして開いたとき
            if let RunEvent::Opened { urls } = event {
                if !single_instance::owner() {
                    let handle = app.clone();
                    std::thread::spawn(move || {
                        for u in urls {
                            if let Ok(p) = u.to_file_path() {
                                single_instance::send(&p.to_string_lossy());
                            }
                        }
                        handle.exit(0);
                    });
                    return;
                }
                for u in urls {
                    if let Ok(path) = u.to_file_path() {
                        let p = path.to_string_lossy().to_string();
                        if p.ends_with(".md") {
                            let handle = app.clone();
                            std::thread::spawn(move || {
                                std::thread::sleep(std::time::Duration::from_millis(500));
                                if let Err(error) =
                                    app::open_editor_sync(handle.clone(), p, None, None)
                                {
                                    use tauri_plugin_dialog::DialogExt;
                                    handle
                                        .dialog()
                                        .message(error)
                                        .title("資料を開けません")
                                        .show(|_| {});
                                }
                            });
                        }
                    }
                }
            }
        });
}

/// 画面の中を確かめる JS を流す（MARP_SMOKE_JS/MARP_SMOKE_DIR・MARP_SMOKE_WINDOW。デバッグのビルドだけ）
#[cfg(debug_assertions)]
fn run_smoke(handle: tauri::AppHandle) {
    if let Ok(dir) = std::env::var("MARP_SMOKE_DIR") {
        run_smoke_dir(&handle, std::path::Path::new(&dir));
        return;
    }
    let Ok(js_file) = std::env::var("MARP_SMOKE_JS") else {
        return;
    };
    let Ok(js) = std::fs::read_to_string(js_file) else {
        return;
    };
    let prefix = std::env::var("MARP_SMOKE_WINDOW").unwrap_or_else(|_| "editor-".into());
    match wait_smoke_window(&handle, &prefix) {
        Some(w) => {
            let _ = w.eval(&js);
        }
        None => println!("SMOKE: {prefix} で始まるウインドウがありません"),
    }
}

#[cfg(debug_assertions)]
fn wait_smoke_window(handle: &tauri::AppHandle, prefix: &str) -> Option<tauri::WebviewWindow> {
    let wait = std::env::var("MARP_SMOKE_WAIT_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(30_000);
    let start = std::time::Instant::now();
    loop {
        if let Some((_, w)) = handle
            .webview_windows()
            .into_iter()
            .find(|(label, _)| label.starts_with(prefix))
        {
            return Some(w);
        }
        if start.elapsed().as_millis() as u64 >= wait {
            return None;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

/// MARP_SMOKE_DIR の *.js を名前順に1つずつ流し、結果を同じフォルダの *.out.json に書く。
/// 1つ終わる（結果のファイルができる）まで次を流さないので、アプリの状態を順に確かめられる。
#[cfg(debug_assertions)]
fn run_smoke_dir(handle: &tauri::AppHandle, dir: &std::path::Path) {
    let default_prefix = std::env::var("MARP_SMOKE_WINDOW").unwrap_or_else(|_| "editor-".into());
    let Ok(entries) = std::fs::read_dir(dir) else {
        println!("SMOKE: フォルダを読めません: {}", dir.display());
        return;
    };
    let mut files: Vec<std::path::PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().map(|e| e == "js").unwrap_or(false))
        .collect();
    files.sort();
    let timeout = std::env::var("MARP_SMOKE_TIMEOUT_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(60_000);
    for file in files {
        let name = file
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "smoke".into());
        let out = file.with_extension("out.json");
        let _ = std::fs::remove_file(&out);
        let Ok(js) = std::fs::read_to_string(&file) else {
            println!("SMOKE: 読めません: {}", file.display());
            continue;
        };
        // 最初の空でない行が `// window: <ラベル>` なら、そのウインドウで流す
        let prefix = js
            .lines()
            .find(|l| !l.trim().is_empty())
            .and_then(|l| l.trim().strip_prefix("// window:"))
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|| default_prefix.clone());
        let Some(window) = wait_smoke_window(handle, &prefix) else {
            eprintln!("SMOKE: {prefix} で始まるウインドウがありません（{name}）");
            let body = serde_json::json!({
                "name": name,
                "ok": false,
                "result": serde_json::Value::Null,
                "error": format!("{prefix} で始まるウインドウがありません"),
            });
            let _ = std::fs::write(&out, body.to_string());
            continue;
        };
        // ウインドウができた直後は about:blank のことがある。目的のページへ移るまで待つ。
        let start = std::time::Instant::now();
        while start.elapsed().as_millis() < 30_000 {
            let moved = window
                .url()
                .map(|u| matches!(u.scheme(), "http" | "https" | "marp"))
                .unwrap_or(false);
            if moved {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        let settle = std::env::var("MARP_SMOKE_WINDOW_SETTLE_MS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(300);
        if settle > 0 {
            std::thread::sleep(std::time::Duration::from_millis(settle));
        }
        let name_json = serde_json::to_string(&name).unwrap_or_else(|_| "\"smoke\"".into());
        let prefix_json = serde_json::to_string(&prefix).unwrap_or_else(|_| "\"\"".into());
        let wrapper = format!(
            r#"(async () => {{
  const __smokeInvoke = (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke)
    || (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke);
  const __smokeName = {name_json};
  try {{
    const __smokePrefix = {prefix_json};
    const __smokeDeadline = performance.now() + {timeout};
    while ((__smokePrefix.startsWith('editor-') && !window.__editor)
      || (__smokePrefix === 'library' && !window.__hub)) {{
      if (performance.now() >= __smokeDeadline) throw new Error('画面の初期化が終わりません');
      await new Promise(resolve => setTimeout(resolve, 25));
    }}
    const __smokeResult = await (async () => {{
{js}
    }})();
    await __smokeInvoke('smoke_report', {{ name: __smokeName, ok: true, result: __smokeResult === undefined ? null : __smokeResult, error: null }});
  }} catch (e) {{
    await __smokeInvoke('smoke_report', {{ name: __smokeName, ok: false, result: null, error: String(e?.message || e) + '\n' + String(e?.stack || '') }});
  }}
}})();"#
        );
        eprintln!("SMOKE_EVAL: {name} → {prefix}");
        // 後ろに隠れたウインドウは WebKit がタイマーを止めるので、流す間だけ前へ出す
        let _ = window.set_focus();
        let _ = window.eval(&wrapper);
        let start = std::time::Instant::now();
        while !out.exists() && (start.elapsed().as_millis() as u64) < timeout {
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        if !out.exists() {
            let body = serde_json::json!({
                "name": name,
                "ok": false,
                "result": serde_json::Value::Null,
                "error": format!("{timeout}ms 以内に結果が返りませんでした"),
            });
            let _ = std::fs::write(&out, body.to_string());
        }
        eprintln!("SMOKE: {name} → {}", out.display());
    }
    println!("SMOKE_DONE: {}", dir.display());
    if std::env::var("MARP_SMOKE_QUIT").is_ok() {
        handle.exit(0);
    }
}

/// 実際の WKWebView で、配った HTML を測る（P3 の parity の追試）。
/// MARP_PARITY_HTML（測る HTML）・MARP_PARITY_JS（測るスクリプト）・MARP_PARITY_OUT（結果の書き場所）
#[cfg(debug_assertions)]
fn setup_parity(app: tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let html = std::env::var("MARP_PARITY_HTML")?;
    let html_path = std::path::PathBuf::from(&html);
    let deck_dir = html_path
        .parent()
        .ok_or("HTML の場所が分かりません")?
        .to_path_buf();
    let root = hub::find_root()?;
    let deck_path = deck_dir.join("slides.md");
    let bundle_dir = root.join(".check/rust-bundle");
    let running = http::start(http::Config {
        root,
        deck_path,
        port: 0,
        hub: None,
        bundle_dir,
    })?;
    let name = html_path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let url = format!("http://127.0.0.1:{}/deck/{}", running.port, name);
    let parsed: tauri::Url = url.parse()?;
    let window = WebviewWindowBuilder::new(&app, "parity", WebviewUrl::External(parsed))
        .title("parity")
        .inner_size(1280.0, 720.0)
        .build()?;
    // 読み込みと描画が終わるのを待ってから、測るスクリプトを流す
    let js = std::env::var("MARP_PARITY_JS")
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_default();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(4000));
        if !js.is_empty() {
            let _ = window.eval(&js);
        }
    });
    Ok(())
}
