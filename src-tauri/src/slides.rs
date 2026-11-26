// Markdown のページ分割（marp/editor/client/markdown.mjs と同じ結果にする）。
// 履歴のページ数と、ページごとの差分（delta）に使う。
//
//   separatorLines … 区切り線（---）の行。フロントマターとコードブロックの中は数えない
//   rangesFromText … ページごとの行の範囲
//   pagesOf        … ページごとの本文（前後の空行は落とす）
//   pageDelta      … 2つの版の変わったページの数（変更・追加・削除）
pub struct Sep {
    pub fm: bool,
    pub line: usize,
}

pub fn separator_lines(text: &str) -> Vec<Sep> {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut out = Vec::new();
    let mut i = 0usize;
    let mut fence: Option<char> = None;
    if lines.first().map(|l| l.trim() == "---").unwrap_or(false) {
        i = 1;
        while i < lines.len() && lines[i].trim() != "---" {
            i += 1;
        }
        out.push(Sep { fm: true, line: i });
        i += 1;
    }
    while i < lines.len() {
        let l = lines[i];
        if let Some(f) = fence_start(l) {
            match fence {
                None => fence = Some(f),
                Some(cur) if l.trim_start().starts_with(cur) => fence = None,
                _ => {}
            }
            i += 1;
            continue;
        }
        if fence.is_none() && l.trim_end() == "---" {
            out.push(Sep { fm: false, line: i });
        }
        i += 1;
    }
    out
}

// ``` または ~~~ で始まる行（3つ以上）
fn fence_start(line: &str) -> Option<char> {
    let t = line.trim_start();
    for ch in ['`', '~'] {
        let n = t.chars().take_while(|c| *c == ch).count();
        if n >= 3 {
            return Some(ch);
        }
    }
    None
}

pub fn ranges_from_text(text: &str) -> Vec<(usize, usize)> {
    let lines: Vec<&str> = text.split('\n').collect();
    let seps = separator_lines(text);
    let mut ranges = Vec::new();
    let mut start = 0usize;
    let mut k = 0usize;
    if seps.first().map(|s| s.fm).unwrap_or(false) {
        start = seps[0].line + 1;
        k = 1;
    }
    while k < seps.len() {
        ranges.push((start, seps[k].line));
        start = seps[k].line + 1;
        k += 1;
    }
    ranges.push((start, lines.len()));
    ranges
}

/// ページごとの本文（前後の空行を落としたもの）
pub fn pages_of(text: &str) -> Vec<String> {
    if text.is_empty() {
        return Vec::new();
    }
    let lines: Vec<&str> = text.split('\n').collect();
    ranges_from_text(text)
        .iter()
        .map(|(start, end)| {
            let mut a = *start;
            let mut b = (*end).min(lines.len());
            while a < b && lines[a].trim().is_empty() {
                a += 1;
            }
            while b > a && lines[b - 1].trim().is_empty() {
                b -= 1;
            }
            lines[a..b].join("\n")
        })
        .collect()
}

#[derive(Debug, PartialEq, Eq, Default, Clone, Copy)]
pub struct Delta {
    pub modified: usize,
    pub added: usize,
    pub deleted: usize,
}

/// 2つの版の変わったページの数（alignPages と同じ組み方）
pub fn page_delta(before: &str, after: &str) -> Delta {
    let a = pages_of(before);
    let b = pages_of(after);
    let (n, m) = (a.len(), b.len());
    // LCS の長さの表
    let mut dp = vec![vec![0i32; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            dp[i][j] = if a[i] == b[j] {
                dp[i + 1][j + 1] + 1
            } else {
                dp[i + 1][j].max(dp[i][j + 1])
            };
        }
    }
    // たどって、削除と追加が隣り合っていれば「変更」にまとめる
    #[derive(PartialEq)]
    enum Op {
        Same,
        Add,
        Del,
    }
    let mut ops: Vec<Op> = Vec::new();
    let (mut i, mut j) = (0usize, 0usize);
    while i < n || j < m {
        if i < n && j < m && a[i] == b[j] {
            ops.push(Op::Same);
            i += 1;
            j += 1;
            continue;
        }
        if j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j]) {
            ops.push(Op::Add);
            j += 1;
        } else {
            ops.push(Op::Del);
            i += 1;
        }
    }
    let mut d = Delta::default();
    let mut k = 0usize;
    while k < ops.len() {
        let cur = &ops[k];
        let next = ops.get(k + 1);
        if *cur == Op::Del && next == Some(&Op::Add) {
            d.modified += 1;
            k += 2;
            continue;
        }
        if *cur == Op::Add && next == Some(&Op::Del) {
            d.modified += 1;
            k += 2;
            continue;
        }
        match cur {
            Op::Add => d.added += 1,
            Op::Del => d.deleted += 1,
            Op::Same => {}
        }
        k += 1;
    }
    d
}

