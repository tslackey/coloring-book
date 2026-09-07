use std::collections::{HashMap, HashSet};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use image::imageops::FilterType;
use image::{DynamicImage, ExtendedColorType, GrayImage, ImageEncoder, RgbImage};
use imageproc::contours::{find_contours, BorderType};
use imageproc::distance_transform::Norm;
use imageproc::drawing::{draw_filled_circle_mut, draw_polygon_mut};
use imageproc::filter::median_filter;
use imageproc::morphology::{close, dilate, open};
use imageproc::point::Point;

const PREVIEW_MAX_SIDE: u32 = 900;
const THUMB_MAX_SIDE: u32 = 128;
pub const DEFAULT_THRESHOLD: f32 = 50.0;
const PIXEL_MERGE: f32 = 10.0;
const REGION_MERGE_LARGE: f32 = 11.0;
const REGION_MERGE_SMALL: f32 = 15.0;
const L_WEIGHT: f32 = 0.35;

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

/// Segment into flat color regions, then cache border strength between those regions.
pub fn prepare_edges(rgb: &RgbImage) -> GrayImage {
    let owned;
    let rgb = if should_upsample(rgb.width(), rgb.height()) {
        owned = DynamicImage::ImageRgb8(rgb.clone())
            .resize_exact(rgb.width() * 2, rgb.height() * 2, FilterType::CatmullRom)
            .to_rgb8();
        &owned
    } else {
        rgb
    };
    let smoothed = median_filter(rgb, 1, 1);
    let (width, height) = smoothed.dimensions();
    let labs: Vec<(f32, f32, f32)> = smoothed.pixels().map(|p| rgb_to_lab(p.0)).collect();
    let background = background_mask(&labs, width, height);
    let linework = existing_linework(&labs, &background, width, height);
    let labels = segment_regions(&labs, &background, &linework, width, height);
    let mut strength = border_strength(&labels, &labs, &background, &linework, width, height);
    or_mask(&mut strength, &linework);
    strength
}

/// Default (~50) traces ink to paths and restrokes them. The slider only drops faint lines.
pub fn apply_threshold(strength: &GrayImage, percent: f32) -> GrayImage {
    let percent = percent.clamp(0.0, 100.0);
    let cutoff = if percent >= 50.0 {
        1
    } else {
        (1.0 + (50.0 - percent) / 50.0 * 90.0).round() as u8
    };
    let (width, height) = strength.dimensions();
    let mut lines = GrayImage::new(width, height);

    for (x, y, pixel) in strength.enumerate_pixels() {
        if pixel[0] >= cutoff {
            lines.put_pixel(x, y, image::Luma([255]));
        }
    }

    let lines = drop_specks(&lines, 12);
    let lines = close(&lines, Norm::L2, 1);
    let ink = trace_and_stroke(&lines);

    let mut out = GrayImage::new(ink.width(), ink.height());
    for (x, y, pixel) in ink.enumerate_pixels() {
        out.put_pixel(x, y, image::Luma([if pixel[0] > 0 { 0 } else { 255 }]));
    }
    out
}

fn should_upsample(width: u32, height: u32) -> bool {
    let side = width.max(height);
    (200..800).contains(&side)
}

fn background_mask(labs: &[(f32, f32, f32)], width: u32, height: u32) -> Vec<bool> {
    let mut samples = Vec::new();
    for x in 0..width {
        samples.push(labs[idx(x, 0, width)]);
        samples.push(labs[idx(x, height - 1, width)]);
    }
    for y in 0..height {
        samples.push(labs[idx(0, y, width)]);
        samples.push(labs[idx(width - 1, y, width)]);
    }
    let median = median_lab(&samples);

    let mut is_bg = vec![false; labs.len()];
    let mut stack: Vec<(u32, u32)> = Vec::new();
    let seed = |x: u32, y: u32, stack: &mut Vec<(u32, u32)>, is_bg: &mut [bool]| {
        let i = idx(x, y, width);
        if !is_bg[i] && same_background(labs[i], median) {
            is_bg[i] = true;
            stack.push((x, y));
        }
    };
    for x in 0..width {
        seed(x, 0, &mut stack, &mut is_bg);
        seed(x, height - 1, &mut stack, &mut is_bg);
    }
    for y in 0..height {
        seed(0, y, &mut stack, &mut is_bg);
        seed(width - 1, y, &mut stack, &mut is_bg);
    }
    while let Some((x, y)) = stack.pop() {
        for (nx, ny) in neighbors4(x, y, width, height) {
            let i = idx(nx, ny, width);
            if !is_bg[i] && same_background(labs[i], median) {
                is_bg[i] = true;
                stack.push((nx, ny));
            }
        }
    }
    is_bg
}

