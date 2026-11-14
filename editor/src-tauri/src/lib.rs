//! Brush Editor shell. Window, file dialogs and file drop only.
//! All app logic lives in the web app (src/app) and the TS core (src/core).

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .run(tauri::generate_context!())
        .expect("error while running Brush Editor");
}
