// 資料ごとのローカル履歴（marp/lib/history.mjs と同じ形式）。
//
// 置き場所はデッキのフォルダの .editor-history/
//   index.json      版の一覧（新しいものが後ろ）
//   objects/<sha1>  中身（同じ内容は1回だけ置く）
//
// 記録するもの（kind）: open / save / external / figure / restore / named
// 間引き：直近1日はすべて、1週間までは1時間に1つ、それより前は1日に1つ。名前付きの版と直近30件は残す。
// Node 版と Rust 版が同じフォルダを読み書きできること（片方で作った履歴をもう片方が読めること）。
use crate::hash::{random_hex, sha1_hex};
use crate::slides::{deck_title, page_delta, pages_of};
use crate::LockExt;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const KEEP_RECENT: usize = 30;
const HOUR_MS: i64 = 3600 * 1000;
const DAY_MS: i64 = 24 * HOUR_MS;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct FigureChange {
    pub path: String,
    pub before: Option<String>,
    pub after: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct DeltaJson {
    #[serde(rename = "mod")]
    pub modified: usize,
    pub add: usize,
    pub del: usize,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Entry {
    pub id: String,
    #[serde(default)]
    pub time: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub label: String,
    pub hash: Option<String>,
    #[serde(default)]
    pub pages: usize,
    #[serde(default)]
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub figures: Option<Vec<FigureChange>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delta: Option<DeltaJson>,
}

#[derive(Serialize, Deserialize)]
struct IndexFile {
    version: u32,
    entries: Vec<Entry>,
}

/// 一時ファイルの名前に付ける連番
static NEXT_TMP: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// 索引を1件ずつ読む（読めない1件は飛ばす。review-P4 の should）
fn read_entries(text: &str) -> Vec<Entry> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(text) else {
        return Vec::new();
    };
    v.get("entries")
        .and_then(|e| e.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| serde_json::from_value::<Entry>(x.clone()).ok())
                .collect()
        })
        .unwrap_or_default()
}

/// 図の変更（path, 前の中身, 後の中身）
pub type FigureBytes = (String, Option<Vec<u8>>, Option<Vec<u8>>);

pub struct History {
    dir: PathBuf,
    obj_dir: PathBuf,
    index_file: PathBuf,
    deck_file: String,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    entries: Vec<Entry>,
    loaded: bool,
    removed: HashSet<String>,
    pinned: HashSet<String>,
}

