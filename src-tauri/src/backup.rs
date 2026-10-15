//! Authenticated, streamed full snapshots. No archive paths are trusted before validation.
use crate::{
    crypto::{self, VaultConfig, VaultKey},
    error::fail,
    paths,
    vault::{self, Vault},
    Result,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};
use uuid::Uuid;

pub const MAX_BACKUP: u64 = 4 * 1024 * 1024 * 1024;
const MAGIC: &[u8; 10] = b"WNBACKUP1\n";
const MAX_ENTRIES: usize = 20000;
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    version: u32,
    id: String,
    name: String,
    directories: Vec<String>,
    entries: Vec<Entry>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    path: String,
    metadata: bool,
    size: u64,
    hash: String,
}

fn metadata_path(path: &str) -> Result<()> {
    paths::validate_relative(path)?;
    if path == "index.db" {
        return Ok(());
    }
    let valid = path
        .strip_prefix("revisions/")
        .and_then(|p| p.strip_suffix(".json"))
        .or_else(|| path.strip_prefix("blobs/"));
    if valid.is_none_or(|id| Uuid::parse_str(id).is_err()) {
        return Err(fail("Unsafe backup metadata path"));
    }
    Ok(())
}
fn validate(manifest: &Manifest) -> Result<()> {
    if manifest.version != 1
        || Uuid::parse_str(&manifest.id).is_err()
        || manifest.entries.len() + manifest.directories.len() > MAX_ENTRIES
    {
        return Err(fail("Unsupported or oversized backup manifest"));
    }
    let mut names = HashSet::new();
    let mut directory_names = HashSet::new();
    for directory in &manifest.directories {
        paths::validate_relative(directory)?;
        if !names.insert(paths::canonical_name(directory)) {
            return Err(fail("Backup has colliding paths"));
        }
        directory_names.insert(directory.as_str());
    }
    for directory in &manifest.directories {
        if let Some(parent) = Path::new(directory)
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
        {
            if !directory_names
                .contains(parent.to_str().ok_or_else(|| fail("Invalid backup path"))?)
            {
                return Err(fail("Backup omits or misnames a parent directory"));
            }
        }
    }
    for entry in &manifest.entries {
        if entry.metadata {
            metadata_path(&entry.path)?;
        } else {
            paths::validate_relative(&entry.path)?;
        }
        let path = if entry.metadata {
            format!(".notes/{}", entry.path)
        } else {
            entry.path.clone()
        };
        if !names.insert(paths::canonical_name(&path))
            || entry.size > paths::MAX_ATTACHMENT
            || entry.hash.len() != 64
            || !entry.hash.chars().all(|c| c.is_ascii_hexdigit())
        {
            return Err(fail("Invalid backup file or colliding path"));
        }
        if !entry.metadata {
            let mut parent = Path::new(&entry.path).parent();
            while let Some(p) = parent.filter(|p| !p.as_os_str().is_empty()) {
                if !directory_names.contains(p.to_str().ok_or_else(|| fail("Invalid backup path"))?)
                {
                    return Err(fail("Backup omits or misnames a parent directory"));
                }
                parent = p.parent();
            }
        }
    }
    if !manifest
        .entries
        .iter()
        .any(|e| e.metadata && e.path == "index.db")
    {
        return Err(fail("Backup index is missing"));
    }
    Ok(())
}
struct HashReader<R> {
    input: R,
    hash: Sha256,
}
impl<R: Read> Read for HashReader<R> {
    fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
        let n = self.input.read(bytes)?;
        self.hash.update(&bytes[..n]);
        Ok(n)
    }
}
fn write_block(output: &mut impl Write, bytes: &[u8]) -> Result<()> {
    output.write_all(&(bytes.len() as u64).to_le_bytes())?;
    output.write_all(bytes)?;
    Ok(())
}
fn read_length(input: &mut impl Read, limit: u64) -> Result<u64> {
    let mut length = [0; 8];
    input.read_exact(&mut length)?;
    let length = u64::from_le_bytes(length);
    if length > limit {
        return Err(fail("Backup resource limit exceeded"));
    }
    Ok(length)
}
fn read_block(input: &mut impl Read, limit: u64) -> Result<Vec<u8>> {
    let size = read_length(input, limit)?;
    let mut bytes = vec![0; size as usize];
    input.read_exact(&mut bytes)?;
    Ok(bytes)
}

