// Tauri の invoke から呼ばれる API（アプリの中のエディター用）。
// HTTP の互換層（http.rs）と同じことを、同じ返す形で行う。
// 画面は backend.mjs を通してここを呼ぶ（ブラウザで動くときは HTTP の方を使う）。
use crate::deck::{ApiError, Deck, SaveOutcome};
use crate::git as G;
use crate::http::Context;
use serde_json::{json, Value};
use std::path::PathBuf;

fn draft_path(deck: &Deck) -> PathBuf {
    let path = deck
        .deck_path
        .canonicalize()
        .unwrap_or_else(|_| deck.deck_path.clone());
    crate::settings::support_dir().join("drafts").join(format!(
        "{}.json",
        crate::hash::sha256_hex(path.to_string_lossy().as_bytes())
    ))
}

// P1 の下書きを、新しい安定した名前へ初回読み込み時に移す。
fn legacy_draft_path(deck: &Deck) -> PathBuf {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    deck.deck_path
        .canonicalize()
        .unwrap_or_else(|_| deck.deck_path.clone())
        .hash(&mut h);
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home)
        .join("Library/Application Support/jp.jinno.marp-kit/drafts")
        .join(format!("{:016x}.json", h.finish()))
}

fn read_draft(file: &std::path::Path, legacy: &std::path::Path) -> Result<Option<Value>, ApiError> {
    if !file.exists() && legacy.is_file() {
        std::fs::rename(legacy, file).map_err(|e| ApiError::new(500, e.to_string()))?;
    }
    Ok(std::fs::read_to_string(file)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok()))
}

