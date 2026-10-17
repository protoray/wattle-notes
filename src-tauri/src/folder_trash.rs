use crate::{error::fail, model::DeletedFolder, paths, vault::Vault, Result};
use std::fs;
use uuid::Uuid;

impl Vault {
    /// Move the entire directory, including unindexed files and empty subfolders,
    /// into local metadata before recording normal sync deletion revisions.
    pub fn delete_folder(&mut self, path: &str) -> Result<()> {
        let source = paths::inside(&self.root, path)?;
        if !source.is_dir() {
            return Err(fail("Notebook folder not found"));
        }
        self.scan()?;
        self.check_folder_conflicts(path)?;
        let entry = DeletedFolder {
            id: Uuid::new_v4().to_string(),
            path: path.into(),
            deleted_at: crate::vault::now(),
        };
        let metadata = self.internal(&format!("folder-trash/{}/entry.json", entry.id))?;
        let contents = self.internal(&format!("folder-trash/{}/contents", entry.id))?;
        paths::atomic_write(&metadata, &serde_json::to_vec(&entry)?)?;
        fs::rename(&source, &contents)?;
        if let Err(error) = self.scan() {
            // Never discard the directory on an indexing failure. If rollback
            // cannot finish, the complete directory remains available in Trash.
            if !source.exists() && fs::rename(&contents, &source).is_ok() {
                let _ = self.scan();
            }
            return Err(error);
        }
        Ok(())
    }

    pub fn deleted_folders(&self) -> Result<Vec<DeletedFolder>> {
        let base = self.internal("folder-trash")?;
        if !base.exists() {
            return Ok(vec![]);
        }
        let mut entries = Vec::new();
        for entry in fs::read_dir(base)? {
            let id = entry?.file_name().to_string_lossy().to_string();
            if Uuid::parse_str(&id).is_err() {
                continue;
            }
            let contents = self.internal(&format!("folder-trash/{id}/contents"))?;
            if !contents.is_dir() {
                continue;
            }
            let metadata = self.internal(&format!("folder-trash/{id}/entry.json"))?;
            let entry: DeletedFolder = serde_json::from_slice(&fs::read(metadata)?)?;
            if entry.id != id {
                return Err(fail("Notebook trash identity does not match"));
            }
            paths::validate_relative(&entry.path)?;
            entries.push(entry);
        }
        entries.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at).then(a.path.cmp(&b.path)));
        Ok(entries)
    }

    pub fn restore_folder(&mut self, id: &str) -> Result<()> {
        Uuid::parse_str(id).map_err(|_| fail("Invalid notebook trash identity"))?;
        let entry = self
            .deleted_folders()?
            .into_iter()
            .find(|entry| entry.id == id)
            .ok_or_else(|| fail("Deleted notebook not found"))?;
        self.scan()?;
        self.check_folder_conflicts(&entry.path)?;
        let destination = paths::inside(&self.root, &entry.path)?;
        self.check_collision(&entry.path, None)?;
        if destination.exists() {
            return Err(fail(
                "A folder or file already uses this notebook's path. Rename it before restoring.",
            ));
        }
        let contents = self.internal(&format!("folder-trash/{id}/contents"))?;
        // A page may have been restored separately and moved elsewhere. Do not
        // introduce duplicate identities or overwrite it when restoring a folder.
        let live_ids: std::collections::HashSet<_> =
            self.notes()?.into_iter().map(|note| note.id).collect();
        for item in walkdir::WalkDir::new(&contents)
            .follow_links(false)
            .into_iter()
            .filter_entry(|entry| entry.file_name() != ".notes")
        {
            let item = item.map_err(|error| fail(error.to_string()))?;
            if item.file_type().is_file() && item.path().extension().is_some_and(|ext| ext == "md")
            {
                if let Some(id) = crate::vault::note_id(&fs::read_to_string(item.path())?)? {
                    if live_ids.contains(&id) {
                        return Err(fail("A page from this notebook is already restored. Delete that page or give it a new identity before restoring the whole notebook."));
                    }
                }
            }
        }
        fs::create_dir_all(
            destination
                .parent()
                .ok_or_else(|| fail("Missing parent folder"))?,
        )?;
        fs::rename(&contents, &destination)?;
        if let Err(error) = self.scan() {
            if fs::rename(&destination, &contents).is_ok() {
                let _ = self.scan();
            }
            return Err(error);
        }
        // Keep the small descriptor as a harmless recovery record; only entries
        // with a contents directory appear in Trash.
        Ok(())
    }

    fn check_folder_conflicts(&self, path: &str) -> Result<()> {
        let prefix = format!("{path}/");
        if self.conflicts()?.iter().any(|conflict| {
            conflict.path.starts_with(&prefix)
                || conflict
                    .versions
                    .iter()
                    .any(|version| version.path.starts_with(&prefix))
        }) {
            return Err(fail(
                "Resolve conflicts in this notebook before deleting or restoring it",
            ));
        }
        Ok(())
    }
}