fn same_background(lab: (f32, f32, f32), median: (f32, f32, f32)) -> bool {
    delta_e(lab, median) < 11.0 && (lab.0 - median.0).abs() < 10.0
}

fn median_lab(samples: &[(f32, f32, f32)]) -> (f32, f32, f32) {
    let mut ls: Vec<f32> = samples.iter().map(|lab| lab.0).collect();
    let mut as_: Vec<f32> = samples.iter().map(|lab| lab.1).collect();
    let mut bs: Vec<f32> = samples.iter().map(|lab| lab.2).collect();
    ls.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    as_.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    bs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mid = samples.len() / 2;
    (ls[mid], as_[mid], bs[mid])
}

fn existing_linework(labs: &[(f32, f32, f32)], background: &[bool], width: u32, height: u32) -> GrayImage {
    let mut core = GrayImage::new(width, height);
    for y in 0..height {
        for x in 0..width {
            let i = idx(x, y, width);
            if background[i] {
                continue;
            }
            let chroma = (labs[i].1 * labs[i].1 + labs[i].2 * labs[i].2).sqrt();
            if labs[i].0 < 16.0 && chroma < 10.0 {
                core.put_pixel(x, y, image::Luma([255]));
            }
        }
    }
    let halo = dilate(&core, Norm::L2, 1);
    let mut ink = core.clone();
    for y in 0..height {
        for x in 0..width {
            if halo.get_pixel(x, y)[0] == 0 || ink.get_pixel(x, y)[0] > 0 {
                continue;
            }
            let i = idx(x, y, width);
            if background[i] {
                continue;
            }
            let chroma = (labs[i].1 * labs[i].1 + labs[i].2 * labs[i].2).sqrt();
            if labs[i].0 < 36.0 && chroma < 14.0 {
                ink.put_pixel(x, y, image::Luma([255]));
            }
        }
    }
    close(&ink, Norm::L2, 1)
}

fn or_mask(strength: &mut GrayImage, mask: &GrayImage) {
    for (dest, src) in strength.pixels_mut().zip(mask.pixels()) {
        if src[0] > 0 {
            dest[0] = dest[0].max(255);
        }
    }
}

fn trace_and_stroke(ink: &GrayImage) -> GrayImage {
    let (width, height) = ink.dimensions();
    let scale = if width.max(height) < 1100 { 2.0 } else { 1.0 };
    let fills = open(ink, Norm::L2, 2);
    let skeleton = zhang_suen_thin(ink);
    let radius = ((stroke_radius(width, height) as f32) * scale).round() as i32;
    let mut canvas = GrayImage::new(
        (width as f32 * scale).round() as u32,
        (height as f32 * scale).round() as u32,
    );

    for path in walk_skeleton(&skeleton) {
        if path.len() < 3 {
            continue;
        }
        let closed = path_is_closed(&path);
        let mut pts = rdp(&path, 1.7);
        if pts.len() < 2 {
            continue;
        }
        pts = chaikin(&pts, closed);
        pts = chaikin(&pts, closed);
        pts = chaikin(&pts, closed);
        if scale != 1.0 {
            for point in &mut pts {
                point.0 *= scale;
                point.1 *= scale;
            }
        }
        draw_round_polyline(&mut canvas, &pts, radius.max(2), closed);
    }

    for contour in find_contours::<i32>(&fills) {
        if contour.points.len() < 8 {
            continue;
        }
        let mut pts: Vec<(f32, f32)> = contour
            .points
            .iter()
            .map(|p| (p.x as f32 * scale, p.y as f32 * scale))
            .collect();
        pts = rdp(&pts, 1.8 * scale);
        pts = chaikin(&pts, true);
        pts = chaikin(&pts, true);
        if pts.len() < 3 {
            continue;
        }
        let poly: Vec<Point<i32>> = pts
            .iter()
            .map(|(x, y)| Point::new(x.round() as i32, y.round() as i32))
            .collect();
        let color = match contour.border_type {
            BorderType::Outer => image::Luma([255]),
            BorderType::Hole => image::Luma([0]),
        };
        draw_polygon_mut(&mut canvas, &poly, color);
    }

    if scale == 1.0 {
        return canvas;
    }
    let down = DynamicImage::ImageLuma8(canvas)
        .resize_exact(width, height, FilterType::Triangle)
        .to_luma8();
    let mut out = GrayImage::new(width, height);
    for (x, y, pixel) in down.enumerate_pixels() {
        if pixel[0] >= 96 {
            out.put_pixel(x, y, image::Luma([255]));
        }
    }
    out
}