impl History {
    pub fn open(deck_dir: &Path, deck_file: &str) -> History {
        let dir = deck_dir.join(".editor-history");
        History {
            obj_dir: dir.join("objects"),
            index_file: dir.join("index.json"),
            dir,
            deck_file: deck_file.to_string(),
            state: Mutex::new(State::default()),
        }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn load(&self, st: &mut State) -> Result<(), String> {
        if st.loaded {
            return Ok(());
        }
        fs::create_dir_all(&self.obj_dir).map_err(|e| e.to_string())?;
        // 1件ずつ読む（欠けた項目があっても、そこだけ飛ばしてほかの版は残す）
        st.entries = match fs::read_to_string(&self.index_file) {
            Ok(s) => read_entries(&s),
            Err(_) => Vec::new(),
        };
        st.loaded = true;
        self.migrate_legacy(st);
        Ok(())
    }

    /// 以前の形式（保存の直前の版を <日時>.md で残していた）を取り込む
    fn migrate_legacy(&self, st: &mut State) {
        let mut olds: Vec<String> = fs::read_dir(&self.dir)
            .map(|rd| {
                rd.filter_map(|e| e.ok())
                    .filter_map(|e| e.file_name().into_string().ok())
                    .filter(|f| {
                        f.len() > 20 && f.ends_with(".md") && f.starts_with("20") && f.contains('T')
                    })
                    .collect()
            })
            .unwrap_or_default();
        if olds.is_empty() {
            return;
        }
        olds.sort();
        let mut prev: Option<String> = None;
        for f in olds {
            let Ok(text) = fs::read_to_string(self.dir.join(&f)) else {
                continue;
            };
            let iso = f.trim_end_matches(".md").to_string();
            let iso = legacy_time_to_iso(&iso);
            let h = self.put_object(st, text.as_bytes());
            if Some(h.clone()) != prev {
                let ms = parse_iso_millis(&iso).unwrap_or(0);
                st.entries.push(Entry {
                    id: format!("{}-{}", to_base36(ms), random_hex(6)),
                    time: iso.clone(),
                    kind: "save".into(),
                    label: "保存（以前の履歴から取り込み）".into(),
                    hash: Some(h.clone()),
                    pages: pages_of(&text).len(),
                    title: deck_title(&text),
                    figures: None,
                    delta: None,
                });
            }
            prev = Some(h);
            let _ = fs::remove_file(self.dir.join(&f));
        }
        st.entries.sort_by(|a, b| a.time.cmp(&b.time));
        let _ = self.write_index(st);
    }

    fn put_object(&self, st: &mut State, content: &[u8]) -> String {
        let _ = st;
        let h = sha1_hex(content);
        let f = self.obj_dir.join(&h);
        let needs_write = match fs::read(&f) {
            Ok(old) => old.len() != content.len() || sha1_hex(&old) != h,
            Err(_) => true,
        };
        if needs_write {
            // 途中で落ちても欠けた版が残らないよう、一時ファイルに書いてから rename する（D11）
            let serial = NEXT_TMP.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let tmp = self.obj_dir.join(format!(
                ".tmp-{}-{}-{serial}",
                std::process::id(),
                now_millis()
            ));
            if fs::write(&tmp, content).is_ok() {
                let _ = fs::rename(&tmp, &f);
            }
            let _ = fs::remove_file(&tmp);
        }
        h
    }

    /// 開いている資料の現在の図は、メモリに本体を持たず中身のハッシュだけを覚える。
    pub fn pin_figure(&self, bytes: &[u8]) -> String {
        let mut state = self.state.lock_ok();
        let _ = self.load(&mut state);
        let hash = self.put_object(&mut state, bytes);
        state.pinned.insert(hash.clone());
        hash
    }

    fn read_object(&self, h: &str) -> Result<Vec<u8>, String> {
        let bytes = fs::read(self.obj_dir.join(h)).map_err(|e| e.to_string())?;
        if sha1_hex(&bytes) != h {
            return Err("履歴の中身が壊れています".into());
        }
        Ok(bytes)
    }

    /// 書く前にファイルを読み直して、ほかのプロセス（別のエディター・送り出し）の記録と合わせる
    fn write_index(&self, st: &mut State) -> Result<(), String> {
        let disk: Vec<Entry> = fs::read_to_string(&self.index_file)
            .map(|s| read_entries(&s))
            .unwrap_or_default();
        let mut by_id: Vec<Entry> = disk
            .into_iter()
            .filter(|e| !st.removed.contains(&e.id))
            .collect();
        for e in st.entries.iter() {
            match by_id.iter_mut().find(|x| x.id == e.id) {
                Some(slot) => *slot = e.clone(),
                None => by_id.push(e.clone()),
            }
        }
        by_id.sort_by(|a, b| a.time.cmp(&b.time));
        st.entries = by_id;
        let body = serde_json::to_string_pretty(&IndexFile {
            version: 1,
            entries: st.entries.clone(),
        })
        .map_err(|e| e.to_string())?;
        // 一時ファイルの名前は、同じ process で同じフォルダの履歴を複数扱ってもぶつからないようにする
        let serial = NEXT_TMP.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let tmp = self.index_file.with_extension(format!(
            "json.{}.{}.{}.tmp",
            std::process::id(),
            now_millis(),
            serial
        ));
        fs::write(&tmp, body).map_err(|e| e.to_string())?;
        fs::rename(&tmp, &self.index_file).map_err(|e| e.to_string())
    }

    fn latest_deck(&self, st: &State) -> Option<Entry> {
        st.entries.iter().rev().find(|e| e.hash.is_some()).cloned()
    }

    fn make_entry(&self, fields: EntryFields) -> Entry {
        let time = fields.time.unwrap_or_else(iso_now);
        let ms = parse_iso_millis(&time).unwrap_or(0);
        Entry {
            id: format!("{}-{}", to_base36(ms), random_hex(6)),
            time,
            kind: fields.kind,
            label: fields.label,
            hash: fields.hash,
            pages: pages_of(&fields.text).len(),
            title: deck_title(&fields.text),
            figures: fields.figures,
            delta: fields.delta,
        }
    }

    /// slides.md の版を残す。前の版と同じなら何もしない（名前付きは同じでも残す）
    pub fn record(&self, text: &str, kind: &str, label: &str) -> Result<Option<Entry>, String> {
        let mut st = self.state.lock_ok();
        self.load(&mut st)?;
        let h = self.put_object(&mut st, text.as_bytes());
        let last = self.latest_deck(&st);
        if let Some(l) = &last {
            if l.hash.as_deref() == Some(h.as_str()) && kind != "named" {
                return Ok(None);
            }
        }
        let delta = last.as_ref().map(|l| self.delta_against(&st, l, text));
        let e = self.make_entry(EntryFields {
            kind: kind.into(),
            label: label.into(),
            hash: Some(h),
            text: text.into(),
            time: None,
            figures: None,
            delta,
        });
        st.entries.push(e.clone());
        self.prune(&mut st);
        self.write_index(&mut st)?;
        drop(st);
        let _ = self.gc();
        Ok(Some(e))
    }

    fn delta_against(&self, _st: &State, last: &Entry, text: &str) -> DeltaJson {
        let prev = last
            .hash
            .as_ref()
            .and_then(|h| self.read_object(h).ok())
            .map(|b| String::from_utf8_lossy(&b).to_string())
            .unwrap_or_default();
        let d = page_delta(&prev, text);
        DeltaJson {
            modified: d.modified,
            add: d.added,
            del: d.deleted,
        }
    }

    /// 図の変更を残す。changes は (path, before, after)
    pub fn record_figures(
        &self,
        changes: Vec<FigureBytes>,
        label: &str,
    ) -> Result<Option<Entry>, String> {
        let mut st = self.state.lock_ok();
        self.load(&mut st)?;
        let mut figures = Vec::new();
        for (path, before, after) in changes {
            let b = before.map(|x| self.put_object(&mut st, &x));
            let a = after.map(|x| self.put_object(&mut st, &x));
            if b != a {
                figures.push(FigureChange {
                    path,
                    before: b,
                    after: a,
                });
            }
        }
        if figures.is_empty() {
            return Ok(None);
        }
        let last = self.latest_deck(&st);
        let text = last
            .as_ref()
            .and_then(|l| l.hash.as_ref())
            .and_then(|h| self.read_object(h).ok())
            .map(|b| String::from_utf8_lossy(&b).to_string())
            .unwrap_or_default();
        let label = if label.is_empty() {
            if figures.len() == 1 {
                figures[0].path.clone()
            } else {
                format!("図 {}枚", figures.len())
            }
        } else {
            label.to_string()
        };
        let e = self.make_entry(EntryFields {
            kind: "figure".into(),
            label,
            hash: last.and_then(|l| l.hash),
            text,
            time: None,
            figures: Some(figures),
            delta: None,
        });
        st.entries.push(e.clone());
        self.prune(&mut st);
        self.write_index(&mut st)?;
        drop(st);
        let _ = self.gc();
        Ok(Some(e))
    }

    fn prune(&self, st: &mut State) {
        let now = now_millis();
        let keep: HashSet<String> = st
            .entries
            .iter()
            .rev()
            .take(KEEP_RECENT)
            .map(|e| e.id.clone())
            .collect();
        let mut buckets: HashSet<String> = HashSet::new();
        let mut i = st.entries.len();
        while i > 0 {
            i -= 1;
            let e = &st.entries[i];
            if e.kind == "named" || keep.contains(&e.id) {
                continue;
            }
            let age = now - parse_iso_millis(&e.time).unwrap_or(now);
            if age < DAY_MS {
                continue;
            }
            let bucket = if age < 7 * DAY_MS {
                format!("h{}", parse_iso_millis(&e.time).unwrap_or(0) / HOUR_MS)
            } else {
                format!("d{}", parse_iso_millis(&e.time).unwrap_or(0) / DAY_MS)
            };
            // 本文と、別の図の変更を同じ時間帯という理由で消さない。
            let kind = e
                .figures
                .as_ref()
                .map(|figures| {
                    let mut paths: Vec<_> = figures.iter().map(|f| f.path.as_str()).collect();
                    paths.sort();
                    paths.join("\n")
                })
                .unwrap_or_else(|| "text".into());
            let key = format!("{bucket}:{kind}");
            if buckets.contains(&key) {
                st.removed.insert(e.id.clone());
                st.entries.remove(i);
            } else {
                buckets.insert(key);
            }
        }
    }

    /// どの版からも指されていない中身を消す
    pub fn gc(&self) -> Result<(), String> {
        let mut st = self.state.lock_ok();
        self.load(&mut st)?;
        let mut used: HashSet<String> = st.pinned.clone();
        let disk = fs::read_to_string(&self.index_file)
            .map(|s| read_entries(&s))
            .unwrap_or_default();
        for e in st.entries.iter().chain(disk.iter()) {
            if let Some(h) = &e.hash {
                used.insert(h.clone());
            }
            for f in e.figures.iter().flatten() {
                if let Some(b) = &f.before {
                    used.insert(b.clone());
                }
                if let Some(a) = &f.after {
                    used.insert(a.clone());
                }
            }
        }
        for f in fs::read_dir(&self.obj_dir)
            .map_err(|e| e.to_string())?
            .filter_map(|e| e.ok())
        {
            if let Ok(name) = f.file_name().into_string() {
                // 別プロセスがまだ索引へ登録していない中身には24時間の猶予を置く。
                // 書き途中の .tmp-* は削除対象にしない。
                let old = f
                    .metadata()
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.elapsed().ok())
                    .is_some_and(|age| age.as_secs() > 24 * 60 * 60);
                if name.len() == 40
                    && name.bytes().all(|c| c.is_ascii_hexdigit())
                    && old
                    && !used.contains(&name)
                {
                    let _ = fs::remove_file(f.path());
                }
            }
        }
        Ok(())
    }

