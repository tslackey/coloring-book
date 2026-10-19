use std::collections::HashMap;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct PageSummary {
    pub id: i64,
    pub title: String,
    pub source: String,
    pub source_url: Option<String>,
    pub threshold: f64,
    pub created_at: String,
    pub updated_at: String,
    pub thumb_png_base64: String,
}

#[derive(Debug, Clone)]
pub struct PageRecord {
    pub id: i64,
    pub title: String,
    pub source: String,
    pub source_url: Option<String>,
    pub original_png: Vec<u8>,
    pub output_png: Option<Vec<u8>>,
    #[allow(dead_code)]
    pub threshold: f64,
}

pub fn open(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| format!("Could not open database: {e}"))?;
    conn.execute_batch(
        "
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS pages (
            id INTEGER PRIMARY KEY,
            title TEXT NOT NULL,
            source TEXT NOT NULL,
            source_url TEXT,
            original_png BLOB NOT NULL,
            output_png BLOB,
            threshold REAL NOT NULL DEFAULT 15,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS rosters (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            definition TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sprites (
            name TEXT PRIMARY KEY,
            png BLOB NOT NULL,
            source_url TEXT,
            fetched_at TEXT NOT NULL
        );
        ",
    )
    .map_err(|e| format!("Could not initialize database: {e}"))?;
    Ok(conn)
}

pub fn now_rfc3339() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format_unix(secs)
}

fn format_unix(secs: u64) -> String {
    let days = secs / 86400;
    let rem = secs % 86400;
    let hour = rem / 3600;
    let min = (rem % 3600) / 60;
    let sec = rem % 60;
    let (year, month, day) = civil_from_days(days as i64);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{min:02}:{sec:02}Z")
}

fn civil_from_days(days: i64) -> (i32, u32, u32) {
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y as i32, m as u32, d as u32)
}

pub fn insert_page(
    conn: &Connection,
    title: &str,
    source: &str,
    source_url: Option<&str>,
    original_png: &[u8],
    output_png: &[u8],
    threshold: f64,
) -> Result<i64, String> {
    let ts = now_rfc3339();
    conn.execute(
        "INSERT INTO pages (title, source, source_url, original_png, output_png, threshold, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            title,
            source,
            source_url,
            original_png,
            output_png,
            threshold,
            ts,
            ts
        ],
    )
    .map_err(|e| format!("Could not save page: {e}"))?;
    Ok(conn.last_insert_rowid())
}

pub fn update_page(
    conn: &Connection,
    id: i64,
    title: &str,
    output_png: &[u8],
    threshold: f64,
) -> Result<(), String> {
    let ts = now_rfc3339();
    let changed = conn
        .execute(
            "UPDATE pages SET title = ?1, output_png = ?2, threshold = ?3, updated_at = ?4 WHERE id = ?5",
            params![title, output_png, threshold, ts, id],
        )
        .map_err(|e| format!("Could not update page: {e}"))?;
    if changed == 0 {
        return Err("Page not found".into());
    }
    Ok(())
}

pub fn get_page(conn: &Connection, id: i64) -> Result<PageRecord, String> {
    conn.query_row(
        "SELECT id, title, source, source_url, original_png, output_png, threshold
         FROM pages WHERE id = ?1",
        params![id],
        |row| {
            Ok(PageRecord {
                id: row.get(0)?,
                title: row.get(1)?,
                source: row.get(2)?,
                source_url: row.get(3)?,
                original_png: row.get(4)?,
                output_png: row.get(5)?,
                threshold: row.get(6)?,
            })
        },
    )
    .optional()
    .map_err(|e| format!("Could not load page: {e}"))?
    .ok_or_else(|| "Page not found".to_string())
}

pub fn list_pages(conn: &Connection) -> Result<Vec<(PageSummary, Vec<u8>)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, title, source, source_url, threshold, created_at, updated_at, original_png
             FROM pages ORDER BY datetime(updated_at) DESC, id DESC",
        )
        .map_err(|e| format!("Could not list pages: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                PageSummary {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    source: row.get(2)?,
                    source_url: row.get(3)?,
                    threshold: row.get(4)?,
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                    thumb_png_base64: String::new(),
                },
                row.get::<_, Vec<u8>>(7)?,
            ))
        })
        .map_err(|e| format!("Could not list pages: {e}"))?;

    let mut pages = Vec::new();
    for row in rows {
        pages.push(row.map_err(|e| format!("Could not list pages: {e}"))?);
    }
    Ok(pages)
}

#[derive(Debug, Clone, Serialize)]
pub struct RosterRow {
    pub id: i64,
    pub name: String,
    pub definition: String,
    pub created_at: String,
    pub updated_at: String,
}