fn stroke_radius(width: u32, height: u32) -> i32 {
    (width.max(height) / 200).clamp(2, 5) as i32
}

fn path_is_closed(path: &[(f32, f32)]) -> bool {
    if path.len() < 8 {
        return false;
    }
    let a = path[0];
    let b = path[path.len() - 1];
    let dx = a.0 - b.0;
    let dy = a.1 - b.1;
    dx * dx + dy * dy <= 4.0
}

fn drop_specks(ink: &GrayImage, min_area: u32) -> GrayImage {
    let (width, height) = ink.dimensions();
    let mut seen = vec![false; (width * height) as usize];
    let mut keep = GrayImage::new(width, height);
    for y in 0..height {
        for x in 0..width {
            let start = idx(x, y, width);
            if ink.get_pixel(x, y)[0] == 0 || seen[start] {
                continue;
            }
            let mut stack = vec![(x, y)];
            let mut blob = Vec::new();
            seen[start] = true;
            while let Some((cx, cy)) = stack.pop() {
                blob.push((cx, cy));
                for (nx, ny) in neighbors8(cx, cy, width, height) {
                    let i = idx(nx, ny, width);
                    if seen[i] || ink.get_pixel(nx, ny)[0] == 0 {
                        continue;
                    }
                    seen[i] = true;
                    stack.push((nx, ny));
                }
            }
            if blob.len() as u32 >= min_area {
                for (bx, by) in blob {
                    keep.put_pixel(bx, by, image::Luma([255]));
                }
            }
        }
    }
    keep
}

fn zhang_suen_thin(ink: &GrayImage) -> GrayImage {
    let (width, height) = ink.dimensions();
    let mut pixels: Vec<u8> = ink.as_raw().iter().map(|&v| if v > 0 { 1 } else { 0 }).collect();
    let at = |x: i32, y: i32| (y * width as i32 + x) as usize;
    loop {
        let mut changed = false;
        for step in 0..2 {
            let mut marked = Vec::new();
            for y in 1..height as i32 - 1 {
                for x in 1..width as i32 - 1 {
                    if pixels[at(x, y)] == 0 {
                        continue;
                    }
                    let n = [
                        pixels[at(x, y - 1)],
                        pixels[at(x + 1, y - 1)],
                        pixels[at(x + 1, y)],
                        pixels[at(x + 1, y + 1)],
                        pixels[at(x, y + 1)],
                        pixels[at(x - 1, y + 1)],
                        pixels[at(x - 1, y)],
                        pixels[at(x - 1, y - 1)],
                    ];
                    let neighbors = n.iter().copied().sum::<u8>();
                    if !(2..=6).contains(&neighbors) {
                        continue;
                    }
                    let transitions = (0..8)
                        .filter(|&i| n[i] == 0 && n[(i + 1) % 8] == 1)
                        .count();
                    if transitions != 1 {
                        continue;
                    }
                    let (a, b) = if step == 0 {
                        (n[0] * n[2] * n[4], n[2] * n[4] * n[6])
                    } else {
                        (n[0] * n[2] * n[6], n[0] * n[4] * n[6])
                    };
                    if a == 0 && b == 0 {
                        marked.push(at(x, y));
                    }
                }
            }
            if marked.is_empty() {
                continue;
            }
            changed = true;
            for i in marked {
                pixels[i] = 0;
            }
        }
        if !changed {
            break;
        }
    }
    let mut out = GrayImage::new(width, height);
    for (i, value) in pixels.into_iter().enumerate() {
        if value > 0 {
            out.as_mut()[i] = 255;
        }
    }
    out
}

