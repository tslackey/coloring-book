use std::path::PathBuf;
use std::sync::Mutex;

use image::GrayImage;
use rusqlite::Connection;
use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_clipboard_manager::ClipboardExt;

use crate::bulbapedia::{self, SearchHit};
use crate::db::{self, PageSummary};
use crate::process;

pub struct AppState {
    pub db: Mutex<Connection>,
    pub workspace: Mutex<Option<Workspace>>,
    pub http: reqwest::Client,
}

pub struct Workspace {
    pub title: String,
    pub source: String,
    pub source_url: Option<String>,
    pub page_id: Option<i64>,
    pub original_png: Vec<u8>,
    pub original_preview_png: Vec<u8>,
    pub post_negate: GrayImage,
}

#[derive(Serialize)]
pub struct WorkspaceView {
    pub title: String,
    pub source: String,
    pub source_url: Option<String>,
    pub page_id: Option<i64>,
    pub original_png_base64: String,
    pub coloring_png_base64: String,
    pub threshold: f32,
}

#[derive(Serialize)]
pub struct PreviewView {
    pub coloring_png_base64: String,
    pub threshold: f32,
}

fn view_from_workspace(workspace: &Workspace, threshold: f32) -> Result<WorkspaceView, String> {
    let coloring = process::apply_threshold(&workspace.post_negate, threshold);
    let coloring_png = process::preview_png_gray(&coloring)?;
    Ok(WorkspaceView {
        title: workspace.title.clone(),
        source: workspace.source.clone(),
        source_url: workspace.source_url.clone(),
        page_id: workspace.page_id,
        original_png_base64: process::to_base64(&workspace.original_preview_png),
        coloring_png_base64: process::to_base64(&coloring_png),
        threshold,
    })
}

fn load_rgb_into_workspace(
    state: &AppState,
    title: String,
    source: String,
    source_url: Option<String>,
    page_id: Option<i64>,
    rgb: image::RgbImage,
    original_png: Vec<u8>,
    threshold: f32,
) -> Result<WorkspaceView, String> {
    let original_preview_png = process::preview_png_rgb(&rgb)?;
    let post_negate = process::prepare_edges(&rgb);
    let workspace = Workspace {
        title,
        source,
        source_url,
        page_id,
        original_png,
        original_preview_png,
        post_negate,
    };
    let view = view_from_workspace(&workspace, threshold)?;
    *state
        .workspace
        .lock()
        .map_err(|_| "Workspace lock was poisoned")? = Some(workspace);
    Ok(view)
}

#[tauri::command]
pub fn import_file(
    path: String,
    state: State<AppState>,
) -> Result<WorkspaceView, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("Could not read file: {e}"))?;
    let title = std::path::Path::new(&path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Untitled")
        .to_string();
    let (rgb, original_png) = process::png_from_format_bytes(&bytes)?;
    load_rgb_into_workspace(
        &state,
        title,
        "file".into(),
        Some(path),
        None,
        rgb,
        original_png,
        process::DEFAULT_THRESHOLD,
    )
}

#[tauri::command]
pub fn import_clipboard(
    app: AppHandle,
    state: State<AppState>,
) -> Result<WorkspaceView, String> {
    let image = app
        .clipboard()
        .read_image()
        .map_err(|_| "Clipboard does not contain an image".to_string())?;
    let width = image.width();
    let height = image.height();
    let rgba = image.rgba().to_vec();
    let rgb = process::flatten_from_rgba_raw(width, height, rgba)?;
    let original_png = process::encode_png_rgb(&rgb)?;
    load_rgb_into_workspace(
        &state,
        "Pasted image".into(),
        "clipboard".into(),
        None,
        None,
        rgb,
        original_png,
        process::DEFAULT_THRESHOLD,
    )
}

#[tauri::command]
pub async fn import_url(
    url: String,
    title: String,
    state: State<'_, AppState>,
) -> Result<WorkspaceView, String> {
    let client = state.http.clone();
    let bytes = bulbapedia::download(&client, &url).await?;
    let (rgb, original_png) = process::png_from_format_bytes(&bytes)?;
    let title = if title.trim().is_empty() {
        "Bulbapedia".into()
    } else {
        title
    };
    load_rgb_into_workspace(
        &state,
        title,
        "bulbapedia".into(),
        Some(url),
        None,
        rgb,
        original_png,
        process::DEFAULT_THRESHOLD,
    )
}

#[tauri::command]
pub async fn search_bulbapedia(
    query: String,
    state: State<'_, AppState>,
) -> Result<Vec<SearchHit>, String> {
    let client = state.http.clone();
    bulbapedia::search(&client, &query).await
}

