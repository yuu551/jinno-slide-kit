use std::path::Path;
/// Gate native document entry points before history directories and watchers are created.
pub fn validate(path: &Path) -> Result<(), String> {
    if !path.is_file() {
        return Err("資料のファイルが見つかりません".into());
    }
    if path
        .file_name()
        .and_then(|s| s.to_str())
        .is_some_and(|s| s.eq_ignore_ascii_case("slides.md"))
    {
        return Ok(());
    }
    let markdown = path
        .extension()
        .and_then(|s| s.to_str())
        .is_some_and(|s| s.eq_ignore_ascii_case("md"));
    let text = crate::deck::read_text_lossy(path).map_err(|e| format!("資料を読めません: {e}"))?;
    if markdown && has_marp_frontmatter(&text) {
        Ok(())
    } else {
        Err("Marp の資料ではありません。slides.md、または先頭の設定に marp: true がある Markdown を選んでください。".into())
    }
}
fn has_marp_frontmatter(text: &str) -> bool {
    let mut lines = text.trim_start_matches('\u{feff}').lines();
    if lines.next().map(str::trim) != Some("---") {
        return false;
    }
    let mut enabled = false;
    for line in lines {
        if line.trim() == "---" {
            return enabled;
        }
        // A top-level boolean only; values inside a YAML block or code sample do not qualify.
        if let Some(value) = line.strip_prefix("marp:") {
            let value = value.split('#').next().unwrap_or("").trim();
            enabled = value.eq_ignore_ascii_case("true");
        }
    }
    false
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn requires_closed_frontmatter_and_top_level_boolean() {
        assert!(has_marp_frontmatter("---\r\nmarp: true\r\n---\r\n# 見本"));
        assert!(has_marp_frontmatter(
            "\u{feff}---\nmarp: True # 有効\n---\n# 見本"
        ));
        for text in [
            "# 見本\nmarp: true",
            "---\nmarp: true",
            "---\nmarp: false\n---",
            "---\nexample: |\n  marp: true\n---",
            "---\nmarp: true\nmarp: false\n---",
        ] {
            assert!(!has_marp_frontmatter(text), "{text}");
        }
    }
}
