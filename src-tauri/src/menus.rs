use tauri::menu::{
    AboutMetadataBuilder, MenuItem, MenuItemBuilder, PredefinedMenuItem as P, SubmenuBuilder,
};
use tauri::{AppHandle, Manager};
fn item(
    app: &AppHandle,
    id: &str,
    title: &str,
    key: Option<&str>,
) -> tauri::Result<MenuItem<tauri::Wry>> {
    let mut b = MenuItemBuilder::with_id(id, title);
    if let Some(key) = key {
        b = b.accelerator(key);
    }
    b.build(app)
}
pub fn build(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let about = AboutMetadataBuilder::new()
        .name(Some("MarpKit"))
        .version(Some(env!("CARGO_PKG_VERSION")))
        .build();
    let app_menu = SubmenuBuilder::new(app, "MarpKit")
        .item(&P::about(app, Some("MarpKit について"), Some(about))?)
        .item(&item(app, "settings", "設定…", Some("CmdOrCtrl+,"))?)
        .separator()
        .item(&P::services(app, Some("サービス"))?)
        .separator()
        .item(&P::hide(app, Some("MarpKit を隠す"))?)
        .item(&P::hide_others(app, Some("ほかを隠す"))?)
        .item(&P::show_all(app, Some("すべてを表示"))?)
        .separator()
        .item(&item(app, "quit", "MarpKit を終了", Some("CmdOrCtrl+Q"))?)
        .build()?;
    let recent = tauri::menu::Submenu::with_id(app, "recent", "最近使った資料", true)?;
    let export = SubmenuBuilder::new(app, "書き出す")
        .item(&item(app, "export-pdf", "PDF", Some("CmdOrCtrl+Shift+E"))?)
        .item(&item(app, "export-pdf-notes", "発表者用 PDF", None)?)
        .item(&item(
            app,
            "export-pdf-chrome",
            "PDF（Chrome で書き出す）",
            None,
        )?)
        .item(&item(app, "export-pptx", "PowerPoint", None)?)
        .item(&item(app, "export-html", "HTML", None)?)
        .build()?;
    let file = SubmenuBuilder::new(app, "ファイル")
        .item(&item(app, "new", "新しい資料", Some("CmdOrCtrl+N"))?)
        .item(&item(app, "open", "開く…", Some("CmdOrCtrl+O"))?)
        .item(&recent)
        .separator()
        .item(&item(app, "save", "保存", Some("CmdOrCtrl+S"))?)
        .item(&export)
        .item(&item(app, "reveal", "Finder で表示", None)?)
        .separator()
        .item(&item(
            app,
            "library",
            "ライブラリーを表示",
            Some("CmdOrCtrl+L"),
        )?)
        .item(&P::close_window(app, Some("資料を閉じる"))?)
        .build()?;
    let edit = SubmenuBuilder::new(app, "編集")
        .item(&P::undo(app, Some("取り消す"))?)
        .item(&P::redo(app, Some("やり直す"))?)
        .separator()
        .item(&P::cut(app, Some("切り取り"))?)
        .item(&P::copy(app, Some("コピー"))?)
        .item(&P::paste(app, Some("貼り付け"))?)
        .item(&P::select_all(app, Some("すべてを選択"))?)
        .separator()
        .item(&item(
            app,
            "page-new",
            "ページを追加",
            Some("CmdOrCtrl+Shift+N"),
        )?)
        .item(&item(
            app,
            "page-duplicate",
            "ページを複製",
            Some("CmdOrCtrl+D"),
        )?)
        .item(&item(app, "page-delete", "ページを削除", None)?)
        .build()?;
    let view = SubmenuBuilder::new(app, "表示")
        .item(&item(app, "view-slide", "スライド", None)?)
        .item(&item(
            app,
            "view-split",
            "Markdown と並べる",
            Some("CmdOrCtrl+/"),
        )?)
        .item(&item(
            app,
            "view-list",
            "ページ一覧を表示／隠す",
            Some("CmdOrCtrl+\\"),
        )?)
        .item(&item(
            app,
            "view-right",
            "右の欄を表示／隠す",
            Some("CmdOrCtrl+Alt+\\"),
        )?)
        .separator()
        .item(&item(app, "zoom-in", "拡大", Some("CmdOrCtrl+Plus"))?)
        .item(&item(app, "zoom-out", "縮小", Some("CmdOrCtrl+-"))?)
        .item(&item(
            app,
            "zoom-fit",
            "画面に合わせる",
            Some("CmdOrCtrl+0"),
        )?)
        .separator()
        .item(&item(
            app,
            "present",
            "発表を始める",
            Some("CmdOrCtrl+Enter"),
        )?)
        .item(&item(app, "reload", "再読み込み", Some("CmdOrCtrl+R"))?)
        .item(&P::fullscreen(app, Some("フルスクリーンを切り替える"))?)
        .build()?;
    let window = SubmenuBuilder::new(app, "ウインドウ")
        .item(&P::minimize(app, Some("しまう"))?)
        .item(&P::maximize(app, Some("拡大／縮小"))?)
        .separator()
        .item(&P::close_window(app, Some("ウインドウを閉じる"))?)
        .build()?;
    let help = SubmenuBuilder::new(app, "ヘルプ")
        .item(&item(app, "shortcuts", "ショートカット一覧", None)?)
        .item(&item(
            app,
            "writing",
            "書き方の一覧",
            Some("CmdOrCtrl+Shift+K"),
        )?)
        .separator()
        .item(&item(app, "logs", "ログを Finder で表示", None)?)
        .build()?;
    // Native window and help menus are identified to macOS; captions remain explicit.
    // Keep medium M03 undo implementation unchanged; menu labels only here.
    let menu = tauri::menu::MenuBuilder::new(app)
        .items(&[&app_menu, &file, &edit, &view, &window, &help])
        .build()?;
    Ok(menu)
}

