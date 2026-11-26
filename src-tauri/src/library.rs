// ライブラリー（Marp の資料を集めた場所）。marp/lib/library.mjs と同じ結果にする。
// 1つのライブラリー＝1つのフォルダ、1つの資料＝その下のフォルダ（slides.md を持つ）。
// 設定は ~/.config/jinno-marp/config.json（Node 版と同じ形式）。
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub struct Library {
    pub id: String,
    pub name: String,
    pub path: PathBuf,
}

pub fn config_path() -> PathBuf {
    if let Ok(p) = std::env::var("JINNO_MARP_CONFIG") {
        return PathBuf::from(p);
    }
    home().join(".config/jinno-marp/config.json")
}

fn home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default())
}

fn expand(p: &str) -> PathBuf {
    if p == "~" {
        return home();
    }
    if let Some(rest) = p.strip_prefix("~/") {
        return home().join(rest);
    }
    let path = PathBuf::from(p);
    if path.is_absolute() {
        path
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    }
}

/// ~/.config/jinno-marp/config.json を読む（無ければ既定の1つ）
pub fn load_config() -> Vec<Library> {
    let text = std::fs::read_to_string(config_path()).unwrap_or_default();
    let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    let mut out = Vec::new();
    if let Some(list) = v.get("libraries").and_then(|l| l.as_array()) {
        for l in list {
            let path = l.get("path").and_then(|p| p.as_str()).unwrap_or("");
            if path.is_empty() {
                continue;
            }
            let path = expand(path);
            out.push(Library {
                id: l
                    .get("id")
                    .and_then(|x| x.as_str())
                    .unwrap_or("lib")
                    .to_string(),
                name: l
                    .get("name")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string(),
                path,
            });
        }
    }
    if out.is_empty() {
        out.push(Library {
            id: "slides".into(),
            name: "Slides".into(),
            path: home().join("Slides"),
        });
    }
    out
}

/// 設定を書く（ホームは ~ に縮める。Node 版と同じ）。
/// いまのファイルにあるほかのキー・ライブラリーごとの余分なキーは消さない（SPEC §7。review-P4 の must 10）
pub fn save_config(libs: &[Library]) -> Result<(), String> {
    let file = config_path();
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut root: Map<String, Value> = std::fs::read_to_string(&file)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    let h = home().to_string_lossy().to_string();
    let old: Vec<Value> = root
        .get("libraries")
        .and_then(|l| l.as_array())
        .cloned()
        .unwrap_or_default();
    let list: Vec<Value> = libs
        .iter()
        .map(|l| {
            let p = l.path.to_string_lossy().to_string();
            let p = if !h.is_empty() && p.starts_with(&h) {
                p.replacen(&h, "~", 1)
            } else {
                p
            };
            // 同じパスの古い項目にあれば、そのキーを残す
            let mut obj = old
                .iter()
                .find(|o| {
                    let op = o.get("path").and_then(|x| x.as_str()).unwrap_or("");
                    !op.is_empty() && expand(op) == l.path
                })
                .and_then(|o| o.as_object().cloned())
                .unwrap_or_default();
            obj.insert("id".into(), Value::String(l.id.clone()));
            obj.insert("name".into(), Value::String(l.name.clone()));
            obj.insert("path".into(), Value::String(p));
            Value::Object(obj)
        })
        .collect();
    root.insert("libraries".into(), Value::Array(list));
    let body = serde_json::to_string_pretty(&Value::Object(root)).map_err(|e| e.to_string())?;
    std::fs::write(&file, format!("{body}\n")).map_err(|e| e.to_string())
}

pub fn existing_folder(input: &str) -> Result<PathBuf,String> {
    if input.trim().is_empty() || (!Path::new(input).is_absolute() && !input.starts_with("~/") && input != "~") {
        return Err("フォルダを選ぶか、/ または ~/ で始まる場所を指定してください".into());
    }
    let path=expand(input).canonicalize().map_err(|_|"フォルダが見つかりません。場所を確かめてください")?;
    if !path.is_dir(){return Err("フォルダを選んでください".into());}
    Ok(path)
}