    /// 新しい順（Node 版の list() と同じ）
    pub fn list(&self) -> Result<Vec<Entry>, String> {
        let mut st = self.state.lock_ok();
        self.load(&mut st)?;
        if let Ok(s) = fs::read_to_string(&self.index_file) {
            if let Ok(idx) = serde_json::from_str::<IndexFile>(&s) {
                let mut merged = st.entries.clone();
                for e in idx.entries {
                    if !merged.iter().any(|x| x.id == e.id) && !st.removed.contains(&e.id) {
                        merged.push(e);
                    }
                }
                merged.sort_by(|a, b| a.time.cmp(&b.time));
                st.entries = merged;
            }
        }
        let mut out = st.entries.clone();
        out.reverse();
        Ok(out)
    }

    pub fn get(&self, id: &str) -> Option<Entry> {
        let mut st = self.state.lock_ok();
        let _ = self.load(&mut st);
        st.entries.iter().find(|e| e.id == id).cloned()
    }

    pub fn text(&self, id: &str) -> Option<String> {
        let e = self.get(id)?;
        let h = e.hash?;
        self.read_object(&h)
            .ok()
            .map(|b| String::from_utf8_lossy(&b).to_string())
    }

    pub fn object(&self, h: &str) -> Result<Vec<u8>, String> {
        if h.len() != 40 || !h.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err("不正な指定です".into());
        }
        self.read_object(h)
    }

    pub fn rename(&self, id: &str, label: &str) -> Option<Entry> {
        let mut st = self.state.lock_ok();
        let _ = self.load(&mut st);
        let idx = st.entries.iter().position(|e| e.id == id)?;
        {
            let e = &mut st.entries[idx];
            e.label = label.to_string();
            if !label.is_empty() && e.kind != "named" {
                e.kind = "named".into();
            }
        }
        let e = st.entries[idx].clone();
        let _ = self.write_index(&mut st);
        Some(e)
    }

    /// 直近の中身のハッシュ（保存の競合の検出に使う）
    pub fn deck_file_name(&self) -> &str {
        &self.deck_file
    }
}

