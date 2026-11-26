// Marp キットのフォルダと Node の場所を探す。
//
// P4 からは、ライブラリーもエディターもアプリ自身（Rust）が受け持つので、
// Node のハブを子の process で起こすことはしない。Node を呼ぶのは、
// 検査・PDF・PowerPoint のときだけ。
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// 配布用は同梱した版だけを使う。開発中だけ MARP_ROOT または作業フォルダを使う。
pub fn find_root() -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    if let Ok(v) = std::env::var("MARP_ROOT") {
        let p = PathBuf::from(v);
        if p.join("marp/hub/server.mjs").is_file() {
            return Ok(p);
        }
    }
    let resource = std::env::var_os("MARP_RESOURCE_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::current_exe()
                .ok()?
                .parent()?
                .parent()
                .map(|p| p.join("Resources"))
        });
    if let Some(root) = resource.map(|p| p.join("kit")).filter(|p| packaged(p)) {
        return Ok(root);
    }
    #[cfg(debug_assertions)]
    for start in [std::env::current_exe().ok(), std::env::current_dir().ok()]
        .into_iter()
        .flatten()
    {
        if let Some(p) = start
            .ancestors()
            .take(12)
            .find(|p| p.join("marp/hub/server.mjs").is_file())
        {
            return Ok(p.to_path_buf());
        }
    }
    Err(
        "アプリに必要なファイルが見つかりません。MarpKit をもう一度インストールしてください。"
            .into(),
    )
}

pub fn packaged(root: &std::path::Path) -> bool {
    let manifest = std::fs::read(root.join("manifest.json"))
        .ok()
        .and_then(|s| serde_json::from_slice::<serde_json::Value>(&s).ok());
    manifest
        .as_ref()
        .and_then(|m| m.get("api"))
        .and_then(|v| v.as_u64())
        == Some(1)
        && root.join("marp/editor/client/index.html").is_file()
        && root.join(".check/rust-bundle/app.js").is_file()
}

/// GUI から起動すると PATH が短いので、PATH とよくあるインストール先から node を探す。
/// 結果は起動中に一度だけ調べて覚える（E02）。
static NODE_CACHE: std::sync::OnceLock<Option<PathBuf>> = std::sync::OnceLock::new();

pub fn find_node() -> Option<PathBuf> {
    NODE_CACHE.get_or_init(find_node_uncached).clone()
}

fn find_node_uncached() -> Option<PathBuf> {
    if let Ok(v) = std::env::var("MARP_NODE") {
        let p = PathBuf::from(v);
        if p.is_file() {
            return Some(p);
        }
    }
    for f in [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
    ] {
        let p = PathBuf::from(f);
        if p.is_file() {
            return Some(p);
        }
    }
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            let p = dir.join("node");
            if p.is_file() {
                return Some(p);
            }
        }
    }
    for base in ["/opt/homebrew/opt", "/usr/local/opt"] {
        if let Some(p) = find_versioned_node(std::path::Path::new(base), Some("node@")) {
            return Some(p);
        }
    }
    if let Some(nvm) = std::env::var_os("NVM_DIR") {
        if let Some(p) = find_versioned_node(&PathBuf::from(nvm).join("versions/node"), None) {
            return Some(p);
        }
    }
    let home = std::env::var("HOME").ok()?;
    find_node_in_home(std::path::Path::new(&home))
}

/// ホームの下の node（volta・pnpm・nvm・fnm・mise・asdf）を探す。テストからも使う。
fn find_node_in_home(home: &std::path::Path) -> Option<PathBuf> {
    for pat in [".volta/bin/node", ".local/bin/node", "Library/pnpm/node"] {
        let p = home.join(pat);
        if p.is_file() {
            return Some(p);
        }
    }
    for base in [
        ".nvm/versions/node",
        ".nodenv/versions",
        ".local/share/fnm/node-versions",
        "Library/Application Support/fnm/node-versions",
        ".local/share/mise/installs/node",
        ".asdf/installs/nodejs",
    ] {
        if let Some(p) = find_versioned_node(&home.join(base), None) {
            return Some(p);
        }
    }
    None
}