#[tauri::command]
pub fn preview(threshold: f32, state: State<AppState>) -> Result<PreviewView, String> {
    let workspace = state
        .workspace
        .lock()
        .map_err(|_| "Workspace lock was poisoned")?;
    let workspace = workspace
        .as_ref()
        .ok_or_else(|| "Open, paste, or search for an image first".to_string())?;
    let coloring = process::apply_threshold(&workspace.post_negate, threshold);
    let coloring_png = process::preview_png_gray(&coloring)?;
    Ok(PreviewView {
        coloring_png_base64: process::to_base64(&coloring_png),
        threshold,
    })
}

#[tauri::command]
pub fn save_page(threshold: f32, state: State<AppState>) -> Result<WorkspaceView, String> {
    let mut workspace = state
        .workspace
        .lock()
        .map_err(|_| "Workspace lock was poisoned")?;
    let workspace = workspace
        .as_mut()
        .ok_or_else(|| "Open, paste, or search for an image first".to_string())?;

    let coloring = process::apply_threshold(&workspace.post_negate, threshold);
    let output_png = process::encode_png_gray(&coloring)?;

    let db = state.db.lock().map_err(|_| "Database lock was poisoned")?;
    let page_id = if let Some(id) = workspace.page_id {
        db::update_page(
            &db,
            id,
            &workspace.title,
            &output_png,
            threshold as f64,
        )?;
        id
    } else {
        db::insert_page(
            &db,
            &workspace.title,
            &workspace.source,
            workspace.source_url.as_deref(),
            &workspace.original_png,
            &output_png,
            threshold as f64,
        )?
    };
    drop(db);
    workspace.page_id = Some(page_id);
    view_from_workspace(workspace, threshold)
}

#[tauri::command]
pub fn list_pages(state: State<AppState>) -> Result<Vec<PageSummary>, String> {
    let db = state.db.lock().map_err(|_| "Database lock was poisoned")?;
    let rows = db::list_pages(&db)?;
    drop(db);
    let mut pages = Vec::with_capacity(rows.len());
    for (mut summary, original_png) in rows {
        let thumb = process::thumb_png(&original_png).unwrap_or(original_png);
        summary.thumb_png_base64 = process::to_base64(&thumb);
        pages.push(summary);
    }
    Ok(pages)
}

#[tauri::command]
pub fn load_page(id: i64, state: State<AppState>) -> Result<WorkspaceView, String> {
    let db = state.db.lock().map_err(|_| "Database lock was poisoned")?;
    let page = db::get_page(&db, id)?;
    drop(db);
    let (rgb, original_png) = process::png_from_format_bytes(&page.original_png)?;
    load_rgb_into_workspace(
        &state,
        page.title,
        page.source,
        page.source_url,
        Some(page.id),
        rgb,
        original_png,
        process::DEFAULT_THRESHOLD,
    )
}

#[tauri::command]
pub fn delete_page(id: i64, state: State<AppState>) -> Result<(), String> {
    let db = state.db.lock().map_err(|_| "Database lock was poisoned")?;
    db::delete_page(&db, id)?;
    drop(db);
    if let Ok(mut workspace) = state.workspace.lock() {
        if workspace.as_ref().is_some_and(|ws| ws.page_id == Some(id)) {
            if let Some(ws) = workspace.as_mut() {
                ws.page_id = None;
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn export_page(id: i64, path: String, state: State<AppState>) -> Result<(), String> {
    let db = state.db.lock().map_err(|_| "Database lock was poisoned")?;
    let page = db::get_page(&db, id)?;
    drop(db);
    let png = match page.output_png {
        Some(bytes) if !bytes.is_empty() => bytes,
        _ => {
            let (rgb, _) = process::png_from_format_bytes(&page.original_png)?;
            let edges = process::prepare_edges(&rgb);
            let coloring = process::apply_threshold(&edges, process::DEFAULT_THRESHOLD);
            process::encode_png_gray(&coloring)?
        }
    };
    write_png(&path, &png)
}

#[tauri::command]
pub fn export_current(path: String, threshold: f32, state: State<AppState>) -> Result<(), String> {
    let workspace = state
        .workspace
        .lock()
        .map_err(|_| "Workspace lock was poisoned")?;
    let workspace = workspace
        .as_ref()
        .ok_or_else(|| "Open, paste, or search for an image first".to_string())?;
    let coloring = process::apply_threshold(&workspace.post_negate, threshold);
    let png = process::encode_png_gray(&coloring)?;
    write_png(&path, &png)
}

fn write_png(path: &str, png: &[u8]) -> Result<(), String> {
    let mut dest = PathBuf::from(path);
    if dest.extension().is_none() {
        dest.set_extension("png");
    }
    std::fs::write(&dest, png).map_err(|e| format!("Could not export file: {e}"))
}
