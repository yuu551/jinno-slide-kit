// WebKit/PDFKit の PDF を 960×540pt にそろえ、目次・ノート・検索文字を付ける。
use lopdf::{dictionary, Bookmark, Document, Object};
use serde_json::Value;
use unicode_normalization::UnicodeNormalization;

fn pdf_text(text: &str) -> Object {
    let mut bytes = vec![0xfe, 0xff];
    bytes.extend(text.encode_utf16().flat_map(u16::to_be_bytes));
    Object::string_literal(bytes)
}
fn number(value: &Object) -> Option<f64> {
    match value {
        Object::Integer(v) => Some(*v as f64),
        Object::Real(v) => Some(*v as f64),
        _ => None,
    }
}
fn scale_array(value: &mut Object, scale: f64) {
    if let Object::Array(items) = value {
        for item in items {
            if let Some(n) = number(item) {
                *item = Object::Real((n * scale) as f32);
            }
        }
    }
}

pub fn finish(bytes: &[u8], metadata: &Value, notes: bool) -> Result<Vec<u8>, String> {
    finish_inner(bytes, metadata, notes, false)
}
pub fn finish_chrome(bytes: &[u8], metadata: &Value) -> Result<Vec<u8>, String> {
    finish_inner(bytes, metadata, false, true)
}
fn finish_inner(
    bytes: &[u8],
    metadata: &Value,
    notes: bool,
    preserve_drawing: bool,
) -> Result<Vec<u8>, String> {
    fn work(
        bytes: &[u8],
        meta: &Value,
        notes: bool,
        preserve_drawing: bool,
    ) -> lopdf::Result<Vec<u8>> {
        let mut doc = Document::load_mem(bytes)?;
        let original = preserve_drawing.then(|| doc.clone());
        let pages = doc.get_pages();
        for (no, id) in &pages {
            let page = doc.get_dictionary(*id)?;
            let width = page
                .get(b"MediaBox")
                .ok()
                .and_then(|x| x.as_array().ok())
                .and_then(|a| a.get(2))
                .and_then(number)
                .unwrap_or(1280.0);
            let scale = 960.0 / width;
            let mut annotations = page
                .get(b"Annots")
                .ok()
                .and_then(|x| doc.dereference(x).ok())
                .and_then(|(_, x)| x.as_array().ok())
                .cloned()
                .unwrap_or_default();
            if (scale - 1.0).abs() > 0.0001 {
                let content =
                    doc.get_page_content_with_limit(*id, lopdf::DEFAULT_MAX_DECOMPRESSED_SIZE)?;
                let mut scaled = format!("q {scale} 0 0 {scale} 0 0 cm\n").into_bytes();
                scaled.extend(content);
                scaled.extend(b"\nQ\n");
                doc.change_page_content(*id, scaled)?;
                let page = doc.get_object_mut(*id)?.as_dict_mut()?;
                for key in [
                    b"MediaBox".as_slice(),
                    b"CropBox",
                    b"BleedBox",
                    b"TrimBox",
                    b"ArtBox",
                ] {
                    if let Ok(value) = page.get_mut(key) {
                        scale_array(value, scale);
                    }
                }
                for annotation in &annotations {
                    if let Ok(id) = annotation.as_reference() {
                        if let Ok(dict) = doc.get_object_mut(id)?.as_dict_mut() {
                            for key in [b"Rect".as_slice(), b"QuadPoints"] {
                                if let Ok(value) = dict.get_mut(key) {
                                    scale_array(value, scale);
                                }
                            }
                        }
                    }
                }
            }
            let mut links: Vec<_> = meta
                .get("links")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter(|l| l["page"].as_u64() == Some(*no as u64))
                .collect();
            if !links.is_empty() {
                // WebKit は折り返したリンクを1つの矩形にまとめることがある。
                // DOM の行ごとの矩形の方が細かいときだけ補う。
                // PDF 側が文字列をさらに分けた注釈や、SVG 内のリンクは残す。
                let mut existing = std::collections::HashMap::<String, usize>::new();
                for annotation in &annotations {
                    if let Some(uri) = doc
                        .dereference(annotation)
                        .ok()
                        .and_then(|(_, o)| o.as_dict().ok())
                        .and_then(|d| d.get(b"A").ok())
                        .and_then(|o| doc.dereference(o).ok())
                        .and_then(|(_, o)| o.as_dict().ok())
                        .and_then(|d| d.get(b"URI").ok())
                        .and_then(|s| s.as_str().ok())
                    {
                        *existing
                            .entry(String::from_utf8_lossy(uri).into_owned())
                            .or_default() += 1;
                    }
                }
                let mut measured = std::collections::HashMap::<String, usize>::new();
                for link in &links {
                    if let Some(url) = link["url"].as_str() {
                        *measured.entry(url.into()).or_default() += 1;
                    }
                }
                links.retain(|l| {
                    l["url"]
                        .as_str()
                        .is_some_and(|url| existing.get(url).copied().unwrap_or(0) < measured[url])
                });
                annotations.retain(|a| {
                    let uri = doc
                        .dereference(a)
                        .ok()
                        .and_then(|(_, o)| o.as_dict().ok())
                        .and_then(|d| d.get(b"A").ok())
                        .and_then(|o| doc.dereference(o).ok())
                        .and_then(|(_, o)| o.as_dict().ok())
                        .and_then(|d| d.get(b"URI").ok())
                        .and_then(|s| s.as_str().ok());
                    !uri.is_some_and(|uri| {
                        links
                            .iter()
                            .any(|l| l["url"].as_str().is_some_and(|url| url.as_bytes() == uri))
                    })
                });
                for link in links {
                    let Some(url) = link["url"].as_str() else {
                        continue;
                    };
                    let Some(r) = link["rect"].as_array().filter(|r| r.len() == 4) else {
                        continue;
                    };
                    let rect: Vec<Object> = r
                        .iter()
                        .map(|v| Object::Real(v.as_f64().unwrap_or(0.0) as f32))
                        .collect();
                    let a=doc.add_object(dictionary!{"Type"=>"Annot","Subtype"=>"Link","Rect"=>rect,"Border"=>vec![0.into(),0.into(),0.into()],"A"=>dictionary!{"S"=>"URI","URI"=>Object::string_literal(url)}});
                    annotations.push(a.into());
                }
            }
            if notes {
                let text = meta
                    .get("comments")
                    .and_then(Value::as_array)
                    .and_then(|a| a.get(*no as usize - 1))
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join("\n\n")
                    })
                    .unwrap_or_default();
                if !text.is_empty() {
                    let mut note = dictionary! { "Type" => "Annot", "Subtype" => "Text", "Rect" => vec![0.into(),20.into(),20.into(),20.into()], "Contents" => pdf_text(&text), "Name" => "Note", "Subj" => Object::string_literal("Note"), "C" => vec![1.into(),0.92.into(),0.42.into()], "CA" => 0.25 };
                    if let Some(author) = meta.get("author").and_then(Value::as_str) {
                        note.set("T", pdf_text(author));
                    }
                    let reference = doc.add_object(note);
                    annotations.push(reference.into());
                }
            }
            if !annotations.is_empty() {
                doc.get_object_mut(*id)?
                    .as_dict_mut()?
                    .set("Annots", annotations);
            }
        }
        if let Some(outline) = meta.get("outline").and_then(Value::as_array) {
            for page in outline {
                let no = page.get("pageNumber").and_then(Value::as_u64).unwrap_or(0) as u32;
                let Some(id) = pages.get(&no) else {
                    continue;
                };
                let root =
                    doc.add_bookmark(Bookmark::new(format!("Page {no}"), [0.0; 3], 2, *id), None);
                let mut parents = vec![(0u64, root)];
                for heading in page
                    .get("headings")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    let level = heading.get("level").and_then(Value::as_u64).unwrap_or(1);
                    while parents.len() > 1 && parents.last().is_some_and(|(l, _)| *l >= level) {
                        parents.pop();
                    }
                    let parent = parents.last().map(|(_, id)| *id);
                    let title = heading.get("title").and_then(Value::as_str).unwrap_or("");
                    let id =
                        doc.add_bookmark(Bookmark::new(title.into(), [0.0; 3], 0, *id), parent);
                    parents.push((level, id));
                }
            }
            if let Some(outline) = doc.build_outline() {
                doc.catalog_mut()?.set("Outlines", outline);
            }
        }
        let mut info = dictionary! { "Creator" => Object::string_literal("MarpKit"), "Producer" => Object::string_literal("MarpKit") };
        for (field, key) in [("title", "Title"), ("author", "Author")] {
            if let Some(text) = meta.get(field).and_then(Value::as_str) {
                info.set(key, pdf_text(text));
            }
        }
        let id = doc.add_object(info);
        doc.trailer.set("Info", id);
        let maps: std::collections::BTreeSet<_> = doc
            .objects
            .values()
            .filter_map(|o| o.as_dict().ok())
            .filter_map(|d| d.get(b"ToUnicode").ok())
            .filter_map(|o| o.as_reference().ok())
            .collect();
        for id in maps {
            if let Ok(stream) = doc.get_object_mut(id)?.as_stream_mut() {
                let raw = stream
                    .decompressed_content()
                    .unwrap_or_else(|_| stream.content.clone());
                let fixed = normalize_cmap(&raw);
                if fixed != raw {
                    stream.set_plain_content(fixed);
                }
            }
        }
        let mut output = Vec::new();
        if let Some(original) = original {
            // 描画に使う数値を読み直して丸めると、アンチエイリアスが1画素だけ変わる。
            // Chrome の元の描画はバイトのまま残し、変えたメタデータだけを追記する。
            let mut incremental =
                lopdf::IncrementalDocument::create_from(bytes.to_vec(), original.clone());
            let prev = incremental.new_document.trailer.get(b"Prev")?.clone();
            incremental.new_document.trailer = doc.trailer;
            incremental.new_document.trailer.set("Prev", prev);
            incremental.new_document.max_id = doc.max_id;
            incremental.new_document.objects = doc
                .objects
                .into_iter()
                .filter(|(id, value)| original.objects.get(id) != Some(value))
                .collect();
            incremental.new_document.compress();
            incremental.save_to(&mut output)?;
        } else {
            doc.compress();
            doc.save_to(&mut output)?;
        }
        Ok(output)
    }
    work(bytes, metadata, notes, preserve_drawing)
        .map_err(|e| format!("PDF の仕上げに失敗しました: {e}"))
}