/// invoke が受け取る名前ごとの処理
pub fn call(
    deck: &Deck,
    ctx: Option<&Context>,
    name: &str,
    args: &Value,
) -> Result<Value, ApiError> {
    let s = |k: &str| {
        args.get(k)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    match name {
        "info" => Ok(json!({
            "debug": cfg!(debug_assertions),
            "file": deck.deck_path.to_string_lossy(),
            "abs": deck.deck_path.to_string_lossy(),
            "exports": (["pdf", "pdf-notes", "pptx", "html"].into_iter().filter(|fmt| deck.export_file(fmt).is_some()).collect::<Vec<_>>()),
            "name": deck.deck_dir.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(),
            "slides": deck.root.join("marp/bin/slides.mjs").to_string_lossy(),
            // 画面はテーマの CSS をこれで読む（HTTP 版と同じ）
            "themes": crate::http::themes_json(&deck.root),
            "hub": ctx.and_then(|c| c.hub.url()),
        })),
        "deckLocation" => {
            let here = deck
                .deck_path
                .canonicalize()
                .unwrap_or_else(|_| deck.deck_path.clone());
            let mut found = Value::Null;
            for lib in crate::library::load_config() {
                if let Ok(rd) = std::fs::read_dir(&lib.path) {
                    for e in rd.flatten() {
                        let dir = e.path();
                        if !dir.is_dir() {
                            continue;
                        }
                        let f = dir.join("slides.md");
                        if f.canonicalize().ok().as_deref() == Some(here.as_path()) {
                            found = json!({ "lib": lib.id, "slug": dir.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default() });
                        }
                    }
                }
            }
            Ok(found)
        }
        "renameDeck" => {
            let here = deck
                .deck_path
                .canonicalize()
                .map_err(|e| ApiError::new(404, e.to_string()))?;
            for lib in crate::library::load_config() {
                let Ok(relative) =
                    here.strip_prefix(lib.path.canonicalize().unwrap_or(lib.path.clone()))
                else {
                    continue;
                };
                let Some(slug) = relative
                    .parent()
                    .filter(|p| p.components().count() == 1)
                    .and_then(|p| p.to_str())
                else {
                    continue;
                };
                let renamed = crate::library::rename_deck(&lib, slug, &s("to"))
                    .map_err(|e| ApiError::new(400, e))?;
                return Ok(json!({ "slug": renamed }));
            }
            Err(ApiError::new(404, "ライブラリーの中の資料ではありません"))
        }
        "notesGet" => Ok(deck.notes_get()),
        "notesSave" => {
            deck.notes_save(args)?;
            Ok(json!({ "ok": true }))
        }
        "draftGet" => {
            let f = draft_path(deck);
            let draft = read_draft(&f, &legacy_draft_path(deck))?;
            let draft = if draft.is_some() {
                draft
            } else {
                read_draft(&f, &f.with_extension("pending.json"))?
            };
            Ok(json!({ "draft": draft }))
        }

        "draftSet" => {
            let f = draft_path(deck);
            let f = if args["pendingRecovery"].as_bool() == Some(true) {
                f.with_extension("pending.json")
            } else {
                f
            };
            if let Some(dir) = f.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let body = json!({ "text": s("text"), "base": s("base"), "at": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0) });
            crate::deck::atomic_write(&f, body.to_string().as_bytes())
                .map_err(|e| ApiError::new(500, e.to_string()))?;
            Ok(json!({ "ok": true }))
        }
        "draftClear" => {
            let file = draft_path(deck);
            let paths = if args["pendingRecovery"].as_bool() == Some(true) {
                vec![file.with_extension("pending.json")]
            } else {
                vec![
                    file.with_extension("pending.json"),
                    file,
                    legacy_draft_path(deck),
                ]
            };
            for path in paths {
                if let Err(e) = std::fs::remove_file(path) {
                    if e.kind() != std::io::ErrorKind::NotFound {
                        return Err(ApiError::new(500, e.to_string()));
                    }
                }
            }
            Ok(json!({ "ok": true }))
        }
        "deckGet" => {
            let (text, hash) = deck.read_deck()?;
            Ok(json!({ "text": text, "hash": hash }))
        }
        "deckSave" => {
            let text = args
                .get("text")
                .and_then(|t| t.as_str())
                .ok_or_else(|| ApiError::new(400, "text が必要です"))?;
            let base = s("base");
            let force = args.get("force").and_then(|f| f.as_bool()).unwrap_or(false);
            match deck.save_deck(text, &base, force)? {
                SaveOutcome::Ok { hash } => {
                    // 発表画面・発表者画面が追従できるよう「保存した」を知らせる（HTTP 版と同じ）
                    deck.broadcast("saved", json!({ "text": crate::deck::read_text_lossy(&deck.deck_path).unwrap_or_default() }));
                    Ok(json!({ "ok": true, "status": 200, "hash": hash }))
                }
                SaveOutcome::Conflict { text: theirs, hash } => Ok(
                    json!({ "ok": false, "status": 409, "conflict": { "text": theirs, "hash": hash } }),
                ),
            }
        }
        "checkAll" => deck.run_check(&s("text")),
        "cancelExport" => {
            deck.cancel_export();
            Ok(json!({ "ok": true }))
        }
        "cancelCheck" => {
            deck.cancel_check();
            Ok(json!({ "ok": true }))
        }
        "exportDeck" => {
            let fmt = s("format");
            let info = deck.run_export(&fmt)?;
            Ok(json!({ "ok": true, "data": info }))
        }
        "revealExport" => {
            let fmt = s("format");
            match deck.export_file(&fmt) {
                Some((path, _)) => {
                    let _ = std::process::Command::new("open")
                        .arg("-R")
                        .arg(&path)
                        .spawn();
                    Ok(json!({ "ok": true }))
                }
                None => {
                    Ok(json!({ "ok": false, "status": 404, "error": "まだ書き出していません" }))
                }
            }
        }
        "newFigure" => {
            let path = deck.new_figure()?;
            Ok(json!({ "path": path }))
        }
        "uploadImage" => {
            let name = s("name");
            let data: Vec<u8> = args
                .get("data")
                .and_then(|d| d.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_u64().map(|v| v as u8))
                        .collect()
                })
                .unwrap_or_default();
            let path = deck.upload(&name, &data)?;
            Ok(json!({ "path": path }))
        }
        "readFile" => {
            let (text, drawio) = deck.read_file(&s("path"))?;
            Ok(json!({ "text": text, "drawio": drawio }))
        }
        "writeFile" => {
            let text = s("text");
            deck.write_file(&s("path"), text.as_bytes())?;
            Ok(json!({ "ok": true }))
        }
        "openDrawio" => {
            deck.open_drawio(&s("path"))?;
            Ok(json!({ "ok": true }))
        }
        "copyTargets" => Ok(json!({ "targets": crate::library::copy_targets(&deck.deck_path) })),
        "importPages" => {
            let from = args.get("from").and_then(|f| f.as_str()).map(PathBuf::from);
            let r = deck.bring_figures(&s("text"), from.as_deref(), &deck.deck_dir)?;
            Ok(json!({ "text": r.text, "copied": r.copied, "renamed": r.renamed }))
        }
        "sendPages" => {
            let (copied, renamed) = deck.send_pages(&s("text"), &s("target"))?;
            Ok(json!({ "ok": true, "copied": copied, "renamed": renamed }))
        }
        "historyList" => {
            let items = deck.history.list().map_err(|e| ApiError::new(500, e))?;
            Ok(json!({ "items": items, "git": deck.git_log() }))
        }
        "historyText" => {
            let rev = s("rev");
            if !rev.is_empty() {
                if !crate::git::valid_rev(&rev) {
                    return Err(ApiError::new(400, "版の指定が正しくありません"));
                }
                return match deck.git_text(&rev) {
                    Some(text) => Ok(json!({ "ok": true, "text": text })),
                    None => Err(ApiError::new(404, "版が見つかりません")),
                };
            }
            let id = s("id");
            match deck.history.text(&id) {
                Some(text) => {
                    Ok(json!({ "ok": true, "text": text, "entry": deck.history.get(&id) }))
                }
                None => Ok(json!({ "ok": false, "status": 404, "error": "版が見つかりません" })),
            }
        }
        "historyNamed" => {
            let label = s("label");
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
            Ok(json!({ "ok": true, "entry": e }))
        }
        "historyRestoring" => {
            let label = s("label");
            deck.mark_restoring(if label.is_empty() {
                "版を戻した"
            } else {
                &label
            });
            Ok(json!({ "ok": true }))
        }
        "historyRestoreFigure" => {
            let rel = s("path");
            if !crate::deck::is_fig_rel(&rel) {
                return Err(ApiError::new(403, "figs/ の中だけ戻せます"));
            }
            let Some(f) = crate::deck::inside(&deck.deck_dir, &rel) else {
                return Err(ApiError::new(403, "figs/ の中だけ戻せます"));
            };
            let label = s("label");
            let label = if label.is_empty() {
                format!("{rel} を戻した")
            } else {
                label
            };
            deck.set_fig_label(&rel, &label);
            let hash = s("hash");
            if !hash.is_empty() {
                let buf = deck
                    .history
                    .object(&hash)
                    .map_err(|_| ApiError::new(404, "見つかりません"))?;
                crate::deck::atomic_write(&f, &buf)
                    .map_err(|e| ApiError::new(500, e.to_string()))?;
            } else {
                let _ = std::fs::remove_file(&f);
            }
            Ok(json!({ "ok": true }))
        }
        "gitCommit" => {
            let message = s("message");
            let Some(root) = deck.repo_root() else {
                return Ok(
                    json!({ "ok": false, "status": 400, "error": "この資料は Git で管理されていません" }),
                );
            };
            let root_path = PathBuf::from(&root);
            let dir = crate::deck::relative_posix(&root_path, &deck.deck_dir);
            let message = if message.trim().is_empty() {
                "資料を更新".to_string()
            } else {
                message.trim().to_string()
            };
            match G::commit(&root_path, &dir, &message) {
                Ok(short) => Ok(json!({ "ok": true, "data": { "result": short } })),
                Err(e) => Ok(json!({ "ok": false, "status": 400, "error": e.0 })),
            }
        }
        // 履歴の画像・書き出したファイルの URL（画面のサーバーが配る）
        "nodeStatus" => Ok(node_status()),
        other => Err(ApiError::new(404, format!("知らない API です: {other}"))),
    }
}

