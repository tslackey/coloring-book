use futures::future::join_all;
use reqwest::Client;
use serde::{Deserialize, Serialize};

use crate::process;

const API_URL: &str = "https://bulbapedia.bulbagarden.net/w/api.php";
const USER_AGENT: &str = "ColoringBook/0.1 (local desktop app; pokemon coloring pages)";

#[derive(Debug, Clone, Serialize)]
pub struct SearchHit {
    pub title: String,
    pub original_url: String,
    pub thumb_data_url: Option<String>,
}

#[derive(Deserialize)]
struct ApiResponse {
    query: Option<Query>,
}

#[derive(Deserialize)]
struct Query {
    pages: Option<Vec<Page>>,
}

#[derive(Deserialize)]
struct Page {
    title: String,
    thumbnail: Option<WikiImage>,
    original: Option<WikiImage>,
}

#[derive(Deserialize)]
struct WikiImage {
    source: String,
}

pub fn http_client() -> Result<Client, String> {
    Client::builder()
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| format!("Could not create HTTP client: {e}"))
}

pub async fn search(client: &Client, query: &str) -> Result<Vec<SearchHit>, String> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Err("Enter a Pokémon or page name to search".into());
    }

    let response = client
        .get(API_URL)
        .header("Accept", "application/json")
        .query(&[
            ("action", "query"),
            ("format", "json"),
            ("formatversion", "2"),
            ("generator", "search"),
            ("gsrsearch", trimmed),
            ("gsrlimit", "15"),
            ("gsrnamespace", "0"),
            ("prop", "pageimages"),
            ("piprop", "thumbnail|original|name"),
            ("pithumbsize", "240"),
        ])
        .send()
        .await
        .map_err(|e| format!("Bulbapedia search failed: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Bulbapedia search returned HTTP {}",
            response.status()
        ));
    }

    let payload: ApiResponse = response
        .json()
        .await
        .map_err(|e| format!("Could not parse Bulbapedia response: {e}"))?;

    let pages = payload
        .query
        .and_then(|q| q.pages)
        .unwrap_or_default();

    let tasks = pages.into_iter().filter_map(|page| {
        let original_url = page
            .original
            .as_ref()
            .or(page.thumbnail.as_ref())
            .map(|img| img.source.clone())?;
        let thumb_url: Option<String> = page
            .thumbnail
            .as_ref()
            .map(|img| img.source.clone())
            .or_else(|| Some(original_url.clone()));
        let title = page.title;
        let client = client.clone();
        Some(async move {
            let thumb_data_url = match &thumb_url {
                Some(thumb) => download_data_url(&client, thumb).await.ok(),
                None => None,
            };
            SearchHit {
                title,
                original_url,
                thumb_data_url,
            }
        })
    });

    Ok(rank_hits(join_all(tasks).await, trimmed))
}

fn rank_hits(mut hits: Vec<SearchHit>, query: &str) -> Vec<SearchHit> {
    let needle = query.to_lowercase();
    hits.sort_by_key(|hit| {
        let title = hit.title.to_lowercase();
        let exact = title == needle || title == format!("{needle} (pokémon)");
        let pokemon_article = title.contains("(pokémon)");
        let prefix = title.starts_with(&needle);
        let has_art = hit.thumb_data_url.is_some();
        (!exact, !pokemon_article, !prefix, !has_art, hit.title.clone())
    });
    hits
}

pub async fn download(client: &Client, url: &str) -> Result<Vec<u8>, String> {
    let response = client
        .get(url)
        .header("Referer", "https://bulbapedia.bulbagarden.net/")
        .header("Accept", "image/avif,image/webp,image/apng,image/*,*/*;q=0.8")
        .send()
        .await
        .map_err(|e| format!("Could not download image: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Image download returned HTTP {}",
            response.status()
        ));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Could not read downloaded image: {e}"))?;
    if bytes.is_empty() {
        return Err("Downloaded image was empty".into());
    }
    Ok(bytes.to_vec())
}

async fn download_data_url(client: &Client, url: &str) -> Result<String, String> {
    let bytes = download(client, url).await?;
    let content_type = process::sniff_image_content_type(&bytes);
    Ok(process::data_url_from_bytes(&bytes, content_type))
}
