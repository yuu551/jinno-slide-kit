// Git の操作（marp/lib/git.mjs と同じ結果にする）。
// ライブラリー（1つのリポジトリ）の中で、資料のフォルダ単位に commit・log・restore する。
// リモートとのやり取り（fetch・pull・push）はリポジトリ単位。pull は fast-forward のみ。
use std::path::Path;
use std::process::Command;

#[derive(Debug)]
pub struct GitError(pub String);

impl std::fmt::Display for GitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

type R<T> = Result<T, GitError>;

fn git(cwd: &Path, args: &[&str], input: Option<&[u8]>) -> R<Vec<u8>> {
    // 時間の上限を決める（Node 版と同じ。ネットワークを使うものは長め）
    let long = args
        .iter()
        .any(|a| matches!(*a, "fetch" | "pull" | "push" | "clone"));
    let limit = std::time::Duration::from_secs(if long { 120 } else { 60 });
    let mut cmd = Command::new("git");
    cmd.args(args)
        .current_dir(cwd)
        .env("PATH", crate::hub::gui_path())
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C");
    if input.is_some() {
        cmd.stdin(std::process::Stdio::piped());
    } else {
        cmd.stdin(std::process::Stdio::null());
    }
    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| GitError(e.to_string()))?;
    if let Some(data) = input {
        use std::io::Write;
        if let Some(mut si) = child.stdin.take() {
            let _ = si.write_all(data);
        }
    }
    // 出力が多いときは、待つ前に読み切る（パイプが詰まって止まらないように）
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let out_handle = stdout.map(|mut s| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = std::io::Read::read_to_end(&mut s, &mut buf);
            buf
        })
    });
    let err_handle = stderr.map(|mut s| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = std::io::Read::read_to_end(&mut s, &mut buf);
            buf
        })
    });
    let start = std::time::Instant::now();
    let status = loop {
        match child.try_wait().map_err(|e| GitError(e.to_string()))? {
            Some(st) => break st,
            None => {
                if start.elapsed() > limit {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(GitError("git が時間内に終わりませんでした".into()));
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        }
    };
    let stdout = out_handle.and_then(|h| h.join().ok()).unwrap_or_default();
    let stderr = err_handle.and_then(|h| h.join().ok()).unwrap_or_default();
    if !status.success() {
        return Err(GitError(explain(&String::from_utf8_lossy(&stderr))));
    }
    Ok(stdout)
}

fn text(cwd: &Path, args: &[&str]) -> R<String> {
    Ok(String::from_utf8_lossy(&git(cwd, args, None)?).to_string())
}

/// よくあるエラーを日本語で説明する
pub fn explain(msg: &str) -> String {
    let m = msg.to_lowercase();
    let has = |pat: &str| m.contains(pat);
    if has("not a git repository") {
        return "Gitのリポジトリではありません".into();
    }
    if has("nothing to commit") || has("no changes added") {
        return "コミットする変更がありません".into();
    }
    if has("please tell me who you are") || has("user.email") {
        return "Gitのユーザー名とメールアドレスが設定されていません（git config user.name / user.email）".into();
    }
    if has("not possible to fast-forward")
        || has("diverged")
        || has("non-fast-forward")
        || has("fetch first")
    {
        return "手元とリモートの履歴が食い違っています。ターミナルで git pull --rebase などを使って解消してください".into();
    }
    if has("could not read from remote")
        || has("authentication failed")
        || has("permission denied")
        || has("could not resolve host")
    {
        return "リモートに接続できません（認証かネットワークを確認してください）".into();
    }
    if has("no upstream") || has("has no upstream") {
        return "リモートのブランチが設定されていません".into();
    }
    if has("does not appear to be a git repository") || has("no such remote") {
        return "リモートが設定されていません".into();
    }
    let lines: Vec<&str> = msg.trim().lines().collect();
    lines[lines.len().saturating_sub(3)..]
        .join(" ")
        .trim()
        .to_string()
}

pub fn repo_root(dir: &Path) -> Option<String> {
    text(dir, &["rev-parse", "--show-toplevel"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

#[derive(serde::Serialize, Clone, Debug, PartialEq, Eq)]
pub struct FileStatus {
    pub code: String,
    pub file: String,
    pub kind: String,
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct Status {
    pub files: Vec<FileStatus>,
    pub count: usize,
}

/// 資料のフォルダ（dir）の変更。dir を省略するとリポジトリ全体
pub fn status(root: &Path, dir: &str) -> R<Status> {
    let out = git(
        root,
        &[
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--",
            dir,
        ],
        None,
    )?;
    let s = String::from_utf8_lossy(&out).to_string();
    let parts: Vec<&str> = s.split('\0').filter(|p| !p.is_empty()).collect();
    let mut files = Vec::new();
    let mut i = 0usize;
    while i < parts.len() {
        let p = parts[i];
        let code = p.chars().take(2).collect::<String>();
        let file = p.chars().skip(3).collect::<String>();
        if code.starts_with('R') || code.starts_with('C') {
            i += 1; // 移動は元の名前が続く
        }
        let kind = if code == "??" {
            "added"
        } else if code.contains('D') {
            "deleted"
        } else if code.contains('A') {
            "added"
        } else {
            "modified"
        };
        files.push(FileStatus {
            code,
            file,
            kind: kind.into(),
        });
        i += 1;
    }
    let count = files.len();
    Ok(Status { files, count })
}

#[derive(serde::Serialize, Clone, Debug, Default)]
pub struct BranchInfo {
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: i64,
    pub behind: i64,
    pub remote: Option<String>,
    pub head: Option<String>,
}

pub fn branch_info(root: &Path) -> BranchInfo {
    let mut info = BranchInfo {
        branch: text(root, &["rev-parse", "--abbrev-ref", "HEAD"])
            .ok()
            .map(|s| s.trim().to_string()),
        head: text(root, &["rev-parse", "--short", "HEAD"])
            .ok()
            .map(|s| s.trim().to_string()),
        remote: text(root, &["remote", "get-url", "origin"])
            .ok()
            .map(|s| s.trim().to_string()),
        ..BranchInfo::default()
    };
    if let Ok(up) = text(
        root,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    ) {
        info.upstream = Some(up.trim().to_string());
        if let Ok(counts) = text(
            root,
            &["rev-list", "--left-right", "--count", "@{u}...HEAD"],
        ) {
            let v: Vec<i64> = counts
                .split_whitespace()
                .filter_map(|x| x.parse().ok())
                .collect();
            if v.len() == 2 {
                info.behind = v[0];
                info.ahead = v[1];
            }
        }
    }
    info
}

/// dir の変更だけをコミットする（ほかの資料の変更は含めない）
pub fn commit(root: &Path, dir: &str, message: &str) -> R<String> {
    if message.trim().is_empty() {
        return Err(GitError("コミットのメッセージを入れてください".into()));
    }
    git(root, &["add", "-A", "--", dir], None)?;
    let staged = text(root, &["diff", "--cached", "--name-only", "--", dir])?;
    if staged.trim().is_empty() {
        return Err(GitError("コミットする変更がありません".into()));
    }
    git(
        root,
        &["commit", "-m", message.trim(), "--only", "--", dir],
        None,
    )?;
    Ok(text(root, &["rev-parse", "--short", "HEAD"])?
        .trim()
        .to_string())
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct LogEntry {
    pub hash: String,
    pub short: String,
    pub author: String,
    pub date: String,
    pub subject: String,
    pub stat: String,
}

pub fn log(root: &Path, dir: &str, limit: usize) -> R<Vec<LogEntry>> {
    let n = format!("-n{limit}");
    let out = match git(
        root,
        &[
            "log",
            &n,
            "--date=iso-strict",
            "--format=%x1e%H%x1f%h%x1f%an%x1f%ad%x1f%s",
            "--shortstat",
            "--",
            dir,
        ],
        None,
    ) {
        Ok(o) => o,
        Err(e) => {
            if e.0.contains("does not have any commits") {
                return Ok(Vec::new());
            }
            return Err(e);
        }
    };
    let s = String::from_utf8_lossy(&out).to_string();
    let mut out_entries = Vec::new();
    for rec in s.split('\u{1e}').filter(|r| !r.trim().is_empty()) {
        let mut lines = rec.split('\n');
        let head = lines.next().unwrap_or("");
        let f: Vec<&str> = head.split('\u{1f}').collect();
        if f.len() < 5 {
            continue;
        }
        out_entries.push(LogEntry {
            hash: f[0].into(),
            short: f[1].into(),
            author: f[2].into(),
            date: f[3].into(),
            subject: f[4].into(),
            stat: lines.collect::<Vec<&str>>().join(" ").trim().to_string(),
        });
    }
    Ok(out_entries)
}

/// 版の指定に使える形か（S04）。16進のハッシュか HEAD・HEAD~n だけを許す。
/// `--output=…` のような Git のオプションを渡せないようにする。
pub fn valid_rev(rev: &str) -> bool {
    let rev = rev.trim();
    if rev.is_empty() || rev.len() > 64 || rev.starts_with('-') {
        return false;
    }
    if rev == "HEAD" {
        return true;
    }
    if let Some(n) = rev.strip_prefix("HEAD~") {
        return !n.is_empty() && n.chars().all(|c| c.is_ascii_digit());
    }
    rev.len() >= 4 && rev.len() <= 64 && rev.chars().all(|c| c.is_ascii_hexdigit())
}

fn require_rev(root: &Path, rev: &str) -> R<()> {
    if !valid_rev(rev) {
        return Err(GitError("版の指定が正しくありません".into()));
    }
    git(
        root,
        &[
            "rev-parse",
            "--verify",
            "--end-of-options",
            &format!("{rev}^{{commit}}"),
        ],
        None,
    )?;
    Ok(())
}

pub fn show(root: &Path, rev: &str, file: &str) -> Option<Vec<u8>> {
    if !valid_rev(rev) {
        return None;
    }
    git(
        root,
        &["show", "--end-of-options", &format!("{rev}:{file}")],
        None,
    )
    .ok()
}

pub fn parent_of(root: &Path, rev: &str) -> Option<String> {
    if !valid_rev(rev) {
        return None;
    }
    text(root, &["rev-parse", &format!("{rev}^")])
        .ok()
        .map(|s| s.trim().to_string())
}

/// dir を rev の状態へ戻す（作業ツリーだけ。コミットは別に行う）
pub fn restore(root: &Path, dir: &str, rev: &str) -> R<()> {
    require_rev(root, rev)?;
    let tracked: Vec<String> = text(root, &["ls-tree", "-r", "--name-only", rev, "--", dir])?
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| l.to_string())
        .collect();
    if tracked.is_empty() {
        return Err(GitError("その版にはこの資料がありません".into()));
    }
    let now: Vec<String> = text(root, &["ls-files", "--", dir])?
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| l.to_string())
        .collect();
    git(root, &["checkout", rev, "--", dir], None)?;
    for f in now {
        if !tracked.contains(&f) {
            let _ = std::fs::remove_file(root.join(&f));
        }
    }
    git(root, &["reset", "-q", "--", dir], None)?;
    Ok(())
}

pub fn fetch_remote(root: &Path) -> R<BranchInfo> {
    git(root, &["fetch", "--prune"], None)?;
    Ok(branch_info(root))
}

pub fn pull(root: &Path) -> R<BranchInfo> {
    git(root, &["pull", "--ff-only"], None)?;
    Ok(branch_info(root))
}

pub fn push(root: &Path) -> R<BranchInfo> {
    let b = branch_info(root);
    if b.remote.is_none() {
        return Err(GitError("リモートが設定されていません".into()));
    }
    if b.upstream.is_some() {
        git(root, &["push"], None)?;
    } else {
        git(root, &["push", "-u", "origin", "HEAD"], None)?;
    }
    Ok(branch_info(root))
}

pub fn set_remote(root: &Path, url: &str) -> R<BranchInfo> {
    let b = branch_info(root);
    if b.remote.is_some() {
        git(root, &["remote", "set-url", "origin", url], None)?;
    } else {
        git(root, &["remote", "add", "origin", url], None)?;
    }
    Ok(branch_info(root))
}

pub const GITIGNORE: &str = ".check/\ndist/\n.render-*.html\n.editor-history/\n.editor-check-*.md\n.agent-notes.json\nnode_modules/\n.DS_Store\n";

pub fn init(root: &Path, message: &str) -> R<BranchInfo> {
    std::fs::create_dir_all(root).map_err(|e| GitError(e.to_string()))?;
    let same = repo_root(root)
        .map(|r| Path::new(&r) == root)
        .unwrap_or(false);
    if !same {
        git(root, &["init", "-b", "main"], None)?;
    }
    let gi = root.join(".gitignore");
    if !gi.exists() {
        let _ = std::fs::write(&gi, GITIGNORE);
    }
    git(root, &["add", "-A"], None)?;
    let staged = text(root, &["diff", "--cached", "--name-only"])?;
    if !staged.trim().is_empty() {
        git(root, &["commit", "-m", message], None)?;
    }
    Ok(branch_info(root))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("marp-git-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn commit_and_log_only_the_deck_folder() {
        let dir = tmp("commit");
        init(&dir, "最初").unwrap();
        std::fs::create_dir_all(dir.join("a")).unwrap();
        std::fs::create_dir_all(dir.join("b")).unwrap();
        std::fs::write(dir.join("a/slides.md"), "# あ\n").unwrap();
        std::fs::write(dir.join("b/slides.md"), "# い\n").unwrap();
        commit(&dir, "a", "a を追加").unwrap();
        // a の変更だけがコミットされ、b は未追跡のまま
        let st = status(&dir, "b").unwrap();
        assert!(st.files.iter().any(|f| f.file == "b/slides.md"));
        let lg = log(&dir, "a", 10).unwrap();
        assert_eq!(lg.len(), 1);
        assert_eq!(lg[0].subject, "a を追加");
        assert!(!lg[0].short.is_empty());
        // 変更がなければエラー
        std::fs::write(dir.join("a/slides.md"), "# あ\n").unwrap();
        assert!(commit(&dir, "a", "から").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn valid_rev_blocks_git_options() {
        assert!(valid_rev("abcdef1"));
        assert!(valid_rev(&"a".repeat(64)));
        assert!(!valid_rev(&"a".repeat(65)));
        assert!(valid_rev("HEAD"));
        assert!(valid_rev("HEAD~2"));
        assert!(!valid_rev("--output=/tmp/x"));
        assert!(!valid_rev("-p"));
        assert!(!valid_rev("HEAD;rm"));
        assert!(!valid_rev(""));
    }

    #[test]
    fn explains_the_common_errors() {
        assert_eq!(
            explain("fatal: not a git repository (or any of the parent directories)"),
            "Gitのリポジトリではありません"
        );
        assert!(explain("nothing to commit, working tree clean")
            .contains("コミットする変更がありません"));
    }

    #[test]
    fn restore_puts_the_file_back() {
        let dir = tmp("restore");
        init(&dir, "最初").unwrap();
        std::fs::create_dir_all(dir.join("a")).unwrap();
        std::fs::write(dir.join("a/slides.md"), "# 1\n").unwrap();
        let rev = commit(&dir, "a", "1").unwrap();
        std::fs::write(dir.join("a/slides.md"), "# 2\n").unwrap();
        commit(&dir, "a", "2").unwrap();
        restore(&dir, "a", &rev).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join("a/slides.md")).unwrap(),
            "# 1\n"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
