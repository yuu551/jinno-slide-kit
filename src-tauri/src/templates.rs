use std::path::Path;
use serde_json::{json,Value};

pub fn catalog(kit:&Path)->Result<Vec<Value>,String>{
    let mut list=Vec::new();
    for dir in ["talk", "update", "release", "webinar", "lightning"] {
        let base=kit.join("marp/templates").join(dir);
        let mut meta:Value=serde_json::from_str(&std::fs::read_to_string(base.join("template.json")).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
        meta["dir"]=json!(dir);meta["text"]=json!(std::fs::read_to_string(base.join("slides.md")).map_err(|e|e.to_string())?);list.push(meta);
    }
    list.push(json!({"name":"blank","dir":"","description":"白紙の1ページから始めます","defaultTitle":"新しい資料","text":"---\nmarp: true\ntheme: paper\npaginate: true\ntitle: \"{{TITLE}}\"\n---\n\n# {{TITLE}}\n"}));
    Ok(list)
}

pub fn fill(text:&str,title:&str,theme:&str)->String{
    let plain=regex::Regex::new(r"<br\s*/?>").expect("固定の正規表現").replace_all(title," ");
    let value=serde_json::to_string(&plain).expect("文字列");
    let mut out=text.replace("title: \"{{TITLE}}\"",&format!("title: {value}")).replace("{{TITLE}}",title);
    if !theme.is_empty(){out=regex::Regex::new(r"(?m)^theme: .*$").expect("固定の正規表現").replace(&out,format!("theme: {theme}")).into_owned();}
    out
}