pub fn create(
    vault: &mut Vault,
    config: &VaultConfig,
    key: &VaultKey,
    destination: &Path,
) -> Result<String> {
    vault.scan()?;
    let temp = tempfile::TempDir::new()?;
    let index = temp.path().join("index.db");
    vault.snapshot_index(&index)?;
    let id = Uuid::new_v4().to_string();
    let mut manifest = Manifest {
        version: 1,
        id: id.clone(),
        name: vault.info()?.name,
        directories: vec![],
        entries: vec![],
    };
    let mut sources: Vec<PathBuf> = Vec::new();
    for entry in walkdir::WalkDir::new(&vault.root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            !e.file_name()
                .to_string_lossy()
                .eq_ignore_ascii_case(".notes")
        })
    {
        let entry = entry.map_err(|e| fail(e.to_string()))?;
        if entry.depth() == 0 {
            continue;
        }
        if entry.file_type().is_symlink() {
            return Err(fail("Backups do not follow symbolic links"));
        }
        let relative = entry
            .path()
            .strip_prefix(&vault.root)
            .map_err(|_| fail("Backup path escaped"))?
            .to_str()
            .ok_or_else(|| fail("Backup filenames must be UTF-8"))?
            .replace('\\', "/");
        paths::inside(&vault.root, &relative)?;
        if entry.file_type().is_dir() {
            manifest.directories.push(relative);
        } else if entry.file_type().is_file() {
            manifest.entries.push(Entry {
                path: relative,
                metadata: false,
                size: entry.metadata().map_err(|e| fail(e.to_string()))?.len(),
                hash: vault::hash_file(entry.path())?,
            });
            sources.push(entry.path().to_path_buf());
        } else {
            return Err(fail("Unsupported file type in backup"));
        }
    }
    // Back up only known app metadata; credentials, transfers, and lock files are excluded.
    let mut metadata = vec![("index.db".to_string(), index)];
    let mut blobs = HashSet::new();
    for revision in vault.revisions(None)? {
        metadata.push((
            format!("revisions/{}.json", revision.id),
            vault.internal(&format!("revisions/{}.json", revision.id))?,
        ));
        if let Some(blob) = revision.blob_id {
            blobs.insert(blob);
        }
    }
    for blob in blobs {
        metadata.push((
            format!("blobs/{blob}"),
            vault.internal(&format!("blobs/{blob}"))?,
        ));
    }
    for (path, source) in metadata {
        manifest.entries.push(Entry {
            path,
            metadata: true,
            size: fs::metadata(&source)?.len(),
            hash: vault::hash_file(&source)?,
        });
        sources.push(source);
    }
    validate(&manifest)?;
    // The SQLite snapshot and note files must describe the same saved text.
    for note in vault.notes()? {
        if !manifest
            .entries
            .iter()
            .any(|e| !e.metadata && e.path == note.path && e.hash == note.hash)
        {
            return Err(fail(
                "A note changed while preparing the backup. Save or resolve it, then retry.",
            ));
        }
    }
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)?;
    let result = (|| -> Result<()> {
        output.write_all(MAGIC)?;
        write_block(&mut output, &serde_json::to_vec(config)?)?;
        write_block(&mut output, id.as_bytes())?;
        write_block(
            &mut output,
            &crypto::seal(
                key,
                &crypto::identity(&config.vault_id, "manifest", &id, "backup-manifest"),
                &serde_json::to_vec(&manifest)?,
            )?,
        )?;
        let mut total = fs::metadata(destination)?.len();
        for (number, (entry, source)) in manifest.entries.iter().zip(sources).enumerate() {
            let mut reader = HashReader {
                input: fs::File::open(&source)?,
                hash: Sha256::new(),
            };
            let mut encrypted = tempfile::tempfile()?;
            crypto::seal_stream(
                key,
                &crypto::identity(&config.vault_id, &number.to_string(), &id, "backup-file"),
                &mut reader,
                &mut encrypted,
            )?;
            if hex::encode(reader.hash.finalize()) != entry.hash
                || fs::metadata(&source)?.len() != entry.size
                || vault::hash_file(&source)? != entry.hash
            {
                return Err(fail(
                    "A file changed during backup. Local work is safe; retry the backup.",
                ));
            }
            let size = encrypted.metadata()?.len();
            total += size + 8;
            if total > MAX_BACKUP {
                return Err(fail("Full backups are limited to 4 GiB in this release"));
            }
            output.write_all(&size.to_le_bytes())?;
            use std::io::{Seek, SeekFrom};
            encrypted.seek(SeekFrom::Start(0))?;
            std::io::copy(&mut encrypted, &mut output)?;
        }
        output.sync_all()?;
        Ok(())
    })();
    drop(output);
    if result.is_err() {
        let _ = fs::remove_file(destination);
    }
    result?;
    Ok(id)
}

