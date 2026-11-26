// ウインドウを出さずに落ちないよう、リリースでは Windows のコンソールを出さない（雛形にならう）
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// `--http` を付けたときだけ、ウインドウを出さずに HTTP の互換層（開発とテスト用）を動かす。
//   marp-native --http <slides.md> [--port 4870] [--hub http://127.0.0.1:4860/] [--no-open] [--split] [--preview]
// それ以外は Tauri のアプリとして立ち上げる。
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--http") {
        match marp_native_lib::http_main(&args) {
            Ok(()) => {}
            Err(e) => {
                eprintln!("{e}");
                std::process::exit(1);
            }
        }
        return;
    }
    marp_native_lib::run()
}
