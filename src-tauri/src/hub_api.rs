// ライブラリー（ハブ）の API。marp/hub/server.mjs と同じ返す形にする。
// ブラウザでは Node のハブのサーバー、アプリの中では invoke（hub_call）から呼ばれる。
use crate::deck::ApiError;
use crate::library as L;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

static CANCEL_PDF: OnceLock<Arc<AtomicBool>> = OnceLock::new();
pub(crate) fn cancel_pdf() -> Arc<AtomicBool> {
    CANCEL_PDF
        .get_or_init(|| Arc::new(AtomicBool::new(false)))
        .clone()
}

/// 資料のフォルダ。ライブラリーの外は扱わない（Node 版の deckDir() と同じ。review-P4 の must 9）
fn deck_dir(lib: &L::Library, slug: &str) -> Result<PathBuf, ApiError> {
    // 空・`.`・`a/..` のように、ライブラリーそのものになる指定は資料として扱わない
    // （Node 版の deckDir() と同じ。review-P4-2 の must 2）
    if slug.is_empty() {
        return Err(ApiError::new(400, "資料の名前がありません"));
    }
    let dir = crate::deck::inside(&lib.path, slug)
        .ok_or_else(|| ApiError::new(400, "ライブラリーの外は扱えません"))?;
    if crate::deck::same_dir(&dir, &lib.path) {
        return Err(ApiError::new(400, "資料の名前が不正です"));
    }
    Ok(dir)
}
pub fn export_deck_dir(args: &Value) -> Result<PathBuf, ApiError> {
    let id = args["lib"].as_str().unwrap_or("");
    let lib = L::load_config()
        .into_iter()
        .find(|l| l.id == id)
        .ok_or_else(|| ApiError::new(404, "ライブラリーがありません"))?;
    deck_dir(&lib, args["slug"].as_str().unwrap_or(""))
}

/// リポジトリから見た相対パス。くいちがったらエラー（`.` にしてほかの資料まで巻き込まない）
fn repo_rel(repo: &str, path: &Path) -> Result<String, ApiError> {
    let repo_path = PathBuf::from(repo);
    let a = std::fs::canonicalize(&repo_path).unwrap_or(repo_path.clone());
    let b = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let rel = b
        .strip_prefix(&a)
        .map_err(|_| ApiError::new(400, "ライブラリーと Git のリポジトリの場所が合いません"))?;
    let rel = rel.to_string_lossy().to_string();
    Ok(if rel.is_empty() { ".".to_string() } else { rel })
}