fn recent_path() -> std::path::PathBuf {
    crate::settings::support_dir().join("recent.json")
}
fn recent() -> Vec<String> {
    std::fs::read(recent_path())
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}
pub fn remember(app: &AppHandle, path: &str) {
    let mut paths = recent();
    paths.retain(|p| p != path);
    paths.insert(0, path.into());
    paths.truncate(20);
    let _ = std::fs::create_dir_all(crate::settings::support_dir());
    if let Ok(bytes) = serde_json::to_vec(&paths) {
        let _ = crate::deck::atomic_write(&recent_path(), &bytes);
    }
    refresh_recent(app);
    #[cfg(target_os = "macos")]
    if std::env::var_os("MARPKIT_ISOLATED").is_none() {
        if let Some(mtm) = objc2::MainThreadMarker::new() {
            let url = objc2_foundation::NSURL::fileURLWithPath(
                &objc2_foundation::NSString::from_str(path),
            );
            objc2_app_kit::NSDocumentController::sharedDocumentController(mtm)
                .noteNewRecentDocumentURL(&url);
        }
    }
}
fn submenu(
    items: Vec<tauri::menu::MenuItemKind<tauri::Wry>>,
    id: &str,
) -> Option<tauri::menu::Submenu<tauri::Wry>> {
    for item in items {
        if let Some(sub) = item.as_submenu() {
            if sub.id().as_ref() == id {
                return Some(sub.clone());
            }
            if let Some(found) = submenu(sub.items().ok()?, id) {
                return Some(found);
            }
        }
    }
    None
}
pub fn refresh_recent(app: &AppHandle) {
    let Some(menu) = app
        .menu()
        .and_then(|m| m.items().ok())
        .and_then(|items| submenu(items, "recent"))
    else {
        return;
    };
    if let Ok(items) = menu.items() {
        for item in items {
            let _ = menu.remove(&item);
        }
    }
    for (i, path) in recent().iter().enumerate() {
        let p = std::path::Path::new(path);
        let name = p
            .parent()
            .and_then(|p| p.file_name())
            .unwrap_or_default()
            .to_string_lossy();
        if let Ok(item) = item(app, &format!("recent-{i}"), &name, None) {
            let _ = menu.append(&item);
        }
    }
}
fn send(window: &tauri::WebviewWindow, id: &str) {
    if let Ok(id) = serde_json::to_string(id) {
        let _=window.eval(format!("window.__marpkit?.menu ? window.__marpkit.menu({id}) : (window.__marpkitPending ||= []).push({id})"));
    }
}
fn open(app: &AppHandle, path: String) {
    let app = app.clone();
    std::thread::spawn(move || {
        if let Err(error) = crate::app::open_editor_sync(app.clone(), path, None, None) {
            use tauri_plugin_dialog::DialogExt;
            app.dialog()
                .message(error)
                .title("資料を開けません")
                .show(|_| {});
        }
    });
}
pub fn handle(app: &AppHandle, id: &str) {
    let focused = app
        .webview_windows()
        .into_values()
        .find(|w| w.is_focused().unwrap_or(false));
    handle_for(app, id, focused);
}
fn handle_for(app: &AppHandle, id: &str, focused: Option<tauri::WebviewWindow>) {
    use tauri_plugin_dialog::DialogExt;
    match id {
        "quit" => crate::quit_app(app),
        "library" | "new" => {
            let _ = crate::app::open_library(app.clone(), String::new());
            if id == "new" {
                if let Some(w) = app.get_webview_window("library") {
                    send(&w, "new");
                }
            }
        }
        "open" => {
            let handle = app.clone();
            app.dialog()
                .file()
                .set_title("Marp の資料を開く")
                .add_filter("Marp の資料", &["md"])
                .pick_file(move |file| {
                    if let Some(file) = file {
                        if let Ok(path) = file.into_path() {
                            open(&handle, path.to_string_lossy().into());
                        }
                    }
                });
        }
        "logs" => {
            let path = crate::settings::support_dir().join("Logs");
            if std::fs::create_dir_all(&path).is_ok() {
                let _ = crate::app::reveal_path(path.to_string_lossy().into());
            }
        }
        "settings" | "shortcuts" | "writing" => {
            if let Some(w) =
                focused.filter(|w| w.label() == "library" || w.label().starts_with("editor-"))
            {
                send(&w, id)
            } else {
                let _ = crate::app::open_library(app.clone(), String::new());
                if let Some(w) = app.get_webview_window("library") {
                    send(&w, id);
                }
            }
        }
        "reload" => {
            if let Some(w) = focused {
                let _ = w.eval("location.reload()");
            }
        }
        _ if id.starts_with("recent-") => {
            if let Some(path) = id
                .strip_prefix("recent-")
                .and_then(|s| s.parse::<usize>().ok())
                .and_then(|i| recent().get(i).cloned())
            {
                open(app, path);
            }
        }
        _ => {
            if let Some(w) = focused.filter(|w| w.label().starts_with("editor-")) {
                send(&w, id);
            }
        }
    }
}