/// フロントマターの title（Node 版と同じ取り方）
pub fn deck_title(text: &str) -> String {
    // Node 版の /^---\n[\s\S]*?^title:\s*"?(.+?)"?\s*$/m と同じ考え方。
    // 先頭が frontmatter のときだけ、行頭の `title:` を読む（引用符は外す）。
    // Node は閉じの `---` で止まらないので、frontmatter に title が無く本文の行頭に
    // `title:` がある資料では、Node はその行を題名にする。Rust は frontmatter の中だけを見る
    // （資料の題名としては frontmatter のものが正しいので、こちらに合わせている。review-P4 の should）
    let mut lines = text.lines();
    if lines.next().map(|l| l.trim_end_matches('\r')) != Some("---") {
        return String::new();
    }
    for line in lines {
        let line = line.trim_end_matches('\r');
        if line == "---" {
            break;
        }
        if let Some(rest) = line.strip_prefix("title:") {
            // Node の "?(.+?)"?\s*$ に合わせて、前後の空白と引用符を落とす
            let t = rest.trim();
            let t = t.strip_prefix('"').unwrap_or(t);
            let t = t.strip_suffix('"').unwrap_or(t);
            let t = t.trim();
            let t = t.strip_prefix('\'').unwrap_or(t);
            let t = t.strip_suffix('\'').unwrap_or(t);
            return t
                .replace("<br>", " ")
                .replace("<br/>", " ")
                .replace("<br />", " ")
                .trim()
                .to_string();
        }
    }
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_pages_like_the_editor() {
        let text = "---\nmarp: true\ntitle: テスト\n---\n\n# 1ページ目\n\n本文\n\n---\n\n# 2ページ目\n\n本文2\n";
        // Node 版（markdown.mjs の rangesFromText）と同じ値
        assert_eq!(ranges_from_text(text), vec![(4, 9), (10, 15)]);
        let pages = pages_of(text);
        assert_eq!(pages.len(), 2);
        assert_eq!(pages[0], "# 1ページ目\n\n本文");
        assert_eq!(pages[1], "# 2ページ目\n\n本文2");
        assert_eq!(deck_title(text), "テスト");
    }

    #[test]
    fn separator_inside_a_code_block_is_not_a_separator() {
        let text = "---\nmarp: true\n---\n\n# あ\n\n```\n---\n```\n\n本文\n\n---\n\n# い\n";
        let pages = pages_of(text);
        assert_eq!(
            pages.len(),
            2,
            "コードブロックの中の --- で切ってはいけない: {pages:?}"
        );
    }

    #[test]
    fn page_delta_counts_changes() {
        let a = "---\nmarp: true\n---\n\n# あ\n\n本文\n\n---\n\n# い\n";
        // 2ページ目を差し替え
        let b = "---\nmarp: true\n---\n\n# あ\n\n本文\n\n---\n\n# い（直した）\n";
        assert_eq!(
            page_delta(a, b),
            Delta {
                modified: 1,
                added: 0,
                deleted: 0
            }
        );
        // ページを足す
        let c = "---\nmarp: true\n---\n\n# あ\n\n本文\n\n---\n\n# い\n\n---\n\n# う\n";
        assert_eq!(
            page_delta(a, c),
            Delta {
                modified: 0,
                added: 1,
                deleted: 0
            }
        );
        // 変わらない
        assert_eq!(page_delta(a, a), Delta::default());
    }
}
