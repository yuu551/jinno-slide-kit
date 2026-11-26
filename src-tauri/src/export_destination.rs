use crate::deck::{ApiError, Deck};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

static LOCK: Mutex<()> = Mutex::new(());
fn file() -> PathBuf {
    crate::settings::support_dir().join("exports.json")
}
fn read() -> Value {
    std::fs::read(file())
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(json!({}))
}
fn key(deck: &Deck) -> String {
    crate::hash::sha256_hex(deck.deck_path.to_string_lossy().as_bytes())
}
pub fn previous(deck: &Deck, format: &str) -> Option<PathBuf> {
    let _guard = LOCK.lock().ok()?;
    read()
        .get("files")?
        .get(key(deck))?
        .get(format)?
        .as_str()
        .map(PathBuf::from)
        .filter(|p| p.is_file())
}
pub fn remember(deck: &Deck, format: &str, path: &Path) -> Result<(), String> {
    let _guard = LOCK.lock().map_err(|e| e.to_string())?;
    let mut data = read();
    data["directories"][key(deck)] = json!(path.parent());
    data["files"][key(deck)][format] = json!(path);
    std::fs::create_dir_all(crate::settings::support_dir()).map_err(|e| e.to_string())?;
    crate::deck::atomic_write(
        &file(),
        &serde_json::to_vec(&data).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}
fn initial_directory(data: &Value, deck_key: &str, deck_dir: &Path) -> PathBuf {
    data["directories"][deck_key]
        .as_str()
        .map(PathBuf::from)
        .unwrap_or_else(|| deck_dir.join("dist"))
}
pub async fn choose(
    app: AppHandle,
    deck: &Deck,
    format: &str,
) -> Result<Option<PathBuf>, ApiError> {
    // smoke だけはパネルを出さず、コピーした資料の dist に書く。リリースには入らない。
    #[cfg(debug_assertions)]
    if std::env::var_os("MARP_SMOKE_DIR").is_some()
        && std::env::var("MARP_TEST_EXPORT").as_deref() == Ok("1")
    {
        let dir =
            std::fs::canonicalize(&deck.deck_dir).map_err(|e| ApiError::new(500, e.to_string()))?;
        if dir.starts_with("/private/tmp") || dir.starts_with("/tmp") {
            return Ok(deck.export_path(format));
        }
    }
    let ext = Deck::export_ext(format).ok_or_else(|| ApiError::new(400, "書き出せない形式です"))?;
    let title = deck.title();
    let title = if title.is_empty() {
        "スライド".into()
    } else {
        title
    };
    let title: String = title
        .chars()
        .map(|c| {
            if c.is_control() || "\\/:*?\"<>|".contains(c) {
                '_'
            } else {
                c
            }
        })
        .take(180)
        .collect();
    let suffix = if format == "pdf-notes" {
        "（発表者用）"
    } else {
        ""
    };
    let name = format!("{title}{suffix}.{ext}");
    let directory = {
        let _guard = LOCK.lock().map_err(|e| ApiError::new(500, e.to_string()))?;
        initial_directory(&read(), &key(deck), &deck.deck_dir)
    };
    std::fs::create_dir_all(&directory).map_err(|e| {
        ApiError::new(500, "書き出し先のフォルダを作れませんでした").with_detail(e.to_string())
    })?;
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("書き出し先を選ぶ")
            .add_filter(ext, &[ext])
            .set_file_name(name)
            .set_directory(directory)
            .blocking_save_file()
            .map(|p| p.into_path().map_err(|e| ApiError::new(500, e.to_string())))
            .transpose()
    })
    .await
    .map_err(|e| ApiError::new(500, e.to_string()))?
}
pub fn open(deck: &Deck, format: &str, reveal: bool) -> Result<Value, ApiError> {
    let path = previous(deck, format)
        .or_else(|| deck.export_file(format).map(|(p, _)| p))
        .ok_or_else(|| ApiError::new(404, "書き出したファイルが見つかりません"))?;
    let mut command = std::process::Command::new("/usr/bin/open");
    if reveal {
        command.arg("-R");
    }
    let output = command
        .arg(path)
        .output()
        .map_err(|e| ApiError::new(500, "ファイルを開けませんでした").with_detail(e.to_string()))?;
    if !output.status.success() {
        return Err(ApiError::new(500, "ファイルを開けませんでした")
            .with_detail(String::from_utf8_lossy(&output.stderr)));
    }
    Ok(json!({"ok":true}))
}