#[tauri::command]
pub fn debug_macos(
    app: AppHandle,
    window: tauri::Window,
    action: String,
    args: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    #[cfg(not(debug_assertions))]
    {
        let _ = (app, window, action, args);
        Err("デバッグのビルドでだけ使えます".into())
    }
    #[cfg(debug_assertions)]
    {
        let args = args.unwrap_or_default();
        match action.as_str() {
            "activate" => {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
                #[cfg(target_os = "macos")]
                {
                    let mtm =
                        objc2::MainThreadMarker::new().ok_or("主スレッドで表示してください")?;
                    objc2_app_kit::NSApplication::sharedApplication(mtm).activate();
                    if let Ok(ptr) = window.ns_window() {
                        let native = unsafe { &*(ptr as *const objc2_app_kit::NSWindow) };
                        native.makeKeyAndOrderFront(None);
                        native.orderFrontRegardless();
                    }
                }
            }
            "menu" => {
                let _ = window.set_focus();
                handle_for(
                    &app,
                    args["id"].as_str().unwrap_or(""),
                    app.get_webview_window(window.label()),
                );
            }
            "bounds" => {
                let _ = window.set_size(tauri::LogicalSize::new(
                    args["width"].as_f64().unwrap_or(1100.0),
                    args["height"].as_f64().unwrap_or(700.0),
                ));
                let _ = window.set_position(tauri::LogicalPosition::new(
                    args["x"].as_f64().unwrap_or(50.0),
                    args["y"].as_f64().unwrap_or(50.0),
                ));
                crate::window_geometry::remember(&window);
                crate::window_geometry::flush();
            }
            "close-library" => {
                if let Some(w) = app.get_webview_window("library") {
                    let _ = w.close();
                }
            }
            "reopen" => {
                crate::app::open_library(app.clone(), String::new())?;
            }
            "menus" => {
                #[cfg(target_os = "macos")]
                {
                    fn names(menu: &objc2_app_kit::NSMenu, prefix: &str, out: &mut Vec<String>) {
                        for item in menu.itemArray().iter() {
                            out.push(format!("{}{}", prefix, item.title()));
                            if let Some(sub) = item.submenu() {
                                names(&sub, &format!("{prefix}  "), out);
                            }
                        }
                    }
                    let mtm =
                        objc2::MainThreadMarker::new().ok_or("主スレッドで読み出してください")?;
                    let mut out = Vec::new();
                    if let Some(menu) =
                        objc2_app_kit::NSApplication::sharedApplication(mtm).mainMenu()
                    {
                        names(&menu, "", &mut out);
                    }
                    return Ok(serde_json::json!(out));
                }
            }
            "status" => {}
            _ => return Err("知らない検査です".into()),
        }
        let window = if action == "status" {
            args["label"]
                .as_str()
                .and_then(|label| app.get_webview_window(label))
                .map(|webview| webview.as_ref().window())
                .unwrap_or(window)
        } else {
            window
        };
        let mut edited = false;
        let mut visible = false;
        let mut occlusion = 0;
        let mut active = false;
        #[cfg(target_os = "macos")]
        if let Ok(ptr) = window.ns_window() {
            unsafe {
                let native = &*(ptr as *const objc2_app_kit::NSWindow);
                edited = native.isDocumentEdited();
                visible = native.isVisible();
                occlusion = native.occlusionState().0;
                if let Some(mtm) = objc2::MainThreadMarker::new() {
                    active = objc2_app_kit::NSApplication::sharedApplication(mtm).isActive();
                }
            }
        }
        Ok(
            serde_json::json!({"title":window.title().ok(),"edited":edited,"visible":visible,"occlusion":occlusion,"active":active,"position":window.outer_position().ok(),"size":window.outer_size().ok(),"scale":window.scale_factor().ok(),"labels":app.webview_windows().keys().collect::<Vec<_>>() }),
        )
    }
}
