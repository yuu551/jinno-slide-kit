fn main() {
    let out = std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR"))
        .join("capabilities");
    if out.exists() {
        std::fs::remove_dir_all(&out).expect("clear generated capabilities");
    }
    std::fs::create_dir_all(&out).expect("capabilities directory");
    let mut sources = vec!["capabilities"];
    if std::env::var("PROFILE").as_deref() == Ok("debug") {
        sources.push("debug-capabilities");
    }
    for source in sources {
        println!("cargo:rerun-if-changed={source}");
        for entry in std::fs::read_dir(source).expect("read capabilities") {
            let entry = entry.expect("capability entry");
            std::fs::copy(entry.path(), out.join(entry.file_name())).expect("copy capability");
        }
    }
    let pattern = Box::leak(format!("{}/*.json", out.display()).into_boxed_str());
    tauri_build::try_build(tauri_build::Attributes::new().capabilities_path_pattern(pattern))
        .expect("build application");
}