#[tauri::command]
pub async fn debug_export_panel(app: AppHandle, action: String) -> Result<Value, String> {
    #[cfg(not(debug_assertions))]
    {
        let _ = (app, action);
        Err("この版では使えません".into())
    }
    #[cfg(debug_assertions)]
    {
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        app.run_on_main_thread(move||{
            use objc2::{ClassType,MainThreadMarker};
            use objc2_foundation::NSObjectProtocol;
            use objc2_app_kit::{NSApplication,NSSavePanel,NSView,NSButton};
            fn buttons(view:&NSView,items:&mut Vec<objc2::rc::Retained<NSButton>>){
                if view.isKindOfClass(NSButton::class()){
                    if let Some(button)=unsafe{objc2::rc::Retained::retain(view as *const NSView as *mut NSButton)}{items.push(button);}
                }
                for child in view.subviews().iter(){buttons(&child,items);}
            }
            let result=(||{
                let mtm=MainThreadMarker::new().ok_or("主スレッドではありません")?;
                for window in NSApplication::sharedApplication(mtm).windows().iter(){
                    if window.isKindOfClass(NSSavePanel::class()) && window.isVisible(){
                        let panel=unsafe{&*(&*window as *const _ as *const NSSavePanel)};
                        let selected=panel.URL().and_then(|u|u.path()).map(|s|PathBuf::from(s.to_string()));
                        let directory=selected.as_ref().and_then(|p|p.parent()).map(|p|p.to_string_lossy().to_string())
                            .or_else(||panel.directoryURL().and_then(|u|u.path()).map(|s|s.to_string()));
                        let mut controls=Vec::new();if let Some(view)=panel.contentView(){buttons(&view,&mut controls);}
                        let result=json!({"visible":true,"name":panel.nameFieldStringValue().to_string(),"directory":directory,"buttons":controls.iter().map(|b|json!({"title":b.title().to_string(),"key":b.keyEquivalent().to_string()})).collect::<Vec<_>>()});
                        if action=="cancel"{unsafe{panel.cancel(None);}}
                        else if action=="save" {
                            let home=std::env::var("HOME").map_err(|e|e.to_string())?;
                            let home=std::fs::canonicalize(home).map_err(|e|e.to_string())?;
                            let dir=std::fs::canonicalize(directory.ok_or("保存先がありません")?).map_err(|e|e.to_string())?;
                            if !(home.starts_with("/private/tmp")||home.starts_with("/tmp"))||!dir.starts_with(home){return Err("検証用 HOME の外には保存しません".into());}
                            let button=controls.iter().find(|b|b.isEnabled()&&(b.keyEquivalent().to_string()=="\r"||matches!(b.title().to_string().as_str(),"Save"|"保存"))).ok_or_else(||format!("保存ボタンが見つかりません: {result}"))?;
                            unsafe{button.performClick(None);}
                        }
                        return Ok(result);
                    }
                }
                Ok(json!({"visible":false}))
            })();let _=tx.send(result);
        }).map_err(|e|e.to_string())?;
        tauri::async_runtime::spawn_blocking(move || {
            rx.recv_timeout(std::time::Duration::from_secs(10))
                .map_err(|e| e.to_string())?
        })
        .await
        .map_err(|e| e.to_string())?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn export_folder_belongs_to_each_deck() {
        let data = json!({"directory":"/tmp/old-global", "directories":{"a":"/tmp/a-output"}});
        assert_eq!(
            initial_directory(&data, "a", Path::new("/tmp/a")),
            PathBuf::from("/tmp/a-output")
        );
        assert_eq!(
            initial_directory(&data, "b", Path::new("/tmp/b")),
            PathBuf::from("/tmp/b/dist")
        );
    }
}