fn walk_skeleton(skeleton: &GrayImage) -> Vec<Vec<(f32, f32)>> {
    let (width, height) = skeleton.dimensions();
    let mut ink: HashSet<(u32, u32)> = HashSet::new();
    for y in 0..height {
        for x in 0..width {
            if skeleton.get_pixel(x, y)[0] > 0 {
                ink.insert((x, y));
            }
        }
    }
    let degree = |p: (u32, u32), ink: &HashSet<(u32, u32)>| {
        neighbors8(p.0, p.1, width, height)
            .into_iter()
            .filter(|q| ink.contains(q))
            .count()
    };
    let mut used = HashSet::new();
    let mut paths = Vec::new();

    let mut endpoints: Vec<(u32, u32)> = ink
        .iter()
        .copied()
        .filter(|&p| degree(p, &ink) == 1)
        .collect();
    endpoints.sort_by_key(|p| (p.1, p.0));
    for start in endpoints {
        if used.contains(&start) {
            continue;
        }
        paths.push(walk_path(start, None, &ink, &mut used, width, height));
    }

    let mut junctions: Vec<(u32, u32)> = ink
        .iter()
        .copied()
        .filter(|&p| degree(p, &ink) >= 3)
        .collect();
    junctions.sort_by_key(|p| (p.1, p.0));
    for junction in junctions {
        let mut nbrs: Vec<(u32, u32)> = neighbors8(junction.0, junction.1, width, height)
            .into_iter()
            .filter(|q| ink.contains(q) && !used.contains(q))
            .collect();
        nbrs.sort_by_key(|p| (p.1, p.0));
        for nbr in nbrs {
            if used.contains(&nbr) {
                continue;
            }
            paths.push(walk_path(
                junction,
                Some(nbr),
                &ink,
                &mut used,
                width,
                height,
            ));
        }
    }

    let mut rest: Vec<(u32, u32)> = ink
        .iter()
        .copied()
        .filter(|p| !used.contains(p) && degree(*p, &ink) < 3)
        .collect();
    rest.sort_by_key(|p| (p.1, p.0));
    for start in rest {
        if used.contains(&start) {
            continue;
        }
        paths.push(walk_path(start, None, &ink, &mut used, width, height));
    }
    paths
}

fn walk_path(
    start: (u32, u32),
    first: Option<(u32, u32)>,
    ink: &HashSet<(u32, u32)>,
    used: &mut HashSet<(u32, u32)>,
    width: u32,
    height: u32,
) -> Vec<(f32, f32)> {
    let mut path = vec![(start.0 as f32, start.1 as f32)];
    if skeleton_degree(start, ink, width, height) < 3 {
        used.insert(start);
    }
    let mut prev = start;
    let mut current = start;
    if let Some(first) = first {
        path.push((first.0 as f32, first.1 as f32));
        if skeleton_degree(first, ink, width, height) < 3 {
            used.insert(first);
        }
        current = first;
    }

    loop {
        let nbrs: Vec<(u32, u32)> = neighbors8(current.0, current.1, width, height)
            .into_iter()
            .filter(|q| ink.contains(q) && *q != prev && !used.contains(q))
            .collect();
        if nbrs.is_empty() {
            break;
        }
        let next = pick_next(current, prev, &nbrs);
        path.push((next.0 as f32, next.1 as f32));
        let deg = skeleton_degree(next, ink, width, height);
        if deg == 1 {
            used.insert(next);
            break;
        }
        if deg >= 3 && path.len() > 2 {
            break;
        }
        used.insert(next);
        prev = current;
        current = next;
    }
    path
}

fn skeleton_degree(
    p: (u32, u32),
    ink: &HashSet<(u32, u32)>,
    width: u32,
    height: u32,
) -> usize {
    neighbors8(p.0, p.1, width, height)
        .into_iter()
        .filter(|q| ink.contains(q))
        .count()
}

fn pick_next(current: (u32, u32), prev: (u32, u32), nbrs: &[(u32, u32)]) -> (u32, u32) {
    if nbrs.len() == 1 {
        return nbrs[0];
    }
    let vx = current.0 as f32 - prev.0 as f32;
    let vy = current.1 as f32 - prev.1 as f32;
    nbrs
        .iter()
        .copied()
        .max_by(|a, b| {
            let da = (a.0 as f32 - current.0 as f32) * vx + (a.1 as f32 - current.1 as f32) * vy;
            let db = (b.0 as f32 - current.0 as f32) * vx + (b.1 as f32 - current.1 as f32) * vy;
            da.partial_cmp(&db).unwrap_or(std::cmp::Ordering::Equal)
        })
        .unwrap_or(nbrs[0])
}

fn rdp(points: &[(f32, f32)], epsilon: f32) -> Vec<(f32, f32)> {
    if points.len() < 3 {
        return points.to_vec();
    }
    let first = points[0];
    let last = points[points.len() - 1];
    let mut max_dist = 0.0;
    let mut max_i = 0;
    for (i, point) in points.iter().enumerate().skip(1).take(points.len() - 2) {
        let dist = point_line_distance(*point, first, last);
        if dist > max_dist {
            max_dist = dist;
            max_i = i;
        }
    }
    if max_dist > epsilon {
        let mut left = rdp(&points[..=max_i], epsilon);
        let right = rdp(&points[max_i..], epsilon);
        left.pop();
        left.extend(right);
        left
    } else {
        vec![first, last]
    }
}