pub fn list_rosters(conn: &Connection) -> Result<Vec<RosterRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, definition, created_at, updated_at
             FROM rosters ORDER BY datetime(updated_at) DESC, id DESC",
        )
        .map_err(|e| format!("Could not list rosters: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok(RosterRow {
                id: row.get(0)?,
                name: row.get(1)?,
                definition: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
            })
        })
        .map_err(|e| format!("Could not list rosters: {e}"))?;
    let mut rosters = Vec::new();
    for row in rows {
        rosters.push(row.map_err(|e| format!("Could not list rosters: {e}"))?);
    }
    Ok(rosters)
}

pub fn save_roster(
    conn: &Connection,
    id: Option<i64>,
    name: &str,
    definition: &str,
) -> Result<i64, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Name the roster before saving".into());
    }
    serde_json::from_str::<serde_json::Value>(definition)
        .map_err(|_| "Roster definition was not valid JSON".to_string())?;
    let ts = now_rfc3339();
    if let Some(id) = id {
        let changed = conn
            .execute(
                "UPDATE rosters SET name = ?1, definition = ?2, updated_at = ?3 WHERE id = ?4",
                params![trimmed, definition, ts, id],
            )
            .map_err(|e| format!("Could not update roster: {e}"))?;
        if changed == 0 {
            return Err("Roster not found".into());
        }
        return Ok(id);
    }
    conn.execute(
        "INSERT INTO rosters (name, definition, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)",
        params![trimmed, definition, ts, ts],
    )
    .map_err(|e| format!("Could not save roster: {e}"))?;
    Ok(conn.last_insert_rowid())
}

pub fn delete_roster(conn: &Connection, id: i64) -> Result<(), String> {
    let changed = conn
        .execute("DELETE FROM rosters WHERE id = ?1", params![id])
        .map_err(|e| format!("Could not delete roster: {e}"))?;
    if changed == 0 {
        return Err("Roster not found".into());
    }
    Ok(())
}

pub fn get_sprites(conn: &Connection, names: &[String]) -> Result<HashMap<String, Vec<u8>>, String> {
    let mut sprites = HashMap::new();
    for name in names {
        let png = conn
            .query_row(
                "SELECT png FROM sprites WHERE name = ?1",
                params![name],
                |row| row.get::<_, Vec<u8>>(0),
            )
            .optional()
            .map_err(|e| format!("Could not read cached art: {e}"))?;
        if let Some(png) = png {
            sprites.insert(name.clone(), png);
        }
    }
    Ok(sprites)
}

pub fn put_sprite(
    conn: &Connection,
    name: &str,
    png: &[u8],
    source_url: &str,
) -> Result<(), String> {
    let ts = now_rfc3339();
    conn.execute(
        "INSERT INTO sprites (name, png, source_url, fetched_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(name) DO UPDATE SET png = excluded.png, source_url = excluded.source_url, fetched_at = excluded.fetched_at",
        params![name, png, source_url, ts],
    )
    .map_err(|e| format!("Could not cache art: {e}"))?;
    Ok(())
}

pub fn delete_page(conn: &Connection, id: i64) -> Result<(), String> {
    let changed = conn
        .execute("DELETE FROM pages WHERE id = ?1", params![id])
        .map_err(|e| format!("Could not delete page: {e}"))?;
    if changed == 0 {
        return Err("Page not found".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_page_blobs() {
        let conn = open(Path::new(":memory:")).expect("open db");
        let original = vec![1, 2, 3, 4];
        let output = vec![9, 8, 7];
        let id = insert_page(
            &conn,
            "Pikachu",
            "bulbapedia",
            Some("https://example.test"),
            &original,
            &output,
            15.0,
        )
        .unwrap();
        let page = get_page(&conn, id).unwrap();
        assert_eq!(page.title, "Pikachu");
        assert_eq!(page.original_png, original);
        assert_eq!(page.output_png.as_deref(), Some(output.as_slice()));
        delete_page(&conn, id).unwrap();
        assert!(get_page(&conn, id).is_err());
    }

    #[test]
    fn roster_and_sprite_roundtrip() {
        let conn = open(Path::new(":memory:")).expect("open db");
        let id = save_roster(&conn, None, "Field", r#"{"frame":"blue"}"#).unwrap();
        let updated = save_roster(&conn, Some(id), "Field & Sky", r#"{"frame":"blue"}"#).unwrap();
        assert_eq!(updated, id);
        let listed = list_rosters(&conn).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "Field & Sky");
        put_sprite(&conn, "Snorlax", &[1, 2, 3], "https://example.test/snorlax.png").unwrap();
        let sprites = get_sprites(&conn, &["Snorlax".into(), "Missing".into()]).unwrap();
        assert_eq!(sprites.get("Snorlax").map(Vec::as_slice), Some([1, 2, 3].as_slice()));
        assert!(!sprites.contains_key("Missing"));
        delete_roster(&conn, id).unwrap();
        assert!(list_rosters(&conn).unwrap().is_empty());
    }
}