struct EntryFields {
    kind: String,
    label: String,
    hash: Option<String>,
    text: String,
    time: Option<String>,
    figures: Option<Vec<FigureChange>>,
    delta: Option<DeltaJson>,
}

// --- 時刻（Node の new Date().toISOString() と同じ形にする） --------------------------------
fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn iso_now() -> String {
    iso_from_millis(now_millis())
}

pub fn iso_from_millis(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000);
    let days = secs.div_euclid(86400);
    let sod = secs.rem_euclid(86400);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        sod / 3600,
        (sod % 3600) / 60,
        sod % 60
    )
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// ISO 8601（...Z）をミリ秒に。読めなければ None
pub fn parse_iso_millis(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' {
        return None;
    }
    let num = |a: usize, z: usize| s.get(a..z)?.parse::<i64>().ok();
    let (y, mo, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (h, mi, se) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    let ms = if b.len() >= 23 && b[19] == b'.' {
        num(20, 23).unwrap_or(0)
    } else {
        0
    };
    let days = days_from_civil(y, mo as u32, d as u32);
    Some(days * 86_400_000 + h * 3_600_000 + mi * 60_000 + se * 1000 + ms)
}

fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 } as i64;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// JS の Number.toString(36) と同じ
fn to_base36(mut n: i64) -> String {
    if n == 0 {
        return "0".into();
    }
    let neg = n < 0;
    if neg {
        n = -n;
    }
    let digits = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    while n > 0 {
        out.push(digits[(n % 36) as usize]);
        n /= 36;
    }
    if neg {
        out.push(b'-');
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

/// `2026-10-12T02-30-00-000Z` のような古い名前に戻す（取り込み用）
fn legacy_time_to_iso(name: &str) -> String {
    let s = name.trim_end_matches(".md");
    // 末尾の T HH-MM-SS-mmm Z を T HH:MM:SS.mmmZ に
    if let Some(pos) = s.rfind('T') {
        let tail = &s[pos + 1..];
        let parts: Vec<&str> = tail.trim_end_matches('Z').split('-').collect();
        if parts.len() == 4 {
            return format!(
                "{}T{}:{}:{}.{}Z",
                &s[..pos],
                parts[0],
                parts[1],
                parts[2],
                parts[3]
            );
        }
    }
    format!("{s}Z")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("marp-history-test-{}-{}", name, random_hex(6)));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn gc_keeps_inflight_objects_and_temporary_files() {
        let dir = tmp_dir("gc-inflight");
        let h = History::open(&dir, "slides.md");
        h.record("# saved", "save", "").unwrap();
        let fresh = h.obj_dir.join(sha1_hex(b"inflight"));
        let stale = h.obj_dir.join(sha1_hex(b"orphan"));
        let tmp = h.obj_dir.join(".tmp-in-progress");
        for file in [&fresh, &stale, &tmp] {
            fs::write(file, "data").unwrap();
        }
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(2 * 24 * 3600);
        fs::File::options()
            .write(true)
            .open(&stale)
            .unwrap()
            .set_modified(old)
            .unwrap();
        h.gc().unwrap();
        assert!(fresh.exists());
        assert!(tmp.exists());
        assert!(!stale.exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn broken_object_is_not_read_as_a_version() {
        let dir = tmp_dir("broken");
        let deck = dir.join("slides.md");
        fs::write(&deck, "# あ\n").unwrap();
        let h = History::open(&dir, "slides.md");
        let e = h.record("# あ\n", "open", "").unwrap().unwrap();
        let hash = e.hash.unwrap();
        fs::write(h.obj_dir.join(&hash), b"broken").unwrap();
        assert!(h.text(&e.id).is_none(), "壊れた中身を版として読んでいる");
    }

    #[test]
    fn records_and_lists_like_the_node_version() {
        let dir = tmp_dir("record");
        let deck = dir.join("slides.md");
        fs::write(
            &deck,
            "---\nmarp: true\ntitle: テスト\n---\n\n# あ\n\n本文\n",
        )
        .unwrap();
        let h = History::open(&dir, "slides.md");
        let e1 = h.record("# あ\n\n本文", "open", "").unwrap().unwrap();
        assert_eq!(e1.kind, "open");
        assert_eq!(e1.pages, 1);
        assert_eq!(e1.title, "");
        // 同じ内容は記録しない
        assert!(h.record("# あ\n\n本文", "open", "").unwrap().is_none());
        // 変わったら記録する（delta が付く）
        let e2 = h
            .record("# あ\n\n本文を直した", "save", "")
            .unwrap()
            .unwrap();
        assert_eq!(e2.kind, "save");
        assert_eq!(e2.delta.as_ref().unwrap().modified, 1);
        let list = h.list().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].id, e2.id, "新しい順に並ぶ");
        // index.json の形（Node 版と同じキー）
        let raw = fs::read_to_string(dir.join(".editor-history/index.json")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["version"], 1);
        assert!(v["entries"][0]["id"].is_string());
        assert!(v["entries"][0]["time"].as_str().unwrap().ends_with('Z'));
        assert!(v["entries"][1]["delta"]["mod"].is_number());
        // 中身は sha1 の名前で置く
        let obj = dir
            .join(".editor-history/objects")
            .join(sha1_hex("# あ\n\n本文を直した".as_bytes()));
        assert!(obj.exists());
        assert_eq!(h.text(&e2.id).unwrap(), "# あ\n\n本文を直した");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn reads_the_format_the_node_version_writes() {
        let dir = tmp_dir("node-format");
        let hist = dir.join(".editor-history");
        fs::create_dir_all(hist.join("objects")).unwrap();
        let text = "# ノードで作った版\n\n本文\n";
        let hash = sha1_hex(text.as_bytes());
        fs::write(hist.join("objects").join(&hash), text).unwrap();
        // Node 版（history.mjs）が書く形をそのまま置く
        let index = format!(
            "{{\n \"version\": 1,\n \"entries\": [\n  {{\n   \"id\": \"m1abc-0f0f0f\",\n   \"time\": \"2026-10-11T23:00:00.000Z\",\n   \"kind\": \"save\",\n   \"label\": \"\",\n   \"hash\": \"{hash}\",\n   \"pages\": 1,\n   \"title\": \"\",\n   \"delta\": {{ \"mod\": 0, \"add\": 0, \"del\": 0 }}\n  }}\n ]\n}}"
        );
        fs::write(hist.join("index.json"), index).unwrap();
        let h = History::open(&dir, "slides.md");
        let list = h.list().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "m1abc-0f0f0f");
        assert_eq!(list[0].pages, 1);
        assert_eq!(h.text("m1abc-0f0f0f").unwrap(), text);
        // Rust で1件足しても、Node が書いた版は消えない
        h.record("# 追加\n", "save", "").unwrap();
        let list = h.list().unwrap();
        assert_eq!(list.len(), 2);
        assert!(list.iter().any(|e| e.id == "m1abc-0f0f0f"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn figure_changes_are_recorded() {
        let dir = tmp_dir("figures");
        let h = History::open(&dir, "slides.md");
        h.record("# あ\n", "save", "").unwrap();
        let e = h
            .record_figures(
                vec![(
                    "figs/a.svg".into(),
                    Some(b"<svg/>".to_vec()),
                    Some(b"<svg id=\"x\"/>".to_vec()),
                )],
                "",
            )
            .unwrap()
            .unwrap();
        assert_eq!(e.kind, "figure");
        assert_eq!(e.figures.as_ref().unwrap().len(), 1);
        assert_eq!(e.label, "figs/a.svg");
        // 変わっていなければ記録しない
        assert!(h
            .record_figures(
                vec![(
                    "figs/a.svg".into(),
                    Some(b"x".to_vec()),
                    Some(b"x".to_vec())
                )],
                ""
            )
            .unwrap()
            .is_none());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn time_and_base36_match_node() {
        // Node: new Date(1760000000000).toISOString() === "2025-10-09T08:53:20.000Z"
        assert_eq!(iso_from_millis(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            iso_from_millis(1_760_000_000_000),
            "2025-10-09T08:53:20.000Z"
        );
        assert_eq!(
            iso_from_millis(1_760_220_000_000),
            "2025-10-11T22:00:00.000Z"
        );
        // Node: Date.parse("2026-10-11T23:00:00.000Z") === 1791759600000
        assert_eq!(
            parse_iso_millis("2026-10-11T23:00:00.000Z"),
            Some(1_791_759_600_000)
        );
        // Node: (1760220000000).toString(36) === "mgmtjgg0"
        assert_eq!(to_base36(1_760_220_000_000), "mgmtjgg0");
    }
}

#[cfg(test)]
mod interop_tests {
    //! Node 版（marp/lib/history.mjs）と Rust 版が、同じフォルダを読み書きできることを確かめる。
    //! node が無い環境では飛ばす。
    use super::*;
    use std::process::Command;

    fn node_ok() -> bool {
        Command::new("node")
            .arg("-e")
            .arg("process.exit(0)")
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    fn kit_root() -> PathBuf {
        // src-tauri/ の1つ上（このテストは cargo test で走る）
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf()
    }

    /// Node 版で1件の版を残す（-e で history.mjs を読み込んで record する）
    fn node_record(deck_dir: &Path, text: &str, kind: &str) -> bool {
        let script = format!(
            "import('{}/marp/lib/history.mjs').then(async (m) => {{ const h = m.openHistory('{}', 'slides.md'); await h.record({}, {{ kind: '{}', label: 'ノードから' }}); }});",
            kit_root().display(),
            deck_dir.display(),
            serde_json::to_string(text).unwrap(),
            kind
        );
        Command::new("node")
            .arg("-e")
            .arg(script)
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    /// Node 版で一覧を読む（JSON で出す）
    fn node_list(deck_dir: &Path) -> String {
        let script = format!(
            "import('{}/marp/lib/history.mjs').then(async (m) => {{ const h = m.openHistory('{}', 'slides.md'); const list = await h.list(); console.log(JSON.stringify(list.map((e) => ({{ id: e.id, kind: e.kind, label: e.label, hash: e.hash, pages: e.pages }})))); }});",
            kit_root().display(),
            deck_dir.display()
        );
        let out = Command::new("node").arg("-e").arg(script).output().unwrap();
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    #[test]
    fn node_and_rust_share_the_same_history_folder() {
        if !node_ok() {
            eprintln!("node が無いので飛ばします");
            return;
        }
        let dir = std::env::temp_dir().join(format!("marp-history-interop-{}", random_hex(6)));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("slides.md"), "# あ\n").unwrap();

        // 1) Node で版を残す → Rust で読める
        assert!(
            node_record(&dir, "# あ\n\nノードが残した版\n", "save"),
            "Node で記録できません"
        );
        let h = History::open(&dir, "slides.md");
        let list = h.list().unwrap();
        assert_eq!(list.len(), 1, "Rust から Node の版が見えません: {list:?}");
        let id = list[0].id.clone();
        assert_eq!(list[0].label, "ノードから");
        assert_eq!(h.text(&id).unwrap(), "# あ\n\nノードが残した版\n");

        // 2) Rust で版を足す → Node から読める
        h.record("# あ\n\nRust が残した版\n", "save", "ラスト")
            .unwrap();
        let json = node_list(&dir);
        let parsed: serde_json::Value = serde_json::from_str(&json)
            .unwrap_or_else(|e| panic!("Node の出力を読めません: {e} / {json}"));
        let items = parsed.as_array().cloned().unwrap_or_default();
        assert_eq!(items.len(), 2, "Node から Rust の版が見えません: {json}");
        assert!(
            items.iter().any(|e| e["label"] == "ラスト"),
            "Rust が書いた label が Node から見えません: {json}"
        );
        assert!(
            items.iter().any(|e| e["id"] == id),
            "Node が書いた版が消えています: {json}"
        );

        // 3) 中身も Node から読める
        let script = format!(
            "import('{}/marp/lib/history.mjs').then(async (m) => {{ const h = m.openHistory('{}', 'slides.md'); const list = await h.list(); console.log(await h.text(list[0].id)); }});",
            kit_root().display(),
            dir.display()
        );
        let out = Command::new("node").arg("-e").arg(script).output().unwrap();
        let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
        assert_eq!(
            text, "# あ\n\nRust が残した版",
            "Node から Rust の中身を読めません"
        );

        let _ = fs::remove_dir_all(&dir);
    }
}