fn point_line_distance(point: (f32, f32), a: (f32, f32), b: (f32, f32)) -> f32 {
    let dx = b.0 - a.0;
    let dy = b.1 - a.1;
    let len = (dx * dx + dy * dy).sqrt();
    if len < 1e-4 {
        let vx = point.0 - a.0;
        let vy = point.1 - a.1;
        return (vx * vx + vy * vy).sqrt();
    }
    ((point.0 - a.0) * dy - (point.1 - a.1) * dx).abs() / len
}

fn chaikin(points: &[(f32, f32)], closed: bool) -> Vec<(f32, f32)> {
    let n = points.len();
    if n < 3 {
        return points.to_vec();
    }
    let mut out = Vec::with_capacity(n * 2);
    let last = if closed { n } else { n - 1 };
    if !closed {
        out.push(points[0]);
    }
    for i in 0..last {
        let a = points[i];
        let b = points[(i + 1) % n];
        out.push((a.0 * 0.75 + b.0 * 0.25, a.1 * 0.75 + b.1 * 0.25));
        out.push((a.0 * 0.25 + b.0 * 0.75, a.1 * 0.25 + b.1 * 0.75));
    }
    if !closed {
        out.push(points[n - 1]);
    }
    out
}

fn draw_round_polyline(ink: &mut GrayImage, points: &[(f32, f32)], radius: i32, closed: bool) {
    if points.is_empty() {
        return;
    }
    let radius = radius.max(1);
    let count = if closed { points.len() } else { points.len() - 1 };
    for i in 0..count {
        let start = points[i];
        let end = points[(i + 1) % points.len()];
        stamp_disk(ink, start, end, radius);
    }
}

fn stamp_disk(ink: &mut GrayImage, start: (f32, f32), end: (f32, f32), radius: i32) {
    let dx = end.0 - start.0;
    let dy = end.1 - start.1;
    let dist = (dx * dx + dy * dy).sqrt().max(1.0);
    let steps = dist.ceil() as i32;
    for step in 0..=steps {
        let t = step as f32 / steps as f32;
        let x = (start.0 + dx * t).round() as i32;
        let y = (start.1 + dy * t).round() as i32;
        draw_filled_circle_mut(ink, (x, y), radius, image::Luma([255]));
    }
}

fn segment_regions(
    labs: &[(f32, f32, f32)],
    background: &[bool],
    linework: &GrayImage,
    width: u32,
    height: u32,
) -> Vec<usize> {
    let len = labs.len();
    let mut uf = UnionFind::new(len);

    for y in 0..height {
        for x in 0..width {
            let i = idx(x, y, width);
            if x + 1 < width {
                maybe_merge(&mut uf, labs, background, linework, i, idx(x + 1, y, width));
            }
            if y + 1 < height {
                maybe_merge(&mut uf, labs, background, linework, i, idx(x, y + 1, width));
            }
        }
    }

    let min_region = ((width * height) / 25_000).max(72);
    merge_similar_regions(&mut uf, labs, background, width, height, min_region);
    absorb_specks(&mut uf, labs, background, width, height, min_region);
    (0..len).map(|i| uf.find(i)).collect()
}

fn maybe_merge(
    uf: &mut UnionFind,
    labs: &[(f32, f32, f32)],
    background: &[bool],
    linework: &GrayImage,
    a: usize,
    b: usize,
) {
    if background[a] != background[b] {
        return;
    }
    if background[a] && background[b] {
        uf.union(a, b);
        return;
    }
    let ink_a = linework.as_raw()[a] > 0;
    let ink_b = linework.as_raw()[b] > 0;
    if ink_a != ink_b {
        return;
    }
    if ink_a && ink_b {
        uf.union(a, b);
        return;
    }
    if chroma_dist(labs[a], labs[b]) < PIXEL_MERGE {
        uf.union(a, b);
    }
}