/// Node と Chrome があるか（書き出しと検査に要る）
pub fn node_status() -> Value {
    // PATH ではなく、アプリが起動時に探した node を使う（E02）
    let node_path = crate::hub::find_node();
    let node = node_path.is_some()
        && crate::hub::node_command()
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|s| s.success());
    let chrome_path = crate::hub::find_chrome();
    let chrome = chrome_path.is_some();
    let message = if !node {
        "Node が見つかりません。検査と書き出しには Node が要ります（node を入れてからアプリを開き直してください）"
    } else if !chrome {
        "Google Chrome が見つかりません。検査と書き出しには Chrome が要ります"
    } else {
        ""
    };
    json!({
        "node": node,
        "chrome": chrome,
        "nodePath": node_path.map(|p| p.to_string_lossy().to_string()),
        "chromePath": chrome_path.map(|p| p.to_string_lossy().to_string()),
        "message": message,
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn old_draft_is_migrated_without_replacing_a_newer_one() {
        let dir = std::env::temp_dir().join(format!(
            "marp-draft-migration-{}",
            crate::hash::random_hex(12)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let old = dir.join("1234567890abcdef.json");
        let new = dir.join(format!("{}.json", crate::hash::sha256_hex(b"fixture-path")));
        std::fs::write(&old, r#"{"text":"unsaved"}"#).unwrap();
        assert_eq!(
            super::read_draft(&new, &old).unwrap().unwrap()["text"],
            "unsaved"
        );
        assert!(!old.exists());
        std::fs::write(&old, r#"{"text":"stale"}"#).unwrap();
        assert_eq!(
            super::read_draft(&new, &old).unwrap().unwrap()["text"],
            "unsaved"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}
