use crate::{error::fail, links, paths, Result};
use serde::Serialize;
use std::{fs::File, io::Read, path::Path};

pub const MAX_INLINE_IMAGE: u64 = 10 * 1024 * 1024;

#[derive(Serialize)]
pub struct LocalImage {
    pub bytes: Vec<u8>,
    pub mime_type: &'static str,
}

// Read only an allowlisted raster image relative to the source note. Keep this
// boundary in the core so every native renderer uses the same path and size rules.
pub fn read(root: &Path, source_path: &str, target: &str) -> Result<LocalImage> {
    let decoded = links::percent_decode(target);
    if decoded.starts_with('/') || decoded.contains('\\') {
        return Err(fail("Use an image path relative to the note"));
    }
    let relative = links::normalize_relative(source_path, &decoded)
        .ok_or_else(|| fail("Attachment path escapes the vault"))?;
    let path = paths::inside(root, &relative)?;
    let extension = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_lowercase();
    let mime_type = match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        _ => return Err(fail("This image format is not previewed")),
    };
    // Check before opening as well: opening a FIFO can block before metadata
    // on the handle is available. Recheck the handle for replaced files.
    if !path.metadata()?.is_file() {
        return Err(fail("Select a regular image file"));
    }
    let file = File::open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(fail("Select a regular image file"));
    }
    if metadata.len() > MAX_INLINE_IMAGE {
        return Err(fail("Inline images are limited to 10 MiB"));
    }
    let mut bytes = Vec::new();
    file.take(MAX_INLINE_IMAGE + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_INLINE_IMAGE {
        return Err(fail("Inline images are limited to 10 MiB"));
    }
    Ok(LocalImage { bytes, mime_type })
}