fn merge_similar_regions(
    uf: &mut UnionFind,
    labs: &[(f32, f32, f32)],
    background: &[bool],
    width: u32,
    height: u32,
    min_region: u32,
) {
    for _ in 0..6 {
        let (mut size, mut means) = region_stats(uf, labs, width * height);
        let neighbor_votes = adjacent_votes(uf, width, height);
        let fg: u32 = size
            .iter()
            .filter(|(root, _)| !background[**root])
            .map(|(_, n)| *n)
            .sum();
        let small_cut = min_region.saturating_mul(4).max(fg / 70);

        let mut pairs: Vec<(f32, usize, usize)> = Vec::new();
        for (&a, votes) in &neighbor_votes {
            if background[a] {
                continue;
            }
            for (&b, _) in votes {
                if b <= a || background[b] {
                    continue;
                }
                pairs.push((chroma_dist(means[&a], means[&b]), a, b));
            }
        }
        pairs.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

        let mut merged = false;
        for (_, a, b) in pairs {
            let a = uf.find(a);
            let b = uf.find(b);
            if a == b || background[a] != background[b] {
                continue;
            }
            let dist = chroma_dist(means[&a], means[&b]);
            let smallest = size[&a].min(size[&b]);
            let limit = if smallest < small_cut {
                REGION_MERGE_SMALL
            } else {
                REGION_MERGE_LARGE
            };
            if dist >= limit {
                continue;
            }
            let (sa, sb) = (size[&a], size[&b]);
            let (ma, mb) = (means[&a], means[&b]);
            uf.union(a, b);
            let root = uf.find(a);
            let n = (sa + sb) as f32;
            means.insert(
                root,
                (
                    (ma.0 * sa as f32 + mb.0 * sb as f32) / n,
                    (ma.1 * sa as f32 + mb.1 * sb as f32) / n,
                    (ma.2 * sa as f32 + mb.2 * sb as f32) / n,
                ),
            );
            size.insert(root, sa + sb);
            merged = true;
        }
        if !merged {
            break;
        }
    }
}

fn absorb_specks(
    uf: &mut UnionFind,
    labs: &[(f32, f32, f32)],
    background: &[bool],
    width: u32,
    height: u32,
    min_region: u32,
) {
    for _ in 0..2 {
        let (size, means) = region_stats(uf, labs, width * height);
        let neighbor_votes = adjacent_votes(uf, width, height);
        let roots: Vec<usize> = size.keys().copied().collect();
        for root in roots {
            if size.get(&root).copied().unwrap_or(0) >= min_region {
                continue;
            }
            let Some(votes) = neighbor_votes.get(&root) else {
                continue;
            };
            let best = votes
                .iter()
                .filter(|(&other, _)| background[root] == background[other])
                .filter(|(&other, _)| chroma_dist(means[&root], means[&other]) < 16.0)
                .max_by_key(|(_, n)| *n)
                .map(|(&other, _)| other);
            if let Some(other) = best {
                uf.union(root, other);
            }
        }
    }
}

fn region_stats(
    uf: &mut UnionFind,
    labs: &[(f32, f32, f32)],
    pixel_count: u32,
) -> (HashMap<usize, u32>, HashMap<usize, (f32, f32, f32)>) {
    let mut size: HashMap<usize, u32> = HashMap::new();
    let mut sums: HashMap<usize, (f32, f32, f32)> = HashMap::new();
    for i in 0..pixel_count as usize {
        let root = uf.find(i);
        *size.entry(root).or_insert(0) += 1;
        let entry = sums.entry(root).or_insert((0.0, 0.0, 0.0));
        entry.0 += labs[i].0;
        entry.1 += labs[i].1;
        entry.2 += labs[i].2;
    }
    let means = sums
        .into_iter()
        .map(|(root, (l, a, b))| {
            let n = size[&root] as f32;
            (root, (l / n, a / n, b / n))
        })
        .collect();
    (size, means)
}

fn adjacent_votes(uf: &mut UnionFind, width: u32, height: u32) -> HashMap<usize, HashMap<usize, u32>> {
    let mut neighbor_votes: HashMap<usize, HashMap<usize, u32>> = HashMap::new();
    for y in 0..height {
        for x in 0..width {
            let a = uf.find(idx(x, y, width));
            if x + 1 < width {
                let b = uf.find(idx(x + 1, y, width));
                if a != b {
                    *neighbor_votes.entry(a).or_default().entry(b).or_insert(0) += 1;
                    *neighbor_votes.entry(b).or_default().entry(a).or_insert(0) += 1;
                }
            }
            if y + 1 < height {
                let b = uf.find(idx(x, y + 1, width));
                if a != b {
                    *neighbor_votes.entry(a).or_default().entry(b).or_insert(0) += 1;
                    *neighbor_votes.entry(b).or_default().entry(a).or_insert(0) += 1;
                }
            }
        }
    }
    neighbor_votes
}