pub fn restore(archive: &Path, parent: &Path, secret: &str, recovery: bool) -> Result<PathBuf> {
    if fs::metadata(archive)?.len() > MAX_BACKUP {
        return Err(fail("Backup exceeds 4 GiB"));
    }
    let parent = parent.canonicalize()?;
    let staging = tempfile::Builder::new()
        .prefix(".wattle-restore-")
        .tempdir_in(&parent)?;
    let mut input = fs::File::open(archive)?;
    let mut magic = [0; 10];
    input.read_exact(&mut magic)?;
    if &magic != MAGIC {
        return Err(fail("This is not a supported Wattle Notes backup"));
    }
    let config: VaultConfig = serde_json::from_slice(&read_block(&mut input, 65536)?)?;
    let id = String::from_utf8(read_block(&mut input, 128)?)
        .map_err(|_| fail("Invalid backup identity"))?;
    Uuid::parse_str(&id).map_err(|_| fail("Invalid backup identity"))?;
    let key = crypto::unlock(&config, secret, recovery)?;
    let encrypted_manifest = read_block(&mut input, 32 * 1024 * 1024)?;
    let manifest: Manifest = serde_json::from_slice(&crypto::unseal(
        &key,
        &crypto::identity(&config.vault_id, "manifest", &id, "backup-manifest"),
        &encrypted_manifest,
    )?)?;
    if manifest.id != id {
        return Err(fail("Backup identity does not match"));
    }
    validate(&manifest)?;
    fs::create_dir(staging.path().join(".notes"))?;
    for directory in &manifest.directories {
        fs::create_dir_all(paths::inside(staging.path(), directory)?)?;
    }
    for (number, entry) in manifest.entries.iter().enumerate() {
        let target = if entry.metadata {
            paths::inside(&staging.path().join(".notes"), &entry.path)?
        } else {
            paths::inside(staging.path(), &entry.path)?
        };
        fs::create_dir_all(
            target
                .parent()
                .ok_or_else(|| fail("Invalid restore parent"))?,
        )?;
        let size = read_length(&mut input, paths::MAX_ATTACHMENT + 1024 * 1024)?;
        let mut limited = (&mut input).take(size);
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)?;
        crypto::unseal_stream(
            &key,
            &crypto::identity(&config.vault_id, &number.to_string(), &id, "backup-file"),
            &mut limited,
            &mut output,
        )?;
        output.sync_all()?;
        drop(output);
        if limited.limit() != 0
            || fs::metadata(&target)?.len() != entry.size
            || vault::hash_file(&target)? != entry.hash
        {
            return Err(fail("Backup file is incomplete or inconsistent"));
        }
    }
    let mut trailing = [0];
    if input.read(&mut trailing)? != 0 {
        return Err(fail("Unexpected data after backup end"));
    }
    paths::atomic_write(
        &staging.path().join(".notes/vault.json"),
        &serde_json::to_vec(&config)?,
    )?;
    // Reopen and rebuild the index before publishing a restored folder.
    drop(Vault::open(staging.path())?);
    let destination = parent.join(format!(
        "Wattle Notes restored {} {}",
        vault::now(),
        Uuid::new_v4()
    ));
    if destination.exists() {
        return Err(fail("Restore destination already exists"));
    }
    fs::rename(staging.path(), &destination)?;
    Ok(destination)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn manifest_paths_reject_traversal_collisions_and_unknown_metadata() {
        let entry = Entry {
            path: "index.db".into(),
            metadata: true,
            size: 1,
            hash: "a".repeat(64),
        };
        let mut manifest = Manifest {
            version: 1,
            id: Uuid::new_v4().to_string(),
            name: "Test".into(),
            directories: vec![],
            entries: vec![entry],
        };
        assert!(validate(&manifest).is_ok());
        for path in ["../outside", "/outside", ".notes/file", "A/../B"] {
            manifest.directories = vec![path.into()];
            assert!(validate(&manifest).is_err());
        }
        manifest.directories = vec!["Work".into(), "work".into()];
        assert!(validate(&manifest).is_err());
        manifest.directories.clear();
        manifest.entries[0].path = "credentials.json".into();
        assert!(validate(&manifest).is_err());
    }
}
