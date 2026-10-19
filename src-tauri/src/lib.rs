mod bulbapedia;
mod commands;
mod db;
mod process;

use std::sync::Mutex;

use commands::AppState;
use tauri::image::Image;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
            std::fs::create_dir_all(&dir)?;
            let db_path = dir.join("library.db");
            let conn = db::open(&db_path)?;
            let http = bulbapedia::http_client()?;
            app.manage(AppState {
                db: Mutex::new(conn),
                workspace: Mutex::new(None),
                http,
            });
            if let Some(window) = app.get_webview_window("main") {
                let bytes = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/icons/icon.png"));
                if let Ok(img) = image::load_from_memory(bytes) {
                    let rgba = img.to_rgba8();
                    let (width, height) = rgba.dimensions();
                    let icon = Image::new_owned(rgba.into_raw(), width, height);
                    let _ = window.set_icon(icon);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::import_file,
            commands::import_clipboard,
            commands::import_url,
            commands::search_bulbapedia,
            commands::preview,
            commands::save_page,
            commands::list_pages,
            commands::load_page,
            commands::delete_page,
            commands::export_page,
            commands::current_coloring_png,
            commands::export_current,
            commands::export_tutorial,
            commands::list_rosters,
            commands::save_roster,
            commands::delete_roster,
            commands::cache_roster_art,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