fn border_strength(
    labels: &[usize],
    labs: &[(f32, f32, f32)],
    background: &[bool],
    linework: &GrayImage,
    width: u32,
    height: u32,
) -> GrayImage {
    let mut means: HashMap<usize, (f32, f32, f32, f32)> = HashMap::new();
    for (i, label) in labels.iter().enumerate() {
        let entry = means.entry(*label).or_insert((0.0, 0.0, 0.0, 0.0));
        entry.0 += labs[i].0;
        entry.1 += labs[i].1;
        entry.2 += labs[i].2;
        entry.3 += 1.0;
    }
    let sizes: HashMap<usize, f32> = means
        .iter()
        .map(|(label, entry)| (*label, entry.3))
        .collect();
    let means: HashMap<usize, (f32, f32, f32)> = means
        .into_iter()
        .map(|(label, (l, a, b, n))| (label, (l / n, a / n, b / n)))
        .collect();
    let min_keep = ((width * height) / 12_000).max(90) as f32;

    let mut strength = GrayImage::new(width, height);
    for y in 0..height {
        for x in 0..width {
            let i = idx(x, y, width);
            if background[i] || linework.get_pixel(x, y)[0] > 0 {
                continue;
            }
            let here = labels[i];
            let mut best = 0.0_f32;
            for (nx, ny) in neighbors8(x, y, width, height) {
                let j = idx(nx, ny, width);
                let next = labels[j];
                if next == here {
                    continue;
                }
                if background[j] {
                    best = best.max(80.0);
                    continue;
                }
                let smallest = sizes[&here].min(sizes[&next]);
                let contrast = delta_e(means[&here], means[&next]);
                if smallest < min_keep && contrast < 22.0 {
                    continue;
                }
                best = best.max(contrast.max(18.0));
            }
            if best > 0.0 {
                strength.put_pixel(x, y, image::Luma([delta_e_to_strength(best)]));
            }
        }
    }
    strength
}

struct UnionFind {
    parent: Vec<usize>,
    rank: Vec<u8>,
}

impl UnionFind {
    fn new(len: usize) -> Self {
        Self {
            parent: (0..len).collect(),
            rank: vec![0; len],
        }
    }

    fn find(&mut self, mut node: usize) -> usize {
        while self.parent[node] != node {
            let parent = self.parent[node];
            self.parent[node] = self.parent[parent];
            node = parent;
        }
        node
    }

    fn union(&mut self, a: usize, b: usize) {
        let mut a = self.find(a);
        let mut b = self.find(b);
        if a == b {
            return;
        }
        if self.rank[a] < self.rank[b] {
            std::mem::swap(&mut a, &mut b);
        }
        self.parent[b] = a;
        if self.rank[a] == self.rank[b] {
            self.rank[a] += 1;
        }
    }
}

fn idx(x: u32, y: u32, width: u32) -> usize {
    (y * width + x) as usize
}

fn neighbors4(x: u32, y: u32, width: u32, height: u32) -> Vec<(u32, u32)> {
    let mut out = Vec::with_capacity(4);
    if x > 0 {
        out.push((x - 1, y));
    }
    if x + 1 < width {
        out.push((x + 1, y));
    }
    if y > 0 {
        out.push((x, y - 1));
    }
    if y + 1 < height {
        out.push((x, y + 1));
    }
    out
}

fn neighbors8(x: u32, y: u32, width: u32, height: u32) -> Vec<(u32, u32)> {
    let mut out = Vec::with_capacity(8);
    let x0 = x.saturating_sub(1);
    let y0 = y.saturating_sub(1);
    let x1 = (x + 1).min(width - 1);
    let y1 = (y + 1).min(height - 1);
    for ny in y0..=y1 {
        for nx in x0..=x1 {
            if nx != x || ny != y {
                out.push((nx, ny));
            }
        }
    }
    out
}