fn find_versioned_node(base: &std::path::Path, prefix: Option<&str>) -> Option<PathBuf> {
    let mut versions: Vec<PathBuf> = std::fs::read_dir(base)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            prefix.map_or(true, |pre| {
                p.file_name()
                    .is_some_and(|n| n.to_string_lossy().starts_with(pre))
            })
        })
        .collect();
    versions.sort_by_key(|p| {
        p.file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .split(|c: char| !c.is_ascii_digit())
            .filter_map(|n| n.parse::<u64>().ok())
            .collect::<Vec<_>>()
    });
    for version in versions.into_iter().rev() {
        for rel in ["bin/node", "installation/bin/node"] {
            let p = version.join(rel);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

/// GUI から起動したときの短い PATH に、node のフォルダを先頭へ足す。
/// `node_modules/.bin/marp` は `#!/usr/bin/env node` なので、これが無いと書き出しが落ちる（E01）。
pub fn path_with_node(node: &std::path::Path) -> std::ffi::OsString {
    let mut parts: Vec<PathBuf> = Vec::new();
    if let Some(dir) = node.parent() {
        parts.push(dir.to_path_buf());
    }
    if let Ok(p) = std::env::var("PATH") {
        parts.extend(std::env::split_paths(&p));
    }
    for p in [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ] {
        let p = PathBuf::from(p);
        if !parts.iter().any(|x| x == &p) {
            parts.push(p);
        }
    }
    std::env::join_paths(parts).unwrap_or_else(|_| std::ffi::OsString::from("/usr/bin:/bin"))
}

/// GUI から起動したときの PATH（node のフォルダを先頭に足す。git もこれを使う）
pub fn gui_path() -> std::ffi::OsString {
    match find_node() {
        Some(node) => path_with_node(&node),
        None => std::env::var_os("PATH").unwrap_or_else(|| "/usr/bin:/bin:/usr/sbin:/sbin".into()),
    }
}

/// Chrome の場所（CHROME_PATH・アプリのフォルダ・ホームの Applications を見る）
pub fn find_chrome() -> Option<PathBuf> {
    if let Ok(v) = std::env::var("CHROME_PATH") {
        let p = PathBuf::from(v);
        if p.is_file() {
            return Some(p);
        }
    }
    let home = std::env::var("HOME").ok();
    let mut candidates = vec![
        PathBuf::from("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        PathBuf::from("/Applications/Chromium.app/Contents/MacOS/Chromium"),
    ];
    if let Some(home) = home {
        candidates.push(
            PathBuf::from(&home)
                .join("Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        );
        candidates
            .push(PathBuf::from(&home).join("Applications/Chromium.app/Contents/MacOS/Chromium"));
    }
    candidates.into_iter().find(|p| p.is_file())
}

/// Node を呼ぶときのコマンド（見つかれば絶対パスで、PATH と CHROME_PATH も整える）
pub fn node_command() -> std::process::Command {
    if std::env::var("MARP_FORBID_NODE").as_deref() == Ok("1") {
        use std::io::Write;
        eprintln!("MARP_FORBID_NODE: Node の呼び出しを拒否しました");
        if let Ok(home) = std::env::var("HOME") {
            let dir = PathBuf::from(home).join("Library/Application Support/jp.jinno.marp-kit");
            let _ = std::fs::create_dir_all(&dir);
            if let Ok(mut file) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(dir.join("forbidden-node.log"))
            {
                let _ = writeln!(file, "{} Node invocation blocked", crate::deck::now_ms());
            }
        }
        return std::process::Command::new("/__marpkit_node_forbidden__");
    }
    let node = find_node();
    let mut cmd = match &node {
        Some(p) => std::process::Command::new(p),
        None => std::process::Command::new("node"),
    };
    if let Some(p) = &node {
        cmd.env("PATH", path_with_node(p));
    } else if let Ok(p) = std::env::var("PATH") {
        cmd.env("PATH", p);
    }
    if let Some(chrome) = find_chrome() {
        cmd.env("CHROME_PATH", chrome);
    }
    cmd
}

/// 子の process をプロセスグループで起こし、上限の時間が来たら SIGTERM、5秒後に SIGKILL する（E03）。
pub struct CommandOutput {
    pub status: std::process::ExitStatus,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub timed_out: bool,
    pub cancelled: bool,
}

// 子が setsid した Chrome も追跡する。PID の再利用に備え、開始日時まで一致する子だけに送る。
fn process_tree() -> Vec<(i32, i32, String)> {
    let Ok(out) = std::process::Command::new("/bin/ps")
        .args(["-axo", "pid=,ppid=,lstart="])
        .output()
    else {
        return Vec::new();
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let pid = fields.next()?.parse().ok()?;
            let parent = fields.next()?.parse().ok()?;
            Some((pid, parent, fields.collect::<Vec<_>>().join(" ")))
        })
        .collect()
}

fn track_children(pid: i32, known: &mut std::collections::HashMap<i32, String>) {
    let processes = process_tree();
    if known.get(&pid).is_some_and(|start| {
        !processes
            .iter()
            .any(|(id, _, current)| *id == pid && current == start)
    }) {
        return;
    }
    let mut parents = std::collections::HashSet::from([pid]);
    // 既に見つけた子が親から離れたあとに作った孫も追う。
    for (id, _, start) in &processes {
        if known.get(id) == Some(start) {
            parents.insert(*id);
        }
    }
    loop {
        let before = parents.len();
        for (id, parent, start) in &processes {
            if *id == pid || parents.contains(parent) {
                parents.insert(*id);
                known.entry(*id).or_insert_with(|| start.clone());
            }
        }
        if parents.len() == before {
            break;
        }
    }
}

fn signal_children(known: &std::collections::HashMap<i32, String>, signal: i32) -> usize {
    let mut alive = 0;
    for (pid, _, start) in process_tree() {
        if known.get(&pid) == Some(&start) {
            alive += 1;
            unsafe {
                libc::kill(pid, signal);
            }
        }
    }
    alive
}

/// 書き出しの「やめる」用。cancel が立ったら子と孫を止める（E03）
pub fn run_with_cancel(
    mut cmd: std::process::Command,
    timeout: Duration,
    cancel: Option<std::sync::Arc<AtomicBool>>,
) -> Result<CommandOutput, String> {
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    // Chrome の補助プロセスが出力先を継承しても、親の終了後に EOF を待ち続けない。
    // 終了コードは親から受け取り、親が書き終えた出力を独立したファイルから読む。
    struct Capture(PathBuf);
    impl Drop for Capture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    static NEXT_CAPTURE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let capture_path = std::env::temp_dir().join(format!(
        "marp-command-{}-{}-{}",
        std::process::id(),
        NEXT_CAPTURE.fetch_add(1, Ordering::Relaxed),
        crate::hash::random_hex(24)
    ));
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&capture_path)
        .map_err(|e| e.to_string())?;
    let capture = Capture(capture_path);
    let output_file = |name| {
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(capture.0.join(name))
            .map_err(|e| e.to_string())
    };
    cmd.stdout(output_file("stdout")?)
        .stderr(output_file("stderr")?);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            cmd.pre_exec(|| {
                // 子とその孫（Chrome・marp-cli）をまとめて止められるようにする
                libc::setsid();
                Ok(())
            });
        }
    }
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let pid = child.id() as i32;
    let done = Arc::new(AtomicBool::new(false));
    let timed_out = Arc::new(AtomicBool::new(false));
    let cancelled = Arc::new(AtomicBool::new(false));
    let done_flag = done.clone();
    let timeout_flag = timed_out.clone();
    let cancel_flag = cancelled.clone();
    let cancel_in = cancel.clone();
    let watchdog = std::thread::spawn(move || {
        // 50ms ごとに「終わったか」「やめるが押されたか」を見る。
        let start = std::time::Instant::now();
        let mut children = std::collections::HashMap::new();
        let mut scanned = start - Duration::from_secs(1);
        loop {
            if done_flag.load(Ordering::SeqCst) {
                return;
            }
            if scanned.elapsed() >= Duration::from_millis(250) {
                track_children(pid, &mut children);
                scanned = std::time::Instant::now();
            }
            if let Some(c) = &cancel_in {
                if c.load(Ordering::SeqCst) {
                    cancel_flag.store(true, Ordering::SeqCst);
                    break;
                }
            }
            if start.elapsed() >= timeout {
                timeout_flag.store(true, Ordering::SeqCst);
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        track_children(pid, &mut children);
        #[cfg(debug_assertions)]
        eprintln!("書き出し中断: 親 {pid}、追跡した子 {}", children.len());
        signal_children(&children, libc::SIGTERM);
        let kill_at = std::time::Instant::now();
        while kill_at.elapsed() < Duration::from_secs(5) {
            // 親が先に終了しても、別のグループの子が残る間は待ち続ける。
            if signal_children(&children, 0) == 0 {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        signal_children(&children, libc::SIGKILL);
    });
    let status = child.wait();
    done.store(true, Ordering::SeqCst);
    let _ = watchdog.join();
    let status = status.map_err(|e| e.to_string())?;
    Ok(CommandOutput {
        status,
        stdout: std::fs::read(capture.0.join("stdout")).map_err(|e| e.to_string())?,
        stderr: std::fs::read(capture.0.join("stderr")).map_err(|e| e.to_string())?,
        timed_out: timed_out.load(Ordering::SeqCst),
        cancelled: cancelled.load(Ordering::SeqCst),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_node() {
        // この環境には Node がある（無いない環境では飛ばす）
        if let Some(p) = find_node() {
            assert!(p.is_file(), "node の場所が違います: {}", p.display());
        }
    }

    #[test]
    fn find_node_looks_in_mise_and_asdf() {
        let home = std::env::temp_dir().join(format!("marp-node-home-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        for base in [".local/share/mise/installs/node", ".asdf/installs/nodejs"] {
            let bin = home.join(base).join("20.1.0/bin");
            std::fs::create_dir_all(&bin).unwrap();
            std::fs::write(
                bin.join("node"),
                b"#!/bin/sh
",
            )
            .unwrap();
        }
        let found = find_node_in_home(&home).expect("mise/asdf の node が見つからない");
        assert!(found.ends_with("bin/node"));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn node_versions_sort_numerically_and_find_nodenv_and_keg_only() {
        let home =
            std::env::temp_dir().join(format!("marp-node-version-{}", crate::hash::random_hex(12)));
        for base in [".nodenv/versions", "nvm/versions/node", "opt"] {
            for version in ["9.0.0", "22.1.0"] {
                let name = if base == "opt" {
                    format!("node@{version}")
                } else {
                    format!("v{version}")
                };
                let bin = home.join(base).join(name).join("bin");
                std::fs::create_dir_all(&bin).unwrap();
                std::fs::write(bin.join("node"), "node").unwrap();
            }
            assert!(find_versioned_node(
                &home.join(base),
                if base == "opt" { Some("node@") } else { None }
            )
            .unwrap()
            .to_string_lossy()
            .contains("22.1.0"));
        }
        assert!(find_node_in_home(&home)
            .unwrap()
            .to_string_lossy()
            .contains("22.1.0"));
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn timeout_stops_a_detached_descendant() {
        let Some(node) = find_node() else {
            return;
        };
        let pid_file =
            std::env::temp_dir().join(format!("marp-detached-{}", crate::hash::random_hex(12)));
        let mut cmd = std::process::Command::new(node);
        cmd.arg("-e").arg("const c=require('child_process').spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},100)\"],{detached:true,stdio:'ignore'});require('fs').writeFileSync(process.argv[1],String(c.pid));setInterval(()=>{},100)").arg(&pid_file);
        let result = run_with_cancel(cmd, Duration::from_secs(2), None).unwrap();
        assert!(result.timed_out);
        let pid: i32 = std::fs::read_to_string(&pid_file).unwrap().parse().unwrap();
        for _ in 0..50 {
            if unsafe { libc::kill(pid, 0) } != 0 {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_ne!(unsafe { libc::kill(pid, 0) }, 0, "別グループの子が残った");
        std::fs::remove_file(pid_file).unwrap();
    }

    #[test]
    fn path_with_node_puts_node_first() {
        let node = PathBuf::from("/opt/homebrew/bin/node");
        let path = path_with_node(&node);
        let first = std::env::split_paths(&path).next().unwrap();
        assert_eq!(first, PathBuf::from("/opt/homebrew/bin"));
        assert!(std::env::split_paths(&path).any(|p| p == std::path::Path::new("/usr/bin")));
    }

    #[test]
    fn run_with_timeout_returns_fast_for_a_quick_child() {
        let mut cmd = std::process::Command::new("/bin/sh");
        cmd.arg("-c").arg("exit 0");
        let t0 = std::time::Instant::now();
        let out = run_with_cancel(cmd, Duration::from_secs(60), None).unwrap();
        assert!(!out.timed_out, "時間切れと判定された");
        assert!(out.status.success());
        assert!(
            t0.elapsed() < Duration::from_secs(5),
            "終了なのに対象時間まで待った"
        );
    }

    #[test]
    fn finished_parent_does_not_wait_for_inherited_output() {
        let mut cmd = std::process::Command::new("/bin/sh");
        cmd.arg("-c")
            .arg("sleep 5 & printf output; printf failure >&2; exit 7");
        let start = std::time::Instant::now();
        let out = run_with_cancel(cmd, Duration::from_secs(10), None).unwrap();
        assert_eq!(out.status.code(), Some(7));
        assert_eq!(out.stdout, b"output");
        assert_eq!(out.stderr, b"failure");
        assert!(!out.timed_out && !out.cancelled);
        assert!(
            start.elapsed() < Duration::from_secs(3),
            "終了した親より補助プロセスを待っている"
        );
    }

    #[test]
    fn run_with_timeout_stops_a_hung_child() {
        let mut cmd = std::process::Command::new("/bin/sh");
        cmd.arg("-c").arg("sleep 20");
        let t0 = std::time::Instant::now();
        let out = run_with_cancel(cmd, Duration::from_millis(300), None).unwrap();
        assert!(out.timed_out, "時間切れにならなかった");
        assert!(
            t0.elapsed() < Duration::from_secs(10),
            "止めるのに時間がかかった"
        );
    }
}