pub fn add_library(path: &str, name: &str) -> Result<Vec<Library>, String> {
    let mut libs = load_config();
    let abs = existing_folder(path)?;
    if !libs.iter().any(|l| l.path == abs) {
        let fallback = abs
            .file_name()
            .map(|f| f.to_string_lossy().to_string())
            .unwrap_or_default();
        let want = if name.is_empty() {
            fallback.as_str()
        } else {
            name
        };
        let base = {
            let s = slugify(want);
            if s.is_empty() {
                format!("lib{}", libs.len() + 1)
            } else {
                s
            }
        };
        let id = if libs.iter().any(|l| l.id == base) {
            format!("{base}-{}", libs.len() + 1)
        } else {
            base
        };
        let name = if name.is_empty() {
            abs.file_name()
                .map(|f| f.to_string_lossy().to_string())
                .unwrap_or_default()
        } else {
            name.to_string()
        };
        libs.push(Library {
            id,
            name,
            path: abs.clone(),
        });
        save_config(&libs)?;
    }
    Ok(libs)
}

/// 名前をフォルダ名に使える形にする（Node 版の slugify と同じ手順）。
/// NFKC で正規化 → 使えない文字の連続を `-` に → `-` の連続を1つに → 前後の `-` と `.` を落とす → 80文字
pub fn slugify(s: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    let normalized: String = s.nfkc().collect();
    let mut out = String::new();
    let mut pending_dash = false;
    // JS の trim() と \s に合わせる（BOM は空白、U+0085 は空白ではない。review-P4-2 の should）
    let trimmed = normalized.trim_matches(crate::deck::is_js_space);
    for c in trimmed.chars() {
        let bad = crate::deck::is_js_space(c) || "/\\:*?\"<>|#%".contains(c);
        if bad {
            if !out.is_empty() {
                pending_dash = true;
            }
        } else {
            if pending_dash && !out.ends_with('-') {
                out.push('-');
            }
            pending_dash = false;
            out.push(c);
        }
    }
    // `-` の連続を1つにする（Node 版の replace(/-+/g, '-')）
    let mut collapsed = String::new();
    let mut prev_dash = false;
    for c in out.chars() {
        if c == '-' {
            if !prev_dash {
                collapsed.push('-');
            }
            prev_dash = true;
        } else {
            collapsed.push(c);
            prev_dash = false;
        }
    }
    let out = collapsed.trim_matches(|c| c == '-' || c == '.').to_string();
    // Node の slice(0, 80) は UTF-16 の単位で数える（絵文字があっても同じ長さにする）
    let mut len = 0usize;
    let mut cut = out.len();
    for (i, c) in out.char_indices() {
        len += c.len_utf16();
        if len > 80 {
            cut = i;
            break;
        }
    }
    out[..cut].to_string()
}

/// フロントマターの簡易な読み取り（key: value と key: [a, b]）。
/// Node 版と同じく、字下げした行は読まない（`^([A-Za-z_][\w-]*):\s*(.*)$`）
pub fn front_matter(text: &str) -> BTreeMap<String, Value> {
    let mut out = BTreeMap::new();
    let mut lines = text.lines();
    if lines.next().map(|l| l.trim_end_matches('\r')) != Some("---") {
        return out;
    }
    for line in lines {
        if line.trim_end_matches('\r') == "---" {
            break;
        }
        let Some((k, v)) = line.split_once(':') else {
            continue;
        };
        let k = k.trim_end_matches('\r');
        let mut chars = k.chars();
        let head_ok = chars
            .next()
            .map(|c| c.is_ascii_alphabetic() || c == '_')
            .unwrap_or(false)
            && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
        if !head_ok {
            continue; // 字下げした行・別の書き方は読まない（Node と同じ）
        }
        let v = v.trim();
        if v.starts_with('[') && v.ends_with(']') {
            let items: Vec<Value> = v[1..v.len() - 1]
                .split(',')
                .map(|x| x.trim().trim_matches(|c| c == '"' || c == '\''))
                .filter(|x| !x.is_empty())
                .map(|x| Value::String(x.to_string()))
                .collect();
            out.insert(k.to_string(), Value::Array(items));
        } else {
            out.insert(
                k.to_string(),
                Value::String(serde_json::from_str::<String>(v).unwrap_or_else(|_| {
                    v.trim_matches(|c| c == '"' || c == '\'').replace("''", "'")
                })),
            );
        }
    }
    out
}

