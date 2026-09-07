use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use image::imageops::FilterType;
use image::{DynamicImage, ExtendedColorType, GrayImage, ImageEncoder, RgbImage};
use imageproc::filter::filter;
use imageproc::kernel::Kernel;

const PREVIEW_MAX_SIDE: u32 = 900;
const THUMB_MAX_SIDE: u32 = 128;

/// ImageMagick `-edge 2` is a Laplacian over a (2*radius+1) neighborhood:
/// center = neighbor count, all other cells = -1.
const EDGE_KERNEL: [i32; 25] = [
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 24, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1,
];

pub fn decode_bytes(bytes: &[u8]) -> Result<DynamicImage, String> {
    image::load_from_memory(bytes).map_err(|e| format!("Could not decode image: {e}"))
}

pub fn flatten_to_rgb(img: DynamicImage) -> RgbImage {
    let rgba = img.to_rgba8();
    let (width, height) = rgba.dimensions();
    let mut rgb = RgbImage::new(width, height);
    for (x, y, pixel) in rgba.enumerate_pixels() {
        let alpha = pixel[3] as f32 / 255.0;
        let blend = |channel: u8| (channel as f32 * alpha + 255.0 * (1.0 - alpha)).round() as u8;
        rgb.put_pixel(
            x,
            y,
            image::Rgb([blend(pixel[0]), blend(pixel[1]), blend(pixel[2])]),
        );
    }
    rgb
}

pub fn flatten_from_rgba_raw(width: u32, height: u32, rgba: Vec<u8>) -> Result<RgbImage, String> {
    let buffer = image::RgbaImage::from_raw(width, height, rgba)
        .ok_or_else(|| "Clipboard image had an unexpected size".to_string())?;
    Ok(flatten_to_rgb(DynamicImage::ImageRgba8(buffer)))
}

/// Steps 1–4 of the magick pipeline. The result is cached so the slider only re-thresholds.
pub fn prepare_edges(rgb: &RgbImage) -> GrayImage {
    let gray = DynamicImage::ImageRgb8(rgb.clone()).to_luma8();
    let kernel = Kernel::new(&EDGE_KERNEL, 5, 5);
    let mut edges: GrayImage = filter(&gray, kernel, |value: i32| value.unsigned_abs().min(255) as u8);
    for pixel in edges.pixels_mut() {
        pixel[0] = 255 - pixel[0];
    }
    edges
}

pub fn apply_threshold(post_negate: &GrayImage, percent: f32) -> GrayImage {
    let cutoff = ((percent.clamp(0.0, 100.0) / 100.0) * 255.0).round() as u8;
    let mut out = post_negate.clone();
    for pixel in out.pixels_mut() {
        pixel[0] = if pixel[0] < cutoff { 0 } else { 255 };
    }
    out
}

pub fn encode_png_rgb(img: &RgbImage) -> Result<Vec<u8>, String> {
    encode_png(img.as_raw(), img.width(), img.height(), ExtendedColorType::Rgb8)
}

pub fn encode_png_gray(img: &GrayImage) -> Result<Vec<u8>, String> {
    encode_png(img.as_raw(), img.width(), img.height(), ExtendedColorType::L8)
}

fn encode_png(
    raw: &[u8],
    width: u32,
    height: u32,
    color: ExtendedColorType,
) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    image::codecs::png::PngEncoder::new(&mut buf)
        .write_image(raw, width, height, color)
        .map_err(|e| format!("Could not encode PNG: {e}"))?;
    Ok(buf)
}

pub fn preview_png_gray(img: &GrayImage) -> Result<Vec<u8>, String> {
    encode_png_gray(&resize_gray(img, PREVIEW_MAX_SIDE))
}

pub fn preview_png_rgb(img: &RgbImage) -> Result<Vec<u8>, String> {
    encode_png_rgb(&resize_rgb(img, PREVIEW_MAX_SIDE))
}

pub fn thumb_png(png_bytes: &[u8]) -> Result<Vec<u8>, String> {
    let img = decode_bytes(png_bytes)?;
    let rgb = flatten_to_rgb(img);
    encode_png_rgb(&resize_rgb(&rgb, THUMB_MAX_SIDE))
}

pub fn to_base64(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}

pub fn data_url_from_bytes(bytes: &[u8], content_type: &str) -> String {
    format!("data:{content_type};base64,{}", to_base64(bytes))
}

pub fn sniff_image_content_type(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        "image/png"
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        "image/jpeg"
    } else if bytes.starts_with(&[b'G', b'I', b'F']) {
        "image/gif"
    } else if bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        "image/webp"
    } else {
        "image/png"
    }
}

fn resize_gray(img: &GrayImage, max_side: u32) -> GrayImage {
    let (width, height) = img.dimensions();
    if width <= max_side && height <= max_side {
        return img.clone();
    }
    DynamicImage::ImageLuma8(img.clone())
        .resize(max_side, max_side, FilterType::Triangle)
        .to_luma8()
}

fn resize_rgb(img: &RgbImage, max_side: u32) -> RgbImage {
    let (width, height) = img.dimensions();
    if width <= max_side && height <= max_side {
        return img.clone();
    }
    DynamicImage::ImageRgb8(img.clone())
        .resize(max_side, max_side, FilterType::Triangle)
        .to_rgb8()
}

pub fn png_from_format_bytes(bytes: &[u8]) -> Result<(RgbImage, Vec<u8>), String> {
    let decoded = decode_bytes(bytes)?;
    let rgb = flatten_to_rgb(decoded);
    let png = encode_png_rgb(&rgb)?;
    Ok((rgb, png))
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgb;

    #[test]
    fn threshold_output_is_binary() {
        let mut rgb = RgbImage::new(48, 48);
        for (x, y, pixel) in rgb.enumerate_pixels_mut() {
            let value = if (x / 8 + y / 8) % 2 == 0 { 0 } else { 255 };
            *pixel = Rgb([value, value, value]);
        }
        let edges = prepare_edges(&rgb);
        let out = apply_threshold(&edges, 15.0);
        assert!(out.pixels().all(|pixel| pixel[0] == 0 || pixel[0] == 255));
        assert!(out.pixels().any(|pixel| pixel[0] == 0));
        assert!(out.pixels().any(|pixel| pixel[0] == 255));
    }
}