fn srgb_to_linear(channel: f32) -> f32 {
    let c = channel / 255.0;
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

fn rgb_to_lab(rgb: [u8; 3]) -> (f32, f32, f32) {
    let r = srgb_to_linear(rgb[0] as f32);
    let g = srgb_to_linear(rgb[1] as f32);
    let b = srgb_to_linear(rgb[2] as f32);
    let x = r * 0.4124564 + g * 0.3575761 + b * 0.1804375;
    let y = r * 0.2126729 + g * 0.7151522 + b * 0.0721750;
    let z = r * 0.0193339 + g * 0.1191920 + b * 0.9503041;
    let fx = lab_f(x / 0.95047);
    let fy = lab_f(y);
    let fz = lab_f(z / 1.08883);
    (
        116.0 * fy - 16.0,
        500.0 * (fx - fy),
        200.0 * (fy - fz),
    )
}

fn lab_f(t: f32) -> f32 {
    const EPS: f32 = 0.008856;
    const KAPPA: f32 = 7.787;
    if t > EPS {
        t.cbrt()
    } else {
        KAPPA * t + 16.0 / 116.0
    }
}

fn delta_e(a: (f32, f32, f32), b: (f32, f32, f32)) -> f32 {
    let dl = a.0 - b.0;
    let da = a.1 - b.1;
    let db = a.2 - b.2;
    (dl * dl + da * da + db * db).sqrt()
}

fn chroma_dist(a: (f32, f32, f32), b: (f32, f32, f32)) -> f32 {
    let dl = (a.0 - b.0) * L_WEIGHT;
    let da = a.1 - b.1;
    let db = a.2 - b.2;
    (dl * dl + da * da + db * db).sqrt()
}

fn delta_e_to_strength(delta: f32) -> u8 {
    if delta <= 0.5 {
        return 0;
    }
    (delta * 4.2).clamp(0.0, 255.0).round() as u8
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
        let out = apply_threshold(&edges, DEFAULT_THRESHOLD);
        assert!(out.pixels().all(|pixel| pixel[0] == 0 || pixel[0] == 255));
        assert!(out.pixels().any(|pixel| pixel[0] == 0));
        assert!(out.pixels().any(|pixel| pixel[0] == 255));
    }

    #[test]
    fn yellow_and_red_get_a_solid_border() {
        let mut rgb = RgbImage::new(32, 32);
        for (x, y, pixel) in rgb.enumerate_pixels_mut() {
            *pixel = if x < 16 {
                Rgb([255, 220, 20])
            } else {
                Rgb([230, 40, 40])
            };
            let _ = y;
        }
        let out = apply_threshold(&prepare_edges(&rgb), DEFAULT_THRESHOLD);
        let border_ink = (0..32)
            .filter(|&y| out.get_pixel(15, y)[0] == 0 || out.get_pixel(16, y)[0] == 0)
            .count();
        assert!(border_ink > 20, "expected a solid vertical color border");
        assert_eq!(out.get_pixel(4, 16)[0], 255);
        assert_eq!(out.get_pixel(28, 16)[0], 255);
    }

    #[test]
    fn anti_aliased_color_border_stays_a_line() {
        let mut rgb = RgbImage::new(48, 32);
        for (x, y, pixel) in rgb.enumerate_pixels_mut() {
            *pixel = if x < 22 {
                Rgb([255, 220, 20])
            } else if x > 25 {
                Rgb([220, 40, 40])
            } else {
                let t = (x - 22) as f32 / 3.0;
                Rgb([
                    (255.0 * (1.0 - t) + 220.0 * t).round() as u8,
                    (220.0 * (1.0 - t) + 40.0 * t).round() as u8,
                    (20.0 * (1.0 - t) + 40.0 * t).round() as u8,
                ])
            };
            let _ = y;
        }
        let out = apply_threshold(&prepare_edges(&rgb), DEFAULT_THRESHOLD);
        let border_ink = (0..32)
            .filter(|&y| (20..28).any(|x| out.get_pixel(x, y)[0] == 0))
            .count();
        assert!(border_ink > 20, "soft color blends should still get a line");
        assert_eq!(out.get_pixel(6, 16)[0], 255);
        assert_eq!(out.get_pixel(40, 16)[0], 255);
    }

    #[test]
    fn dark_gradient_does_not_fill_with_ink() {
        let mut rgb = RgbImage::new(64, 64);
        for (x, y, pixel) in rgb.enumerate_pixels_mut() {
            let value = 24 + (x / 4) as u8;
            *pixel = Rgb([value, value / 2, value.saturating_add(12)]);
            let _ = y;
        }
        let out = apply_threshold(&prepare_edges(&rgb), 97.0);
        let ink = out.pixels().filter(|pixel| pixel[0] == 0).count();
        assert!(
            ink < 64 * 64 / 8,
            "smooth dark shading should stay empty, got {ink} ink pixels"
        );
    }

    #[test]
    fn write_pokemon_samples_if_present() {
        for name in ["pikachu", "grapploct"] {
            let path = format!("/tmp/{name}-src.png");
            if !std::path::Path::new(&path).exists() {
                continue;
            }
            let bytes = std::fs::read(&path).unwrap();
            let (rgb, _) = png_from_format_bytes(&bytes).unwrap();
            let out = apply_threshold(&prepare_edges(&rgb), DEFAULT_THRESHOLD);
            std::fs::write(
                format!("/tmp/{name}-coloring-default.png"),
                encode_png_gray(&out).unwrap(),
            )
            .unwrap();
            let ink = out.pixels().filter(|pixel| pixel[0] == 0).count();
            let total = out.width() as usize * out.height() as usize;
            assert!(ink > 0 && ink < total / 3, "{name} should be line art, ink={ink}");
        }
    }
}