/// 資料1つ分の情報（marp/lib/library.mjs の deckInfo と同じ）
pub fn deck_info(lib: &Library, slug: &str) -> Result<Value, String> {
    let dir = lib.path.join(slug);
    let file = dir.join("slides.md");
    let text = crate::deck::read_text_lossy(&file).map_err(|e| e.to_string())?;
    let meta = std::fs::metadata(&file).map_err(|e| e.to_string())?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let fm = front_matter(&text);
    let first_h1 = text
        .lines()
        .find(|l| l.starts_with("# "))
        .map(|l| {
            l[2..]
                .replace("<br>", " ")
                .replace("<br/>", " ")
                .replace("<br />", " ")
                .replace("**", "")
                .trim()
                .to_string()
        })
        .unwrap_or_else(|| slug.to_string());
    let mut fig_mtime = 0u64;
    if let Ok(rd) = std::fs::read_dir(dir.join("figs")) {
        for e in rd.filter_map(|e| e.ok()) {
            if let Ok(m) = e.metadata().and_then(|m| m.modified()) {
                let t = m
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                fig_mtime = fig_mtime.max(t);
            }
        }
    }
    let title = fm
        .get("title")
        .and_then(|t| t.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or(first_h1);
    let theme = fm
        .get("theme")
        .and_then(|t| t.as_str())
        .unwrap_or("default")
        .to_string();
    let tags: Vec<Value> = match fm.get("tags") {
        Some(Value::Array(a)) => a.clone(),
        Some(Value::String(s)) => s
            .split([',', '、'])
            .map(|x| x.trim())
            .filter(|x| !x.is_empty())
            .map(|x| Value::String(x.to_string()))
            .collect(),
        _ => Vec::new(),
    };
    let event = fm
        .get("event")
        .and_then(|t| t.as_str())
        .map(|s| s.to_string())
        .unwrap_or_default();
    Ok(json!({
        "slug": slug,
        "dir": dir.to_string_lossy(),
        "lib": lib.id,
        "title": title,
        "theme": theme,
        "tags": tags,
        "event": event,
        "author": fm.get("author").and_then(|t| t.as_str()).unwrap_or(""),
        "date": fm.get("date").and_then(|t| t.as_str()).unwrap_or(""),
        "pages": crate::slides::ranges_from_text(&text).len(),
        "updated": mtime.max(fig_mtime),
        "archived": slug.starts_with("_archive/"),
    }))
}

/// アプリの中でも「別の資料へコピー」の行き先を作れるよう、ライブラリーを直接読む（H08）
pub fn copy_targets(deck_path: &std::path::Path) -> Vec<Value> {
    let mut targets = Vec::new();
    for lib in load_config() {
        for d in list_decks(&lib, false) {
            let slug = d.get("slug").and_then(|x| x.as_str()).unwrap_or("");
            let file = lib.path.join(slug).join("slides.md");
            let same = match (
                std::fs::canonicalize(&file),
                std::fs::canonicalize(deck_path),
            ) {
                (Ok(a), Ok(b)) => a == b,
                _ => file == deck_path,
            };
            if same {
                continue;
            }
            targets.push(json!({
                "lib": lib.name,
                "slug": slug,
                "title": d.get("title").cloned().unwrap_or(json!("")),
                "pages": d.get("pages").cloned().unwrap_or(json!(0)),
                "updated": d.get("updated").cloned().unwrap_or(json!(0)),
                "file": file.to_string_lossy(),
            }));
        }
    }
    targets.sort_by_key(|t| -(t.get("updated").and_then(|u| u.as_f64()).unwrap_or(0.0) as i64));
    targets
}

/// 資料の一覧（ライブラリー直下と _archive/ の下）。新しい順
pub fn list_decks(lib: &Library, archived: bool) -> Vec<Value> {
    let mut out = Vec::new();
    scan_decks(lib, &lib.path, "", archived, &mut out, 0);
    out.sort_by_key(|d| -(d.get("updated").and_then(|u| u.as_u64()).unwrap_or(0) as i64));
    out
}

fn scan_decks(
    lib: &Library,
    base: &Path,
    prefix: &str,
    archived: bool,
    out: &mut Vec<Value>,
    depth: usize,
) {
    if depth > 2 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(base) else {
        return;
    };
    for e in rd.filter_map(|e| e.ok()) {
        let name = e.file_name().to_string_lossy().to_string();
        if !e.path().is_dir() || name.starts_with('.') || name == "node_modules" {
            continue;
        }
        if name == "_archive" && prefix.is_empty() {
            if archived {
                scan_decks(lib, &e.path(), "_archive/", archived, out, depth + 1);
            }
            continue;
        }
        if e.path().join("slides.md").exists() {
            if let Ok(info) = deck_info(lib, &format!("{prefix}{name}")) {
                out.push(info);
            }
        }
    }
}

fn unique_slug(lib: &Library, want: &str) -> String {
    let base = {
        let s = slugify(want);
        if s.is_empty() {
            "new-deck".to_string()
        } else {
            s
        }
    };
    let mut s = base.clone();
    let mut n = 2;
    while lib.path.join(&s).exists() {
        s = format!("{base}-{n}");
        n += 1;
    }
    s
}

/// 除外する名前（Node 版の `[/\\](dist|\.check|\.editor-history|node_modules)([/\\]|$)` と同じ）
fn is_excluded_dir(name: &str) -> bool {
    matches!(name, "dist" | ".check" | ".editor-history" | "node_modules")
}

/// 作ったときの見本の残り（雛形からの新規作成では、Node 版と同じく `.render` で始まる名前を全部外す）
fn is_render_leftover(name: &str) -> bool {
    name.starts_with(".render")
}

/// 取り込みで外すもの（Node 版は `.render-*.html` だけ。`.render-notes.md` などは写す。review-P4-2 の must 4）
fn is_import_leftover(name: &str) -> bool {
    name.starts_with(".render-") && name.ends_with(".html")
}

fn copy_dir(src: &Path, dest: &Path, skip: &dyn Fn(&Path) -> bool) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    for e in std::fs::read_dir(src)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
    {
        let p = e.path();
        if skip(&p) {
            continue;
        }
        let to = dest.join(e.file_name());
        if p.is_dir() {
            copy_dir(&p, &to, skip)?;
        } else {
            std::fs::copy(&p, &to).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// CLI と同じ雛形を同梱ファイルからコピーする。
pub fn create_deck(kit: &Path, lib: &Library, slug: &str, title: &str, theme: &str, template: &str) -> Result<String,String> {
    let templates=crate::templates::catalog(kit)?;
    let want_template=if template.is_empty(){"talk"}else{template};
    let tpl=templates.iter().find(|t|t["name"]==want_template||t["dir"]==want_template).ok_or("型を選んでください")?;
    if !theme.is_empty() && (!theme.chars().all(|c|c.is_ascii_alphanumeric()||c=='-')||!kit.join("marp/themes").join(format!("{theme}.css")).is_file()) {return Err("テーマを選んでください".into());}
    let title=if title.is_empty(){tpl["defaultTitle"].as_str().unwrap_or("新しい資料")}else{title};
    let s=unique_slug(lib,if slug.is_empty(){title}else{slug});
    let dir=lib.path.join(&s);
    let template_dir=tpl["dir"].as_str().unwrap_or("");
    if template_dir.is_empty(){std::fs::create_dir_all(&dir).map_err(|e|e.to_string())?;}
    else { copy_dir(&kit.join("marp/templates").join(template_dir),&dir,&|p|p.file_name().is_some_and(|n|{
        let n=n.to_string_lossy();n==".check"||n=="template.json"||n=="__pycache__"||is_render_leftover(&n)
    }))?; }
    let text=crate::templates::fill(tpl["text"].as_str().unwrap_or(""),title,theme);
    crate::deck::atomic_write(&dir.join("slides.md"),text.as_bytes()).map_err(|e|e.to_string())?;
    Ok(s)
}

pub fn duplicate_deck(lib: &Library, slug: &str) -> Result<String, String> {
    let base = Path::new(slug)
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_else(|| slug.to_string());
    let s = unique_slug(lib, &format!("{base}-copy"));
    let skip = |p: &Path| {
        p.file_name()
            .map(|f| f.to_string_lossy())
            .map(|n| is_excluded_dir(&n))
            .unwrap_or(false)
    };
    copy_dir(&lib.path.join(slug), &lib.path.join(&s), &skip)?;
    Ok(s)
}

pub fn rename_deck(lib: &Library, slug: &str, to: &str) -> Result<String, String> {
    rename_deck_title(lib, slug, to, None)
}

pub fn with_title(text: &str, title: &str) -> String {
    let value = serde_json::to_string(title.trim()).unwrap_or_default();
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    if lines.first().map(String::as_str) == Some("---") {
        if let Some(end) = lines.iter().skip(1).position(|l| l == "---").map(|i| i+1) {
            if let Some(at) = lines[..end].iter().position(|l| l.starts_with("title:")) {
                lines[at] = format!("title: {value}");
            } else { lines.insert(end, format!("title: {value}")); }
            return lines.join("\n") + if text.ends_with('\n') { "\n" } else { "" };
        }
    }
    format!("---\nmarp: true\ntitle: {value}\n---\n{text}")
}

pub fn rename_deck_title(lib: &Library, slug: &str, to: &str, title: Option<&str>) -> Result<String, String> {
    let old_name = Path::new(slug).file_name().and_then(|s| s.to_str()).unwrap_or(slug);
    let name = slugify(if to.is_empty() { old_name } else { to });
    if name.is_empty() { return Err("名前を入れてください".into()); }
    let s = if slug.starts_with("_archive/") { format!("_archive/{name}") } else { name };
    let from = lib.path.join(slug);
    let dest = lib.path.join(&s);
    if s != slug && dest.exists() { return Err("同じ名前の資料があります".into()); }
    let file = from.join("slides.md");
    let original = std::fs::read_to_string(&file).map_err(|e| e.to_string())?;
    if let Some(title) = title {
        if title.trim().is_empty() { return Err("題名を入れてください".into()); }
        crate::deck::atomic_write(&file, with_title(&original,title).as_bytes()).map_err(|e| e.to_string())?;
    }
    if s != slug {
        if let Err(err) = std::fs::rename(&from, &dest) {
            if title.is_some() { crate::deck::atomic_write(&file, original.as_bytes()).map_err(|restore| format!("{err}。題名を戻せませんでした: {restore}"))?; }
            return Err(err.to_string());
        }
    }
    Ok(s)
}

pub fn trash_deck(lib: &Library, slug: &str) -> Result<(), String> {
    let from = lib.path.join(slug);
    // smoke は一時 HOME の中だけを動かす。実際の利用者のゴミ箱を検査に使わない。
    if cfg!(debug_assertions) && std::env::var_os("MARP_SMOKE_DIR").is_some()
        && home().canonicalize().is_ok_and(|p| p.starts_with("/private/tmp") || p.starts_with("/tmp")) {
        let trash = home().join(".Trash");
        std::fs::create_dir_all(&trash).map_err(|e| e.to_string())?;
        let l = Library { id: "trash".into(), name: "trash".into(), path: trash.clone() };
        let to = trash.join(unique_slug(&l, Path::new(slug).file_name().and_then(|s| s.to_str()).unwrap_or("deck")));
        return std::fs::rename(from,to).map_err(|e| e.to_string());
    }
    use objc2_foundation::{NSFileManager, NSString, NSURL};
    let url = NSURL::fileURLWithPath(&NSString::from_str(&from.to_string_lossy()));
    NSFileManager::defaultManager().trashItemAtURL_resultingItemURL_error(&url, None)
        .map_err(|e| format!("ゴミ箱へ移せませんでした: {e}"))
}

pub fn archive_deck(lib: &Library, slug: &str, restore: bool) -> Result<String, String> {
    let name = Path::new(slug)
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_else(|| slug.to_string());
    let from = lib.path.join(slug);
    let to = if restore {
        lib.path.join(&name)
    } else {
        lib.path.join("_archive").join(&name)
    };
    if to.exists() {
        return Err("移動先に同じ名前の資料があります".into());
    }
    if let Some(dir) = to.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&from, &to).map_err(|e| e.to_string())?;
    Ok(if restore {
        name
    } else {
        format!("_archive/{name}")
    })
}

/// 別の場所にある資料フォルダを取り込む（元は消さない）
pub fn import_folder(lib: &Library, src: &str, slug: &str) -> Result<String, String> {
    let src = existing_folder(src)?;
    if !src.join("slides.md").exists() {
        return Err("slides.md がありません".into());
    }
    let want = if slug.is_empty() {
        src.file_name()
            .map(|f| f.to_string_lossy().to_string())
            .unwrap_or_default()
    } else {
        slug.to_string()
    };
    let s = unique_slug(lib, &want);
    let dest = lib.path.canonicalize().map_err(|e|e.to_string())?.join(&s);
    if dest.starts_with(&src) {return Err("取り込む資料の中にコピー先を作ることはできません".into());}
    let skip = |p: &Path| {
        p.file_name()
            .map(|f| f.to_string_lossy())
            .map(|n| is_excluded_dir(&n) || is_import_leftover(&n))
            .unwrap_or(false)
    };
    copy_dir(&src, &lib.path.join(&s), &skip)?;
    Ok(s)
}

/// ライブラリーの情報（git の状態つき）
pub fn lib_info(lib: &Library) -> Value {
    let repo = crate::git::repo_root(&lib.path);
    let git = repo.as_ref().and_then(|r| {
        let inside = rel_in_repo(r, &lib.path)?;
        let info = crate::git::branch_info(Path::new(r));
        Some(json!({
            "repo": r,
            "branch": info.branch,
            "upstream": info.upstream,
            "ahead": info.ahead,
            "behind": info.behind,
            "remote": info.remote,
            "head": info.head,
            "inside": inside,
        }))
    });
    let changes = repo
        .as_ref()
        .and_then(|r| rel_in_repo(r, &lib.path).map(|rel| (r, rel)))
        .map(|(r, rel)| {
            crate::git::status(Path::new(r), &rel)
                .map(|s| s.count)
                .unwrap_or(0)
        })
        .unwrap_or(0);
    let display = {
        let h = home().to_string_lossy().to_string();
        let p = lib.path.to_string_lossy().to_string();
        if !h.is_empty() && p.starts_with(&h) {
            p.replacen(&h, "~", 1)
        } else {
            p
        }
    };
    json!({ "id": lib.id, "name": lib.name, "path": display, "git": git, "changes": changes })
}

/// リポジトリから見たライブラリーの相対パス。くいちがったら None（`.` にしてほかを巻き込まない）
pub fn rel_in_repo(repo: &str, path: &Path) -> Option<String> {
    let a = std::fs::canonicalize(repo).unwrap_or_else(|_| PathBuf::from(repo));
    let b = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let rel = b.strip_prefix(&a).ok()?.to_string_lossy().to_string();
    Some(if rel.is_empty() { ".".to_string() } else { rel })
}

/// 資料ごとの未コミットの変更（ライブラリー全体の status を1回で取って振り分ける）
pub fn deck_changes(lib: &Library) -> Map<String, Value> {
    let mut out = Map::new();
    let Some(repo) = crate::git::repo_root(&lib.path) else {
        return out;
    };
    let repo_path = PathBuf::from(&repo);
    let Some(rel) = rel_in_repo(&repo, &lib.path) else {
        return out;
    };
    let Ok(st) = crate::git::status(&repo_path, &rel) else {
        return out;
    };
    for f in st.files {
        let in_lib = if rel.is_empty() {
            f.file.clone()
        } else {
            f.file
                .strip_prefix(&format!("{rel}/"))
                .unwrap_or(&f.file)
                .to_string()
        };
        let parts: Vec<&str> = in_lib.split('/').collect();
        let slug = if parts.first() == Some(&"_archive") && parts.len() > 1 {
            format!("_archive/{}", parts[1])
        } else {
            parts[0].to_string()
        };
        let short = in_lib[slug.len().min(in_lib.len())..]
            .trim_start_matches('/')
            .to_string();
        let entry = out.entry(slug).or_insert_with(|| Value::Array(Vec::new()));
        if let Value::Array(a) = entry {
            a.push(json!({ "code": f.code, "file": short, "kind": f.kind }));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    #[test]
    fn rename_title_preserves_body_and_collision_preserves_original() {
        let dir = std::env::temp_dir().join(format!("marp-title-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let lib = Library { id: "test".into(), name: "test".into(), path: dir.clone() };
        std::fs::create_dir_all(dir.join("a")).unwrap();
        std::fs::create_dir_all(dir.join("taken")).unwrap();
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("../marp/templates/talk/slides.md");
        std::fs::copy(fixture, dir.join("a/slides.md")).unwrap();
        let original = std::fs::read_to_string(dir.join("a/slides.md")).unwrap();
        let title = "検証: \"題名\" を変更";
        assert_eq!(rename_deck_title(&lib,"a","a",Some(title)).unwrap(),"a");
        let renamed = std::fs::read_to_string(dir.join("a/slides.md")).unwrap();
        assert_eq!(front_matter(&renamed)["title"],title);
        let body = |s: &str| s.splitn(3,"---").nth(2).unwrap().to_string();
        assert_eq!(body(&original),body(&renamed));
        assert!(rename_deck_title(&lib,"a","taken",Some("失敗した題名")).is_err());
        assert_eq!(std::fs::read_to_string(dir.join("a/slides.md")).unwrap(),renamed);
        assert_eq!(rename_deck_title(&lib,"a","renamed",None).unwrap(),"renamed");
        assert_eq!(std::fs::read_to_string(dir.join("renamed/slides.md")).unwrap(),renamed);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn folder_selection_requires_an_existing_absolute_directory() {
        assert!(existing_folder("relative-library").is_err());
        assert!(existing_folder("").is_err());
        let missing=std::env::temp_dir().join(format!("marp-missing-library-{}",std::process::id()));
        assert!(!missing.exists());
        assert!(existing_folder(&missing.to_string_lossy()).is_err());
        assert!(!missing.exists());
        let fixture=Path::new(env!("CARGO_MANIFEST_DIR")).join("../marp/templates/talk");
        assert!(existing_folder(&fixture.to_string_lossy()).is_ok());
        assert!(existing_folder(&fixture.join("slides.md").to_string_lossy()).is_err());
    }

    fn node_slugify(want: &[&str]) -> Vec<String> {
        // Node 版の slugify をそのまま呼んで比べる（review-P4 の must 10）
        let js = "const slugify = (s) => String(s).normalize('NFKC').trim().replace(/[\\s/\\\\:*?\"<>|#%]+/g, '-').replace(/-+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 80);\nprocess.stdout.write(JSON.stringify(process.argv.slice(1).map(slugify)));";
        let out = Command::new(crate::hub::find_node().unwrap_or_else(|| "node".into()))
            .arg("-e")
            .arg(js)
            .args(want)
            .output()
            .expect("node を呼べない");
        serde_json::from_slice(&out.stdout).expect("Node の結果が読めない")
    }

    #[test]
    fn slugify_matches_node() {
        let emoji = "🎉".repeat(50);
        let cases: Vec<&str> = vec![
            "My Deck - v2",
            "ＡＢＣ　デッキ",
            "読書会 2026/10",
            "a  b",
            "..name..",
            "開発: 第1版 #2",
            // BOM は空白、U+0085 は空白ではない（Node の trim と \s に合わせる）
            "\u{feff}表紙\u{feff}",
            "a\u{85}b",
            // 絵文字（UTF-16 で数える切り方）
            &emoji,
        ];
        let want = node_slugify(&cases);
        for (i, c) in cases.iter().enumerate() {
            assert_eq!(slugify(c), want[i], "{c:?} で Node と違う");
        }
    }

    #[test]
    fn save_config_keeps_the_other_keys() {
        // 余分なキーがあっても消さない（SPEC §7。review-P4 の must 10）
        let dir = std::env::temp_dir().join(format!("marp-config-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("config.json");
        std::fs::write(&file, r#"{"libraries":[{"id":"a","name":"A","path":"~/Slides","theme":"paper"}],"memo":"残す"}"#).unwrap();
        std::env::set_var("JINNO_MARP_CONFIG", &file);
        let libs = vec![Library {
            id: "a".into(),
            name: "A".into(),
            path: home().join("Slides"),
        }];
        save_config(&libs).unwrap();
        let after: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(
            after.get("memo").and_then(|m| m.as_str()),
            Some("残す"),
            "ほかのキーが消えた"
        );
        assert_eq!(
            after["libraries"][0].get("theme").and_then(|m| m.as_str()),
            Some("paper"),
            "ライブラリーの余分なキーが消えた"
        );
        std::env::remove_var("JINNO_MARP_CONFIG");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_config_keeps_the_key_order() {
        // 並びを変えない（Git の差分が出ないように。review-P4-2 の should）
        let dir = std::env::temp_dir().join(format!("marp-order-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("config.json");
        std::fs::write(
            &file,
            "{\n  \"zebra\": 1,\n  \"libraries\": [],\n  \"alpha\": 2\n}\n",
        )
        .unwrap();
        std::env::set_var("JINNO_MARP_CONFIG", &file);
        save_config(&[]).unwrap();
        let text = std::fs::read_to_string(&file).unwrap();
        let z = text.find("zebra").unwrap();
        let l = text.find("libraries").unwrap();
        let a = text.find("alpha").unwrap();
        assert!(z < l && l < a, "並びが変わった:\n{text}");
        std::env::remove_var("JINNO_MARP_CONFIG");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn copies_a_deck_whose_name_contains_dist_or_render() {
        // `district-talk` のような名前でも中身が空にならない（review-P4 の must 8）
        let dir = std::env::temp_dir().join(format!("marp-dist-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let lib = Library {
            id: "l".into(),
            name: "L".into(),
            path: dir.join("lib"),
        };
        std::fs::create_dir_all(lib.path.join("district-talk/figs")).unwrap();
        std::fs::write(lib.path.join("district-talk/slides.md"), "# 地区の話\n").unwrap();
        std::fs::write(lib.path.join("district-talk/figs/a.svg"), "<svg/>").unwrap();
        let copy = duplicate_deck(&lib, "district-talk").unwrap();
        assert!(
            lib.path.join(&copy).join("slides.md").is_file(),
            "複製の中身が空: {copy}"
        );
        assert!(
            lib.path.join(&copy).join("figs/a.svg").is_file(),
            "図が複製されていない"
        );

        // 取り込みも同じ（フォルダ名に dist を含む）
        let src = dir.join("distrib/mydeck");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("slides.md"), "# 取り込み\n").unwrap();
        // `.render-notes.md`・`.render-cache/k.txt` は写す（外すのは `.render-*.html` だけ。must 4）
        std::fs::write(src.join(".render-notes.md"), "メモ\n").unwrap();
        std::fs::create_dir_all(src.join(".render-cache")).unwrap();
        std::fs::write(src.join(".render-cache/k.txt"), "かし\n").unwrap();
        std::fs::write(src.join(".render-slides.html"), "<html></html>").unwrap();
        let got = import_folder(&lib, &src.to_string_lossy(), "").unwrap();
        assert!(
            lib.path.join(&got).join("slides.md").is_file(),
            "取り込みの中身が空: {got}"
        );
        assert!(
            lib.path.join(&got).join(".render-notes.md").is_file(),
            ".render-notes.md が写らなかった"
        );
        assert!(
            lib.path.join(&got).join(".render-cache/k.txt").is_file(),
            ".render-cache が写らなかった"
        );
        assert!(
            !lib.path.join(&got).join(".render-slides.html").exists(),
            ".render-*.html が写った"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
