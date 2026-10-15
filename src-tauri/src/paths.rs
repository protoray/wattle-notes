use crate::{error::fail, Result};
use std::path::{Component, Path, PathBuf};

pub const MAX_ATTACHMENT: u64 = 100 * 1024 * 1024;
pub const MAX_NOTE: u64 = 10 * 1024 * 1024;

pub fn validate_relative(value: &str) -> Result<()> {
    if value.is_empty() || value.len() > 1000 || value.contains('\\') || value.starts_with('/') {
        return Err(fail("Use a relative path inside the vault"));
    }
    for segment in value.split('/') {
        let stem = segment.split('.').next().unwrap_or("").to_uppercase();
        if segment.is_empty()
            || segment.len() > 255
            || segment == "."
            || segment == ".."
            || segment.eq_ignore_ascii_case(".notes")
            || segment.ends_with('.')
            || segment.ends_with(' ')
            || segment
                .chars()
                .any(|c| c.is_control() || "<>:\"|?*".contains(c))
            || ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str())
            || (stem.len() == 4
                && (stem.starts_with("COM") || stem.starts_with("LPT"))
                && matches!(stem.as_bytes()[3], b'1'..=b'9'))
        {
            return Err(fail(
                "This path is unsafe or incompatible with another desktop platform",
            ));
        }
    }
    Ok(())
}

pub fn inside(root: &Path, relative: &str) -> Result<PathBuf> {
    validate_relative(relative)?;
    let root = root.canonicalize()?;
    let target = root.join(relative);
    let mut walk = root.clone();
    for component in Path::new(relative).components() {
        if let Component::Normal(segment) = component {
            walk.push(segment);
            if let Ok(meta) = std::fs::symlink_metadata(&walk) {
                if meta.file_type().is_symlink() {
                    return Err(fail("Symbolic links cannot be followed inside a vault"));
                }
                if !walk.canonicalize()?.starts_with(&root) {
                    return Err(fail("Path escapes the selected vault"));
                }
            }
        } else {
            return Err(fail("Path escapes the selected vault"));
        }
    }
    Ok(target)
}

pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    let parent = path
        .parent()
        .ok_or_else(|| fail("Missing parent directory"))?;
    std::fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(".wattle-notes-{}.tmp", uuid::Uuid::new_v4()));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    #[cfg(windows)]
    if path.exists() {
        // Windows MoveFileExW supports replacing the destination atomically.
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "kernel32")]
        extern "system" {
            fn MoveFileExW(from: *const u16, to: *const u16, flags: u32) -> i32;
        }
        let from: Vec<u16> = temporary.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0x1 | 0x8) } == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        return Ok(());
    }
    std::fs::rename(&temporary, path)?;
    #[cfg(unix)]
    std::fs::File::open(parent)?.sync_all()?;
    Ok(())
}

pub fn canonical_name(path: &str) -> String {
    path.to_lowercase()
}
