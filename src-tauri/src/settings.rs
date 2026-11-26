use serde_json::{Map, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

static WRITE_LOCK: Mutex<()> = Mutex::new(());

pub fn support_dir() -> PathBuf {
    PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
        .join("Library/Application Support/jp.jinno.marp-kit")
}

pub fn prune_drafts() -> Result<(), std::io::Error> {
    prune_drafts_in(&support_dir().join("drafts"))
}

fn prune_drafts_in(dir: &Path) -> Result<(), std::io::Error> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let stem = name.strip_suffix(".json").unwrap_or("");
        let stem = stem.strip_suffix(".pending").unwrap_or(stem);
        if !matches!(stem.len(), 16 | 64) || !stem.bytes().all(|b| b.is_ascii_hexdigit()) {
            continue;
        }
        let metadata = entry.metadata()?;
        if !metadata.is_file() {
            continue;
        }
        if metadata.modified()?.elapsed().unwrap_or_default().as_secs() > 30 * 24 * 60 * 60 {
            std::fs::remove_file(entry.path())?;
        }
    }
    Ok(())
}

fn read(path: &Path) -> Result<Map<String, Value>, String> {
    match std::fs::read(path) {
        Ok(bytes) => match serde_json::from_slice(&bytes) {
            Ok(data) => Ok(data),
            Err(_) => {
                let backup = path.with_file_name(format!(
                    "settings.json.broken-{}-{}",
                    crate::deck::now_ms(),
                    crate::hash::random_hex(8)
                ));
                std::fs::rename(path, backup).map_err(|e| e.to_string())?;
                Ok(Map::new())
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Map::new()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn settings_get() -> Result<Map<String, Value>, String> {
    let _guard = WRITE_LOCK.lock().map_err(|e| e.to_string())?;
    read(&support_dir().join("settings.json"))
}

fn set(path: &Path, key: String, value: String) -> Result<(), String> {
    let valid = matches!(
        key.as_str(),
        "mj-autosave"
            | "mj-left"
            | "mj-view"
            | "mj-split-left"
            | "mj-insp-tab"
            | "mj-right"
            | "mj-issues"
            | "mj-cheat"
            | "hb-lib"
            | "hb-sort"
            | "pw-cols"
    ) || key.starts_with("mj-present:");
    if !valid || key.len() > 4096 || value.len() > 4096 {
        return Err("設定の名前または値が正しくありません".into());
    }
    let _guard = WRITE_LOCK.lock().map_err(|e| e.to_string())?;
    let mut data = read(path)?;
    data.insert(key, Value::String(value));
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    crate::deck::atomic_write(path, &serde_json::to_vec(&data).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn settings_set(key: String, value: String) -> Result<(), String> {
    set(&support_dir().join("settings.json"), key, value)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn updates_preserve_other_windows_settings_and_reject_unknown_keys() {
        let dir =
            std::env::temp_dir().join(format!("marp-settings-{}", crate::hash::random_hex(12)));
        let file = dir.join("settings.json");
        set(&file, "mj-autosave".into(), "0".into()).unwrap();
        set(&file, "mj-view".into(), "split".into()).unwrap();
        let settings = read(&file).unwrap();
        assert_eq!(settings["mj-autosave"], "0");
        assert_eq!(settings["mj-view"], "split");
        assert!(set(&file, "../outside".into(), "bad".into()).is_err());
        assert_eq!(read(&file).unwrap(), settings);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn corrupt_settings_are_preserved_and_can_be_saved_again() {
        let dir = std::env::temp_dir().join(format!(
            "marp-settings-broken-{}",
            crate::hash::random_hex(12)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("settings.json");
        for broken in [b"{broken".as_slice(), b"[]".as_slice()] {
            std::fs::write(&file, broken).unwrap();
            assert!(read(&file).unwrap().is_empty());
            assert!(std::fs::read_dir(&dir)
                .unwrap()
                .filter_map(Result::ok)
                .any(|e| e
                    .file_name()
                    .to_string_lossy()
                    .starts_with("settings.json.broken-")
                    && std::fs::read(e.path()).unwrap() == broken));
            set(&file, "mj-autosave".into(), "0".into()).unwrap();
            assert_eq!(read(&file).unwrap()["mj-autosave"], "0");
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn only_old_drafts_are_pruned() {
        let dir = std::env::temp_dir().join(format!("marp-prune-{}", crate::hash::random_hex(12)));
        std::fs::create_dir_all(&dir).unwrap();
        let old = dir.join(format!("{}.json", "a".repeat(64)));
        let recent = dir.join(format!("{}.json", "b".repeat(64)));
        let unrelated = dir.join("other.json");
        for p in [&old, &recent, &unrelated] {
            std::fs::write(p, "{}").unwrap();
        }
        let time = std::time::SystemTime::now() - std::time::Duration::from_secs(31 * 86400);
        for p in [&old, &unrelated] {
            std::fs::File::options()
                .write(true)
                .open(p)
                .unwrap()
                .set_modified(time)
                .unwrap();
        }
        prune_drafts_in(&dir).unwrap();
        assert!(!old.exists());
        assert!(recent.exists());
        assert!(unrelated.exists());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