fn normalized_hex(hex: &str) -> String {
    if hex.len() % 4 != 0 {
        return hex.to_string();
    }
    let units: Option<Vec<u16>> = (0..hex.len())
        .step_by(4)
        .map(|i| u16::from_str_radix(&hex[i..i + 4], 16).ok())
        .collect();
    let Some(units) = units else {
        return hex.into();
    };
    let Ok(text) = String::from_utf16(&units) else {
        return hex.into();
    };
    let normalized: String = text
        .chars()
        .flat_map(|c| {
            if ('\u{2f00}'..='\u{2fdf}').contains(&c) {
                c.to_string().nfkc().collect::<Vec<_>>()
            } else {
                vec![c]
            }
        })
        .collect();
    normalized
        .encode_utf16()
        .map(|u| format!("{u:04X}"))
        .collect()
}

// bfchar と bfrange の行先だけを直す。文字コード側（CID）は変えない。
fn normalize_cmap(raw: &[u8]) -> Vec<u8> {
    let Ok(text) = std::str::from_utf8(raw) else {
        return raw.to_vec();
    };
    let mut output = String::new();
    let mut rest = text;
    loop {
        let found = ["beginbfchar", "beginbfrange"]
            .into_iter()
            .filter_map(|kind| rest.find(kind).map(|at| (at, kind)))
            .min_by_key(|(at, _)| *at);
        let Some((at, kind)) = found else {
            output.push_str(rest);
            break;
        };
        let end_kind = if kind == "beginbfchar" {
            "endbfchar"
        } else {
            "endbfrange"
        };
        let Some(end) = rest[at..].find(end_kind).map(|i| at + i) else {
            return raw.to_vec();
        };
        let line = rest[..at].rfind('\n').map(|p| p + 1).unwrap_or(0);
        output.push_str(&rest[..line]);
        let body = &rest[at + kind.len()..end];
        let mut tokens = Vec::new();
        let mut chars = body.char_indices();
        while let Some((i, c)) = chars.next() {
            if c == '<' {
                if let Some(end) = body[i + 1..].find('>').map(|j| i + 1 + j) {
                    tokens.push(body[i..=end].to_string());
                    while let Some((j, _)) = chars.clone().next() {
                        if j <= end {
                            chars.next();
                        } else {
                            break;
                        }
                    }
                }
            } else if c == '[' || c == ']' {
                tokens.push(c.to_string());
            }
        }
        let hex = |token: &str| {
            token
                .strip_prefix('<')
                .and_then(|s| s.strip_suffix('>'))
                .map(str::to_string)
        };
        let mut entries = Vec::new();
        let mut index = 0usize;
        let mut valid = true;
        while index < tokens.len() {
            let Some(source) = hex(&tokens[index]) else {
                valid = false;
                break;
            };
            index += 1;
            if kind == "beginbfchar" {
                let Some(dest) = tokens.get(index).and_then(|t| hex(t)) else {
                    valid = false;
                    break;
                };
                index += 1;
                entries.push((source, dest));
            } else {
                let Some(last) = tokens.get(index).and_then(|t| hex(t)) else {
                    valid = false;
                    break;
                };
                index += 1;
                let (Ok(first), Ok(last)) = (
                    u32::from_str_radix(&source, 16),
                    u32::from_str_radix(&last, 16),
                ) else {
                    valid = false;
                    break;
                };
                if last < first || last - first > 65535 {
                    valid = false;
                    break;
                }
                if tokens.get(index).is_some_and(|t| t == "[") {
                    index += 1;
                    for code in first..=last {
                        let Some(dest) = tokens.get(index).and_then(|t| hex(t)) else {
                            valid = false;
                            break;
                        };
                        index += 1;
                        entries.push((format!("{:0width$X}", code, width = source.len()), dest));
                    }
                    if !tokens.get(index).is_some_and(|t| t == "]") {
                        valid = false;
                        break;
                    }
                    index += 1;
                } else {
                    let Some(dest) = tokens.get(index).and_then(|t| hex(t)) else {
                        valid = false;
                        break;
                    };
                    index += 1;
                    let Ok(base) = u128::from_str_radix(&dest, 16) else {
                        valid = false;
                        break;
                    };
                    for code in first..=last {
                        entries.push((
                            format!("{:0width$X}", code, width = source.len()),
                            format!(
                                "{:0width$X}",
                                base + u128::from(code - first),
                                width = dest.len()
                            ),
                        ));
                    }
                }
            }
        }
        if !valid {
            return raw.to_vec();
        }
        let changed = entries
            .iter()
            .any(|(_, dest)| !normalized_hex(dest).eq_ignore_ascii_case(dest));
        if changed {
            for chunk in entries.chunks(100) {
                output.push_str(&format!("{} beginbfchar\n", chunk.len()));
                for (source, dest) in chunk {
                    output.push_str(&format!("<{source}> <{}>\n", normalized_hex(dest)));
                }
                output.push_str("endbfchar\n");
            }
        } else {
            output.push_str(&rest[line..end + end_kind.len()]);
        }
        rest = &rest[end + end_kind.len()..];
    }
    output.into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn keeps_indirect_link_annotations_and_supplements_wrapped_links() {
        for (existing, measured) in [(3, 2), (1, 2)] {
            let mut doc = Document::with_version("1.7");
            let pages = doc.new_object_id();
            let links: Vec<Object> = (0..existing).map(|_| doc.add_object(dictionary! {
                "Type"=>"Annot", "Subtype"=>"Link", "Rect"=>vec![0.into(),0.into(),20.into(),20.into()],
                "A"=>dictionary!{"S"=>"URI", "URI"=>Object::string_literal("https://example.com/")}
            }).into()).collect();
            let annotations = doc.add_object(links);
            let page = doc.add_object(dictionary!{"Type"=>"Page", "Parent"=>pages, "MediaBox"=>vec![0.into(),0.into(),960.into(),540.into()], "Annots"=>annotations});
            doc.objects.insert(
                pages,
                dictionary! {"Type"=>"Pages", "Kids"=>vec![page.into()], "Count"=>1}.into(),
            );
            let catalog = doc.add_object(dictionary! {"Type"=>"Catalog", "Pages"=>pages});
            doc.trailer.set("Root", catalog);
            let mut bytes = Vec::new();
            doc.save_to(&mut bytes).unwrap();
            let links: Vec<_> = (0..measured).map(|_| serde_json::json!({"page":1,"url":"https://example.com/","rect":[0,0,20,20]})).collect();
            let result = finish(
                &bytes,
                &serde_json::json!({"links":links,"comments":[["note"]]}),
                true,
            )
            .unwrap();
            let out = Document::load_mem(&result).unwrap();
            let annots = out
                .get_dictionary(page)
                .unwrap()
                .get(b"Annots")
                .unwrap()
                .as_array()
                .unwrap();
            assert_eq!(
                annots.len(),
                existing.max(measured) + 1,
                "リンクとノートを両方保つ"
            );
        }
    }
    #[test]
    fn normalizes_destinations_without_changing_cids_or_other_characters() {
        let src = b"3 beginbfchar\n<2F00> <0041>\n<0001> <2F00>\n<0002> <2460>\nendbfchar";
        let fixed = String::from_utf8(normalize_cmap(src)).expect("ASCII CMap");
        assert!(fixed.contains("<2F00> <0041>"));
        assert!(fixed.contains("<0001> <4E00>"));
        assert!(fixed.contains("<0002> <2460>"));
    }
    #[test]
    fn expands_ranges_before_normalizing_nonconsecutive_radicals() {
        let src = b"2 beginbfrange\n<0010> <0011> <2F00>\n<0020> <0021> [<2F00><2F01>]\nendbfrange";
        let fixed = String::from_utf8(normalize_cmap(src)).expect("ASCII CMap");
        for expected in [
            "<0010> <4E00>",
            "<0011> <4E28>",
            "<0020> <4E00>",
            "<0021> <4E28>",
        ] {
            assert!(fixed.contains(expected), "{fixed}");
        }
    }
}