/// アプリの中の入口（invoke）
pub fn call(kit: &Path, name: &str, args: &Value) -> Result<Value, ApiError> {
    let s = |k: &str| {
        args.get(k)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    let libs = L::load_config();
    let lib_of = |id: &str| -> Option<L::Library> {
        // 指定が無いときだけ先頭を使う。知らない ID は先頭で代用しない（D14）
        if id.is_empty() {
            return libs.first().cloned();
        }
        libs.iter().find(|l| l.id == id).cloned()
    };
    match name {
        "info" => {
            Ok(json!({ "debug": cfg!(debug_assertions), "themes": crate::http::themes_json(kit), "templates": crate::templates::catalog(kit).map_err(|e|ApiError::new(500,e))? }))
        }
        "libraries" => Ok(json!({ "libraries": libs.iter().map(L::lib_info).collect::<Vec<_>>() })),
        "folderInfo" => {
            let path=L::existing_folder(&s("path")).map_err(|e|ApiError::new(400,e))?;
            Ok(json!({"path":path.to_string_lossy(),"deck":path.join("slides.md").is_file(),"name":path.file_name().map(|s|s.to_string_lossy().to_string()).unwrap_or_default()}))
        }
        "librariesAdd" => {
            let libs = L::add_library(&s("path"), &s("name")).map_err(|e| ApiError::new(500, e))?;
            Ok(json!({ "libraries": libs.iter().map(L::lib_info).collect::<Vec<_>>() }))
        }
        "decks" => {
            let Some(lib) = lib_of(&s("lib")) else {
                return Err(ApiError::new(404, "ライブラリーがありません"));
            };
            let archived = args
                .get("archived")
                .and_then(|a| a.as_bool())
                .unwrap_or(false);
            let mut decks = L::list_decks(&lib, archived);
            let changes = L::deck_changes(&lib);
            for d in decks.iter_mut() {
                let slug = d
                    .get("slug")
                    .and_then(|s| s.as_str())
                    .unwrap_or("")
                    .to_string();
                let n = changes
                    .get(&slug)
                    .and_then(|v| v.as_array())
                    .map(|a| a.len())
                    .unwrap_or(0);
                if let Value::Object(o) = d {
                    o.insert("changes".into(), json!(n));
                    o.remove("dir");
                }
            }
            Ok(json!({ "decks": decks }))
        }
        "deckText" => {
            let Some(lib) = lib_of(&s("lib")) else {
                return Err(ApiError::new(404, "ライブラリーがありません"));
            };
            let slug = s("slug");
            let file = deck_dir(&lib, &slug)?.join("slides.md");
            let text = crate::deck::read_text_lossy(&file)
                .map_err(|e| ApiError::new(404, e.to_string()))?;
            Ok(json!({ "text": text }))
        }
        "decksCreate" => {
            let Some(lib) = lib_of(&s("lib")) else {
                return Err(ApiError::new(404, "ライブラリーがありません"));
            };
            let from = s("from");
            if !s("slug").is_empty() {
                deck_dir(&lib, &s("slug"))?;
            }
            let slug = match from.as_str() {
                "folder" => L::import_folder(&lib, &s("path"), &s("slug")),
                "" | "template" => {
                    L::create_deck(kit, &lib, &s("slug"), &s("title"), &s("theme"), &s("template"))
                }
                _ => return Err(ApiError::new(400, "不明な資料の作成方法です")),
            }
            .map_err(|e| ApiError::new(400, e))?;
            Ok(json!({ "slug": slug }))
        }
        "decksOp" => {
            let Some(lib) = lib_of(&s("lib")) else {
                return Err(ApiError::new(404, "ライブラリーがありません"));
            };
            let slug = s("slug");
            let op = s("op");
            let to = s("to");
            deck_dir(&lib, &slug)?;
            let out = match op.as_str() {
                "duplicate" => L::duplicate_deck(&lib, &slug).map(|s| json!({ "slug": s })),
                "rename" => L::rename_deck_title(&lib, &slug, &to, args.get("title").and_then(Value::as_str)).map(|s| json!({ "slug": s })),
                "reveal" => std::process::Command::new("/usr/bin/open").arg("-R").arg(lib.path.join(&slug)).output()
                    .map_err(|e| e.to_string()).and_then(|r| if r.status.success() { Ok(json!({"ok":true})) } else { Err("Finder で表示できませんでした".into()) }),
                "trash" => L::trash_deck(&lib, &slug).map(|_| json!({"ok":true})),
                "archive" => L::archive_deck(&lib, &slug, false).map(|s| json!({ "slug": s })),
                "unarchive" => L::archive_deck(&lib, &slug, true).map(|s| json!({ "slug": s })),
                _ => Err("不明な操作です".to_string()),
            };
            out.map_err(|e| ApiError::new(400, e))
        }
        "cancelPdf" => {
            cancel_pdf().store(true, Ordering::SeqCst);
            Ok(json!({ "ok": true }))
        }
        "pdf" => {
            let Some(lib) = lib_of(&s("lib")) else {
                return Err(ApiError::new(404, "ライブラリーがありません"));
            };
            let slug = s("slug");
            let dir = deck_dir(&lib, &slug)?;
            if !dir.join("slides.md").exists() {
                return Err(ApiError::new(404, "資料が見つかりません"));
            }
            let mut cmd = crate::hub::node_command();
            cmd.arg(kit.join("marp/bin/slides.mjs"))
                .arg("build")
                .arg(dir.join("slides.md"))
                .arg("--pdf")
                .current_dir(kit);
            let out = crate::hub::run_with_cancel(
                cmd,
                std::time::Duration::from_secs(600),
                Some(cancel_pdf()),
            )
            .map_err(|e| ApiError::new(500, format!("Node を呼べません: {e}")))?;
            if out.cancelled {
                return Err(ApiError::new(500, "PDF の書き出しを中止しました"));
            }
            if out.timed_out {
                return Err(ApiError::new(
                    500,
                    "PDF の書き出しに時間がかかりすぎたので止めました（10分）",
                ));
            }
            if !out.status.success() {
                let se = String::from_utf8_lossy(&out.stderr);
                return Err(ApiError::new(500, crate::deck::friendly_error(&se))
                    .with_detail(crate::deck::tail(&se, 60)));
            }
            Ok(json!({ "url": format!("/files/{}/{}/dist/slides.pdf", lib.id, slug) }))
        }
        // Git（ハブはリポジトリ単位。slug があれば資料のフォルダ単位）
        "git" => {
            let op = s("op");
            let Some(lib) = lib_of(&s("lib")) else {
                return Err(ApiError::new(404, "ライブラリーがありません"));
            };
            let slug = s("slug");
            let repo = crate::git::repo_root(&lib.path);
            if op == "init" {
                if repo.is_none() {
                    crate::git::init(&lib.path, "ライブラリーを作成")
                        .map_err(|e| ApiError::new(500, e.0))?;
                }
                return Ok(L::lib_info(&lib));
            }
            let Some(repo) = repo else {
                return Err(ApiError::new(409, "このライブラリーはGitのリポジトリではありません。「Gitを始める」で作成できます"));
            };
            let repo_path = PathBuf::from(&repo);
            if !slug.is_empty() {
                deck_dir(&lib, &slug)?;
            }
            let base = if slug.is_empty() {
                lib.path.clone()
            } else {
                lib.path.join(&slug)
            };
            let rel = repo_rel(&repo, &base)?;
            match op.as_str() {
                "status" => serde_json::to_value(
                    crate::git::status(&repo_path, &rel).map_err(|e| ApiError::new(500, e.0))?,
                )
                .map_err(|e| ApiError::new(500, e.to_string())),
                "commit" => {
                    let hash = crate::git::commit(&repo_path, &rel, &s("message"))
                        .map_err(|e| ApiError::new(409, e.0))?;
                    Ok(json!({ "hash": hash, "lib": L::lib_info(&lib) }))
                }
                "log" => {
                    let limit = args.get("limit").and_then(|l| l.as_u64()).unwrap_or(200) as usize;
                    let log = crate::git::log(&repo_path, &rel, limit)
                        .map_err(|e| ApiError::new(500, e.0))?;
                    Ok(json!({ "log": log }))
                }
                "file" => {
                    let file = path_posix(
                        if rel == "." {
                            String::new()
                        } else {
                            rel.clone()
                        },
                        "slides.md",
                    );
                    let rev = s("rev");
                    let text = if rev == "WORKTREE" {
                        std::fs::read_to_string(repo_path.join(&file)).ok()
                    } else {
                        crate::git::show(&repo_path, &rev, &file)
                            .map(|b| String::from_utf8_lossy(&b).to_string())
                    };
                    let parent = if rev == "WORKTREE" {
                        Some("HEAD".to_string())
                    } else {
                        crate::git::parent_of(&repo_path, &rev)
                    };
                    Ok(json!({ "text": text, "parent": parent }))
                }
                "restore" => {
                    crate::git::restore(&repo_path, &rel, &s("rev"))
                        .map_err(|e| ApiError::new(500, e.0))?;
                    Ok(json!({ "ok": true }))
                }
                "fetch" => serde_json::to_value(
                    crate::git::fetch_remote(&repo_path).map_err(|e| ApiError::new(500, e.0))?,
                )
                .map_err(|e| ApiError::new(500, e.to_string())),
                "pull" => serde_json::to_value(
                    crate::git::pull(&repo_path).map_err(|e| ApiError::new(500, e.0))?,
                )
                .map_err(|e| ApiError::new(500, e.to_string())),
                "push" => serde_json::to_value(
                    crate::git::push(&repo_path).map_err(|e| ApiError::new(500, e.0))?,
                )
                .map_err(|e| ApiError::new(500, e.to_string())),
                "remote" => serde_json::to_value(
                    crate::git::set_remote(&repo_path, &s("url"))
                        .map_err(|e| ApiError::new(500, e.0))?,
                )
                .map_err(|e| ApiError::new(500, e.to_string())),
                _ => Err(ApiError::new(404, "不明な操作です")),
            }
        }
        other => Err(ApiError::new(404, format!("知らない API です: {other}"))),
    }
}

fn path_posix(a: String, b: &str) -> String {
    if a.is_empty() {
        b.to_string()
    } else {
        format!("{}/{}", a.trim_end_matches('/'), b)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lib_at(path: PathBuf) -> L::Library {
        L::Library {
            id: "l".into(),
            name: "L".into(),
            path,
        }
    }

    #[test]
    fn deck_dir_stays_inside_the_library() {
        // ライブラリーの外は扱わない（review-P4 の must 9）
        let dir = std::env::temp_dir().join(format!("marp-deckdir-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let lib = lib_at(dir.join("lib"));
        std::fs::create_dir_all(lib.path.join("deck-1")).unwrap();
        std::fs::create_dir_all(dir.join("outside")).unwrap();
        std::fs::write(dir.join("outside/slides.md"), "# 外\n").unwrap();

        assert!(deck_dir(&lib, "deck-1").is_ok());
        assert!(deck_dir(&lib, "../outside").is_err(), "../ で外に出られた");
        assert!(
            deck_dir(&lib, "../../outside").is_err(),
            "../../ で外に出られた"
        );
        assert!(deck_dir(&lib, "/etc").is_err(), "絶対パスが通った");
        assert!(deck_dir(&lib, "").is_err(), "空の名前が通った");
        // ライブラリーそのものを指す指定は拒む（review-P4-2 の must 2）
        assert!(deck_dir(&lib, ".").is_err(), "`.` が通った");
        assert!(deck_dir(&lib, "./").is_err(), "`./` が通った");
        assert!(deck_dir(&lib, "deck-1/..").is_err(), "`deck-1/..` が通った");
        assert!(deck_dir(&lib, "a/..").is_err(), "`a/..` が通った");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn repo_rel_does_not_fall_back_to_the_whole_repo() {
        // くいちがったらエラー（`.` にしてほかの資料まで巻き込まない。review-P4 の must 9）
        let dir = std::env::temp_dir().join(format!("marp-reel-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("repo/lib/deck-1")).unwrap();
        std::fs::create_dir_all(dir.join("elsewhere")).unwrap();
        let repo = dir.join("repo");
        let repo_s = repo.to_string_lossy().to_string();

        assert_eq!(repo_rel(&repo_s, &repo.join("lib")).unwrap(), "lib");
        assert_eq!(
            repo_rel(&repo_s, &repo.join("lib/deck-1")).unwrap(),
            "lib/deck-1"
        );
        assert!(
            repo_rel(&repo_s, &dir.join("elsewhere")).is_err(),
            "外のフォルダが通った"
        );
        // 書き方の違い（/tmp と /private/tmp）でも同じ結果になる
        let spelled = PathBuf::from(format!("/tmp/marp-reel-{}/repo/lib", std::process::id()));
        if spelled.exists() {
            assert_eq!(repo_rel(&repo_s, &spelled).unwrap(), "lib");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
