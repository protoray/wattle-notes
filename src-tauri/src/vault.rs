use crate::{error::fail, links, model::*, paths, Result};
use rusqlite::{params, Connection};
use serde_yaml::{Mapping, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

pub struct Vault {
    pub root: PathBuf,
    pub db: Connection,
    _lock: Option<fs::File>,
}
type PendingMove = (String, String, String, String, String);
pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
pub fn hash(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

pub fn frontmatter(content: &str) -> Result<(Mapping, String)> {
    let normalized = content.replace("\r\n", "\n");
    if let Some(after) = normalized.strip_prefix("---\n") {
        if let Some(body) = after.strip_prefix("---\n") {
            return Ok((Mapping::new(), body.into()));
        }
        if let Some(end) = after.find("\n---\n") {
            let metadata = serde_yaml::from_str::<Mapping>(&after[..end])?;
            return Ok((metadata, after[end + 5..].to_string()));
        }
        return Err(fail("Unclosed YAML frontmatter"));
    }
    Ok((Mapping::new(), normalized))
}

pub fn with_identity(content: &str, id: &str) -> Result<String> {
    let (mut meta, body) = frontmatter(content)?;
    meta.insert(
        Value::String("new_notes_id".into()),
        Value::String(id.into()),
    );
    Ok(format!(
        "---\n{}---\n{}",
        serde_yaml::to_string(&meta)?,
        body
    ))
}
pub fn note_id(content: &str) -> Result<Option<String>> {
    let (meta, _) = frontmatter(content)?;
    if let Some(value) = meta.get(Value::String("new_notes_id".into())) {
        let id = value
            .as_str()
            .ok_or_else(|| fail("new_notes_id must be a UUID string"))?;
        Uuid::parse_str(id).map_err(|_| fail("new_notes_id must be a valid UUID"))?;
        return Ok(Some(id.into()));
    }
    Ok(None)
}
fn tags(content: &str) -> Result<Vec<String>> {
    let (meta, _) = frontmatter(content)?;
    let mut result: Vec<String> = match meta.get(Value::String("tags".into())) {
        Some(Value::Sequence(items)) => items
            .iter()
            .filter_map(Value::as_str)
            .map(String::from)
            .collect(),
        Some(Value::String(value)) => value.split(',').map(|s| s.trim().to_string()).collect(),
        _ => Vec::new(),
    };
    result.retain(|s| !s.is_empty());
    result.sort();
    result.dedup();
    Ok(result)
}

impl Vault {
    pub fn open(root: impl AsRef<Path>) -> Result<Self> {
        fs::create_dir_all(root.as_ref())?;
        let mut vault = Self::connect(root.as_ref())?;
        let lock = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(vault.internal("lock")?)?;
        fs2::FileExt::try_lock_exclusive(&lock)
            .map_err(|_| fail("This vault is already open in another Wattle Notes process"))?;
        vault._lock = Some(lock);
        vault.recover_writes()?;
        vault.recover_moves()?;
        vault.scan()?;
        vault.rebuild_search()?;
        Ok(vault)
    }
    pub(crate) fn connect(root: &Path) -> Result<Self> {
        let root = root.canonicalize()?;
        let internal = root.join(".notes");
        if fs::symlink_metadata(&internal).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(fail("Vault metadata cannot be a symbolic link"));
        }
        fs::create_dir_all(&internal)?;
        let db_path = internal.join("index.db");
        for filename in ["index.db", "index.db-wal", "index.db-shm"] {
            if fs::symlink_metadata(internal.join(filename))
                .is_ok_and(|m| m.file_type().is_symlink())
            {
                return Err(fail("Vault index and journals cannot be symbolic links"));
            }
        }
        let db = Connection::open(db_path)?;
        db.busy_timeout(std::time::Duration::from_secs(5))?;
        db.execute_batch("PRAGMA journal_mode=WAL;
          CREATE TABLE IF NOT EXISTS notes(id TEXT PRIMARY KEY, path TEXT UNIQUE COLLATE NOCASE, content TEXT NOT NULL, hash TEXT NOT NULL, modified INTEGER NOT NULL);
          CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(id UNINDEXED, path, content);
          CREATE TABLE IF NOT EXISTS revisions(id TEXT PRIMARY KEY, item_id TEXT NOT NULL, data TEXT NOT NULL, uploaded INTEGER NOT NULL DEFAULT 0, drive_id TEXT);
          CREATE INDEX IF NOT EXISTS item_revisions ON revisions(item_id);
          CREATE TABLE IF NOT EXISTS blobs(id TEXT PRIMARY KEY, local_path TEXT NOT NULL, uploaded INTEGER NOT NULL DEFAULT 0, drive_id TEXT);
          CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS writes(path TEXT PRIMARY KEY, content TEXT NOT NULL, expected TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS moves(item_id TEXT PRIMARY KEY,source TEXT NOT NULL,destination TEXT NOT NULL,expected TEXT NOT NULL,revision_id TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS conflicts(item_id TEXT PRIMARY KEY, reason TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS projection(item_id TEXT PRIMARY KEY, drive_id TEXT NOT NULL, path TEXT NOT NULL);")?;
        Ok(Self {
            root,
            db,
            _lock: None,
        })
    }
    pub fn internal(&self, relative: &str) -> Result<PathBuf> {
        paths::validate_relative(relative)?;
        let base = self.root.join(".notes");
        let mut p = base.clone();
        for part in relative.split('/') {
            p.push(part);
            if fs::symlink_metadata(&p).is_ok_and(|m| m.file_type().is_symlink()) {
                return Err(fail("Vault metadata cannot contain symbolic links"));
            }
        }
        Ok(base.join(relative))
    }
    pub fn get_state(&self, key: &str) -> Result<Option<String>> {
        use rusqlite::OptionalExtension;
        Ok(self
            .db
            .query_row("SELECT value FROM state WHERE key=?", [key], |r| r.get(0))
            .optional()?)
    }
    pub fn set_state(&self, key: &str, value: &str) -> Result<()> {
        self.db.execute(
            "INSERT INTO state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![key, value],
        )?;
        Ok(())
    }
    pub fn notes(&self) -> Result<Vec<Note>> {
        let mut stmt = self.db.prepare(
            "SELECT id,path,content,hash,modified FROM notes ORDER BY modified DESC,path",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, u64>(4)?,
            ))
        })?;
        let mut notes = Vec::new();
        for row in rows {
            let (id, path, content, hash, modified) = row?;
            let title = Path::new(&path)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("Untitled")
                .to_string();
            notes.push(Note {
                id,
                path,
                title,
                tags: tags(&content)?,
                content,
                hash,
                modified,
            });
        }
        Ok(notes)
    }
    pub fn note(&self, id: &str) -> Result<Note> {
        self.notes()?
            .into_iter()
            .find(|n| n.id == id)
            .ok_or_else(|| fail("Note not found"))
    }
    pub fn search(&self, query: &str) -> Result<Vec<Note>> {
        if query.trim().is_empty() {
            return self.notes();
        }
        let terms: Vec<String> = query
            .split_whitespace()
            .map(|s| format!("\"{}\"*", s.replace('"', "\"\"")))
            .collect();
        let mut stmt = self
            .db
            .prepare("SELECT id FROM search WHERE search MATCH ? ORDER BY rank")?;
        let ids: Vec<String> = stmt
            .query_map([terms.join(" AND ")], |r| r.get(0))?
            .collect::<std::result::Result<_, _>>()?;
        let all = self.notes()?;
        Ok(ids
            .iter()
            .filter_map(|id| all.iter().find(|n| &n.id == id).cloned())
            .collect())
    }
    pub fn revisions(&self, item: Option<&str>) -> Result<Vec<Revision>> {
        let mut stmt = self.db.prepare(
            "SELECT data FROM revisions WHERE (?1 IS NULL OR item_id=?1) ORDER BY rowid",
        )?;
        let rows = stmt.query_map([item], |r| r.get::<_, String>(0))?;
        let mut result = Vec::new();
        for row in rows {
            result.push(serde_json::from_str(&row?)?);
        }
        Ok(result)
    }
    pub fn heads(&self, item: &str) -> Result<Vec<Revision>> {
        let revisions = self.revisions(Some(item))?;
        let parents: HashSet<&str> = revisions
            .iter()
            .flat_map(|r| r.parents.iter().map(String::as_str))
            .collect();
        Ok(revisions
            .iter()
            .filter(|r| !parents.contains(r.id.as_str()))
            .cloned()
            .collect())
    }
    pub fn insert_revision(&self, revision: &Revision, uploaded: bool) -> Result<()> {
        self.validate_revision(revision)?;
        self.persist_revision(revision)?;
        self.db.execute(
            "INSERT OR IGNORE INTO revisions(id,item_id,data,uploaded) VALUES(?,?,?,?)",
            params![
                revision.id,
                revision.item_id,
                serde_json::to_string(revision)?,
                uploaded
            ],
        )?;
        Ok(())
    }
    fn persist_revision(&self, revision: &Revision) -> Result<()> {
        let path = self.internal(&format!("revisions/{}.json", revision.id))?;
        let bytes = serde_json::to_vec(revision)?;
        if path.exists() {
            if fs::read(path)? != bytes {
                return Err(fail(
                    "An immutable revision was modified or its identity was reused",
                ));
            }
        } else {
            paths::atomic_write(&path, &bytes)?;
        }
        Ok(())
    }
    pub fn rebuild_search(&self) -> Result<()> {
        self.db.execute("DELETE FROM search", [])?;
        for note in self.notes()? {
            self.db.execute(
                "INSERT INTO search VALUES(?,?,?)",
                params![note.id, note.path, note.content],
            )?;
        }
        Ok(())
    }
    pub fn validate_revision(&self, revision: &Revision) -> Result<()> {
        Uuid::parse_str(&revision.id).map_err(|_| fail("Invalid revision identity"))?;
        Uuid::parse_str(&revision.item_id).map_err(|_| fail("Invalid item identity"))?;
        paths::inside(&self.root, &revision.path)?;
        if revision.parents.len() > 1000 || revision.dependencies.len() > 10000 {
            return Err(fail("Revision exceeds resource limits"));
        }
        for id in revision
            .parents
            .iter()
            .chain(&revision.dependencies)
            .chain(revision.blob_id.iter())
        {
            Uuid::parse_str(id).map_err(|_| fail("Invalid dependency identity"))?;
        }
        if revision.parents.contains(&revision.id) {
            return Err(fail("Revision cannot be its own parent"));
        }
        if let Some(content) = &revision.content {
            if content.len() as u64 > paths::MAX_NOTE {
                return Err(fail("Note exceeds 10 MiB"));
            }
            if revision.kind != ItemKind::Note
                || note_id(content)?.as_deref() != Some(&revision.item_id)
            {
                return Err(fail("Note content identity does not match revision"));
            }
        }
        if !revision.deleted
            && match revision.kind {
                ItemKind::Note => revision.content.is_none(),
                ItemKind::Attachment => revision.blob_id.is_none(),
            }
        {
            return Err(fail("Revision content is missing"));
        }
        Ok(())
    }
    fn index_note(&self, id: &str, path: &str, content: &str) -> Result<()> {
        self.db.execute("INSERT INTO notes VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET path=excluded.path,content=excluded.content,hash=excluded.hash,modified=excluded.modified", params![id,path,content,hash(content.as_bytes()),now()])?;
        self.db.execute("DELETE FROM search WHERE id=?", [id])?;
        self.db.execute(
            "INSERT INTO search VALUES(?,?,?)",
            params![id, path, content],
        )?;
        Ok(())
    }
    fn make_note_revision(
        &self,
        id: &str,
        path: &str,
        content: Option<String>,
        parents: Vec<String>,
    ) -> Result<Revision> {
        let mut dependencies = Vec::new();
        if let Some(text) = &content {
            for (target, _, _, wiki) in links::targets(text) {
                if !wiki {
                    if let Some(path) = links::normalize_relative(path, &target) {
                        for revision in self.revisions(None)?.iter().filter(|r| {
                            r.kind == ItemKind::Attachment && r.path == path && !r.deleted
                        }) {
                            if let Some(blob) = &revision.blob_id {
                                dependencies.push(blob.clone());
                            }
                        }
                    }
                }
            }
        }
        dependencies.sort();
        dependencies.dedup();
        Ok(Revision {
            id: Uuid::new_v4().to_string(),
            created_at: now(),
            item_id: id.into(),
            parents,
            path: path.into(),
            kind: ItemKind::Note,
            deleted: content.is_none(),
            content,
            blob_id: None,
            dependencies,
        })
    }
    pub fn create_note(&mut self, path: &str) -> Result<Note> {
        if !path.ends_with(".md") {
            return Err(fail("Notes must use the .md extension"));
        }
        self.check_collision(path, None)?;
        let target = paths::inside(&self.root, path)?;
        if target.exists() {
            return Err(fail("A file already exists at this path"));
        }
        let id = Uuid::new_v4().to_string();
        let title = Path::new(path)
            .file_stem()
            .and_then(|p| p.to_str())
            .unwrap_or("Untitled");
        let content = with_identity(&format!("# {title}\n\n"), &id)?;
        let revision = self.make_note_revision(&id, path, Some(content.clone()), vec![])?;
        self.journal_write(&revision, "")?;
        self.note(&id)
    }
    pub fn save_note(&mut self, id: &str, content: &str, expected: &str) -> Result<Note> {
        if content.len() as u64 > paths::MAX_NOTE {
            return Err(fail("Notes are limited to 10 MiB"));
        }
        let old = self.note(id)?;
        let target = paths::inside(&self.root, &old.path)?;
        let canonical = with_identity(content, id)?;
        let parents: Vec<String> = self.heads(id)?.iter().map(|r| r.id.clone()).collect();
        if self.conflicts()?.iter().any(|c| c.item_id == id) {
            return Err(fail(
                "Resolve this note's conflict before saving; your draft is retained in the editor",
            ));
        }
        let disk = fs::read_to_string(&target)?;
        if old.hash != expected || hash(disk.as_bytes()) != expected {
            let proposed =
                self.make_note_revision(id, &old.path, Some(canonical), parents.clone())?;
            let external =
                self.make_note_revision(id, &old.path, Some(with_identity(&disk, id)?), parents)?;
            self.insert_revision(&proposed, false)?;
            self.insert_revision(&external, false)?;
            self.mark_conflict(
                id,
                "The file changed outside the editor. Both versions have been preserved.",
            )?;
            self.index_note(id, &old.path, &disk)?;
            return Err(fail(
                "External edit conflict: both versions were preserved. Open Resolve conflicts.",
            ));
        }
        if canonical == old.content {
            return Ok(old);
        }
        let revision = self.make_note_revision(id, &old.path, Some(canonical), parents)?;
        self.journal_write(&revision, expected)?;
        self.note(id)
    }
    fn journal_write(&mut self, revision: &Revision, expected: &str) -> Result<()> {
        self.validate_revision(revision)?;
        self.persist_revision(revision)?;
        let content = revision
            .content
            .as_deref()
            .ok_or_else(|| fail("Missing note content"))?;
        let tx = self.db.transaction()?;
        tx.execute(
            "INSERT OR IGNORE INTO revisions(id,item_id,data) VALUES(?,?,?)",
            params![
                revision.id,
                revision.item_id,
                serde_json::to_string(revision)?
            ],
        )?;
        tx.execute(
            "INSERT OR REPLACE INTO writes VALUES(?,?,?)",
            params![revision.path, content, expected],
        )?;
        tx.commit()?;
        let path = paths::inside(&self.root, &revision.path)?;
        paths::atomic_write(&path, content.as_bytes())?;
        self.index_note(&revision.item_id, &revision.path, content)?;
        self.db
            .execute("DELETE FROM writes WHERE path=?", [&revision.path])?;
        Ok(())
    }
    fn recover_writes(&mut self) -> Result<()> {
        let pending: Vec<(String, String, String)> = {
            let mut stmt = self
                .db
                .prepare("SELECT path,content,expected FROM writes")?;
            let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
            rows.collect::<std::result::Result<_, _>>()?
        };
        for (path, content, expected) in pending {
            let target = paths::inside(&self.root, &path)?;
            let existing = fs::read_to_string(&target).unwrap_or_default();
            let id = note_id(&content)?.ok_or_else(|| fail("Journal has no note identity"))?;
            if existing == content
                || hash(existing.as_bytes()) == expected
                || (!target.exists() && expected.is_empty())
            {
                paths::atomic_write(&target, content.as_bytes())?;
                self.index_note(&id, &path, &content)?;
            } else {
                let last = self.heads(&id)?;
                let parents = last.first().map(|r| r.parents.clone()).unwrap_or_default();
                let revision = self.make_note_revision(
                    &id,
                    &path,
                    Some(with_identity(&existing, &id)?),
                    parents,
                )?;
                self.insert_revision(&revision, false)?;
                self.index_note(&id, &path, &existing)?;
                self.mark_conflict(
                    &id,
                    "An external edit interrupted recovery; both versions are retained",
                )?;
            }
            self.db
                .execute("DELETE FROM writes WHERE path=?", [&path])?;
        }
        Ok(())
    }
    pub fn check_collision(&self, path: &str, own_id: Option<&str>) -> Result<()> {
        paths::inside(&self.root, path)?;
        for note in self.notes()? {
            if paths::canonical_name(&note.path) == paths::canonical_name(path)
                && Some(note.id.as_str()) != own_id
            {
                return Err(fail(
                    "A note already uses this name (including case differences)",
                ));
            }
        }
        for entry in walkdir::WalkDir::new(&self.root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| e.file_name() != ".notes")
        {
            let entry = entry.map_err(|e| fail(e.to_string()))?;
            if let Ok(relative) = entry.path().strip_prefix(&self.root) {
                let existing = relative.to_string_lossy().replace('\\', "/");
                if paths::canonical_name(&existing) == paths::canonical_name(path)
                    && existing != path
                {
                    return Err(fail("A file with a case-equivalent name already exists"));
                }
            }
        }
        Ok(())
    }
    fn record_move(&self, old: &Note, revision: &Revision) -> Result<()> {
        self.db.execute(
            "INSERT OR REPLACE INTO moves VALUES(?,?,?,?,?)",
            params![old.id, old.path, revision.path, old.hash, revision.id],
        )?;
        Ok(())
    }
    fn recover_moves(&mut self) -> Result<()> {
        let entries: Vec<PendingMove> = {
            let mut statement = self
                .db
                .prepare("SELECT item_id,source,destination,expected,revision_id FROM moves")?;
            let rows = statement.query_map([], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })?;
            rows.collect::<std::result::Result<_, _>>()?
        };
        for (item, source, destination, expected, revision_id) in entries {
            let from = paths::inside(&self.root, &source)?;
            let to = paths::inside(&self.root, &destination)?;
            if to.exists() {
                let actual = fs::read_to_string(&to)?;
                if note_id(&actual)?.as_deref() != Some(&item) {
                    return Err(fail("A different file occupies an interrupted rename destination; both files were preserved"));
                }
                let moved = self
                    .revisions(Some(&item))?
                    .into_iter()
                    .find(|r| r.id == revision_id)
                    .ok_or_else(|| fail("Missing rename revision"))?;
                if actual != moved.content.as_deref().unwrap_or_default() {
                    let changed = self.make_note_revision(
                        &item,
                        &destination,
                        Some(with_identity(&actual, &item)?),
                        vec![revision_id.clone()],
                    )?;
                    self.insert_revision(&changed, false)?;
                }
                if from.exists() {
                    let original = fs::read_to_string(&from)?;
                    if note_id(&original)?.as_deref() == Some(&item) {
                        if hash(original.as_bytes()) != expected {
                            let changed = self.make_note_revision(
                                &item,
                                &source,
                                Some(with_identity(&original, &item)?),
                                moved.parents.clone(),
                            )?;
                            self.insert_revision(&changed, false)?;
                            self.mark_conflict(&item,"An external edit interrupted a rename. Both versions are retained.")?;
                        }
                        fs::remove_file(&from)?;
                    }
                }
                self.index_note(&item, &destination, &actual)?;
            }
            self.db
                .execute("DELETE FROM moves WHERE item_id=?", [&item])?;
        }
        Ok(())
    }
    pub fn scan(&mut self) -> Result<()> {
        let before = self.notes()?;
        let mut seen = HashSet::new();
        let mut names = HashSet::new();
        let mut attachment_paths = HashSet::new();
        let entries: Vec<_> = walkdir::WalkDir::new(&self.root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| e.file_name() != ".notes")
            .collect::<std::result::Result<_, _>>()
            .map_err(|e| fail(e.to_string()))?;
        for entry in entries {
            if !entry.file_type().is_file() {
                continue;
            }
            let path = entry
                .path()
                .strip_prefix(&self.root)
                .map_err(|_| fail("Path outside vault"))?
                .to_string_lossy()
                .replace('\\', "/");
            paths::inside(&self.root, &path)?;
            if !names.insert(paths::canonical_name(&path)) {
                return Err(fail(
                    "Vault contains filenames that collide on another platform",
                ));
            }
            if path.ends_with(".md") {
                if entry.metadata().map_err(|e| fail(e.to_string()))?.len() > paths::MAX_NOTE {
                    return Err(fail(format!("{path} exceeds the 10 MiB note limit")));
                }
                let raw = fs::read_to_string(entry.path())?;
                let previous = before.iter().find(|n| n.path == path);
                let id = note_id(&raw)?
                    .or_else(|| previous.map(|n| n.id.clone()))
                    .unwrap_or_else(|| Uuid::new_v4().to_string());
                if !seen.insert(id.clone()) {
                    return Err(fail(
                        "Two notes have the same new_notes_id; give the copied note a new ID",
                    ));
                }
                let content = with_identity(&raw, &id)?;
                let previous = before.iter().find(|n| n.id == id);
                if previous.is_none_or(|n| n.content != content || n.path != path) {
                    let parents = self.heads(&id)?.iter().map(|r| r.id.clone()).collect();
                    let revision =
                        self.make_note_revision(&id, &path, Some(content.clone()), parents)?;
                    self.insert_revision(&revision, false)?;
                    if raw != content {
                        paths::atomic_write(entry.path(), content.as_bytes())?;
                    }
                    self.index_note(&id, &path, &content)?;
                }
            } else if !path.split('/').any(|s| s.starts_with('.')) {
                self.scan_attachment(&path)?;
                attachment_paths.insert(path);
            }
        }
        for old in before {
            if !seen.contains(&old.id) {
                let parents = self.heads(&old.id)?.iter().map(|r| r.id.clone()).collect();
                let revision = self.make_note_revision(&old.id, &old.path, None, parents)?;
                self.insert_revision(&revision, false)?;
                self.db.execute("DELETE FROM notes WHERE id=?", [&old.id])?;
                self.db
                    .execute("DELETE FROM search WHERE id=?", [&old.id])?;
            }
        }
        let attachment_items: HashSet<String> = self
            .revisions(None)?
            .into_iter()
            .filter(|r| r.kind == ItemKind::Attachment)
            .map(|r| r.item_id)
            .collect();
        for item in attachment_items {
            let heads = self.heads(&item)?;
            if heads.len() == 1 && !heads[0].deleted && !attachment_paths.contains(&heads[0].path) {
                let mut deleted = heads[0].clone();
                deleted.id = Uuid::new_v4().to_string();
                deleted.created_at = now();
                deleted.parents = vec![heads[0].id.clone()];
                deleted.deleted = true;
                self.insert_revision(&deleted, false)?;
            }
        }
        Ok(())
    }
    fn scan_attachment(&self, path: &str) -> Result<()> {
        let target = paths::inside(&self.root, path)?;
        let meta = fs::metadata(&target)?;
        if meta.len() > paths::MAX_ATTACHMENT {
            return Err(fail(format!("{path}: attachments are limited to 100 MiB")));
        }
        // Hashing is streamed, and historical plaintext is kept only in local app metadata.
        let digest = hash_file(&target)?;
        let key = format!("attachment:{path}");
        if self.get_state(&key)?.as_deref() == Some(&digest) {
            return Ok(());
        }
        let previous: Vec<Revision> = self
            .revisions(None)?
            .into_iter()
            .filter(|r| r.kind == ItemKind::Attachment && r.path == path)
            .collect();
        let item = previous
            .first()
            .map(|r| r.item_id.clone())
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let parents = self.heads(&item)?.iter().map(|r| r.id.clone()).collect();
        let blob = Uuid::new_v4().to_string();
        let local = self.internal(&format!("blobs/{blob}"))?;
        fs::create_dir_all(
            local
                .parent()
                .ok_or_else(|| fail("Missing blob directory"))?,
        )?;
        fs::copy(&target, &local)?;
        self.db.execute(
            "INSERT INTO blobs(id,local_path) VALUES(?,?)",
            params![blob, format!("blobs/{blob}")],
        )?;
        self.insert_revision(
            &Revision {
                id: Uuid::new_v4().to_string(),
                created_at: now(),
                item_id: item.clone(),
                parents,
                path: path.into(),
                kind: ItemKind::Attachment,
                deleted: false,
                content: None,
                blob_id: Some(blob),
                dependencies: vec![],
            },
            false,
        )?;
        self.set_state(&format!("attachment_owner:{path}"), &item)?;
        self.set_state(&key, &digest)?;
        Ok(())
    }
    pub fn rename_note(&mut self, id: &str, destination: &str) -> Result<Note> {
        self.scan()?;
        self.check_collision(destination, Some(id))?;
        if !destination.ends_with(".md") {
            return Err(fail("Notes must use the .md extension"));
        }
        if !self.conflicts()?.is_empty() {
            return Err(fail("Resolve conflicts before renaming notes"));
        }
        let notes = self.notes()?;
        let old = self.note(id)?;
        let dest = paths::inside(&self.root, destination)?;
        if dest.exists() && old.path != destination {
            return Err(fail("Destination already exists"));
        }
        if old.path == destination {
            return Ok(old);
        }
        // Plan link rewrites using the old graph, including links inside the moved note.
        let mut rewritten: HashMap<String, String> = HashMap::new();
        for note in &notes {
            let source_after = if note.id == id {
                destination
            } else {
                &note.path
            };
            let mut content = note.content.clone();
            for (target, start, end, wiki) in links::targets(&note.content).into_iter().rev() {
                if let Some(resolved) =
                    links::resolve(&note.path, &target, wiki, &notes).resolved_id
                {
                    let to = if resolved == id {
                        destination
                    } else {
                        &notes
                            .iter()
                            .find(|n| n.id == resolved)
                            .ok_or_else(|| fail("Link target disappeared"))?
                            .path
                    };
                    if resolved == id || (note.id == id && !wiki) {
                        let new_target = if wiki {
                            to.strip_suffix(".md").unwrap_or(to).to_string()
                        } else {
                            links::relative_path(source_after, to).replace(' ', "%20")
                        };
                        content.replace_range(start..end, &new_target);
                    }
                }
            }
            rewritten.insert(note.id.clone(), content);
        }
        let content = rewritten
            .remove(id)
            .ok_or_else(|| fail("Missing renamed note"))?;
        let parents = self.heads(id)?.iter().map(|r| r.id.clone()).collect();
        let revision = self.make_note_revision(id, destination, Some(content), parents)?;
        self.record_move(&old, &revision)?;
        self.journal_write(&revision, "")?;
        self.recover_moves()?;
        for note in notes.iter().filter(|n| n.id != id) {
            if let Some(content) = rewritten.get(&note.id) {
                if content != &note.content {
                    self.save_note(&note.id, content, &note.hash)?;
                }
            }
        }
        self.note(id)
    }
    pub fn delete_note(&mut self, id: &str) -> Result<()> {
        self.scan()?;
        let note = self.note(id)?;
        if self.conflicts()?.iter().any(|c| c.item_id == id) {
            return Err(fail("Resolve the conflict before deleting this note"));
        }
        let parents = self.heads(id)?.iter().map(|r| r.id.clone()).collect();
        let revision = self.make_note_revision(id, &note.path, None, parents)?;
        self.insert_revision(&revision, false)?;
        fs::remove_file(paths::inside(&self.root, &note.path)?)?;
        self.db.execute("DELETE FROM notes WHERE id=?", [id])?;
        self.db.execute("DELETE FROM search WHERE id=?", [id])?;
        Ok(())
    }
    pub fn create_folder(&self, path: &str) -> Result<()> {
        self.check_collision(path, None)?;
        fs::create_dir_all(paths::inside(&self.root, path)?)?;
        Ok(())
    }
    pub fn import_attachment(&mut self, source: &Path) -> Result<String> {
        if !fs::symlink_metadata(source)?.file_type().is_file() {
            return Err(fail("Select a regular attachment file"));
        }
        if source.metadata()?.len() > paths::MAX_ATTACHMENT {
            return Err(fail("Attachments are limited to 100 MiB"));
        }
        let name = source
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| fail("Invalid attachment filename"))?;
        let path = format!("attachments/{}-{name}", &Uuid::new_v4().to_string()[..8]);
        self.check_collision(&path, None)?;
        let dest = paths::inside(&self.root, &path)?;
        fs::create_dir_all(
            dest.parent()
                .ok_or_else(|| fail("Missing attachment parent"))?,
        )?;
        fs::copy(source, dest)?;
        self.scan_attachment(&path)?;
        Ok(path)
    }
    pub fn copy_from(&mut self, source: &Path) -> Result<()> {
        let source = source.canonicalize()?;
        if source == self.root || source.starts_with(&self.root) || self.root.starts_with(&source) {
            return Err(fail("Choose a separate folder outside this vault"));
        }
        let mut planned = Vec::new();
        for entry in walkdir::WalkDir::new(&source)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| !e.file_name().to_string_lossy().starts_with('.'))
        {
            let entry = entry.map_err(|e| fail(e.to_string()))?;
            if !entry.file_type().is_file() {
                continue;
            }
            let path = entry
                .path()
                .strip_prefix(&source)
                .map_err(|_| fail("Import path escaped"))?
                .to_string_lossy()
                .replace('\\', "/");
            self.check_collision(&path, None)?;
            let dest = paths::inside(&self.root, &path)?;
            if dest.exists() {
                return Err(fail(format!("Import would replace {path}")));
            }
            let max = if path.ends_with(".md") {
                paths::MAX_NOTE
            } else {
                paths::MAX_ATTACHMENT
            };
            if entry.metadata().map_err(|e| fail(e.to_string()))?.len() > max {
                return Err(fail(format!("{path} exceeds its size limit")));
            }
            planned.push((entry.path().to_path_buf(), dest));
        }
        for (source, dest) in planned {
            fs::create_dir_all(dest.parent().ok_or_else(|| fail("Missing import parent"))?)?;
            fs::copy(source, dest)?;
        }
        self.scan()
    }
    pub fn export_to(&self, destination: &Path) -> Result<()> {
        fs::create_dir_all(destination)?;
        let dest = destination.canonicalize()?;
        if dest.starts_with(&self.root) || self.root.starts_with(&dest) {
            return Err(fail("Export to a separate folder outside the vault"));
        }
        let mut copies = Vec::new();
        for entry in walkdir::WalkDir::new(&self.root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| e.file_name() != ".notes")
        {
            let entry = entry.map_err(|e| fail(e.to_string()))?;
            if !entry.file_type().is_file() {
                continue;
            }
            let relative = entry
                .path()
                .strip_prefix(&self.root)
                .map_err(|_| fail("Export path escaped"))?
                .to_string_lossy()
                .replace('\\', "/");
            let target = paths::inside(&dest, &relative)?;
            if target.exists() {
                return Err(fail(format!("Export would replace {relative}")));
            }
            copies.push((entry.path().to_path_buf(), target));
        }
        for (source, target) in copies {
            fs::create_dir_all(
                target
                    .parent()
                    .ok_or_else(|| fail("Missing export parent"))?,
            )?;
            fs::copy(source, target)?;
        }
        Ok(())
    }
    pub fn snapshot_index(&self, destination: &Path) -> Result<()> {
        if destination.exists() {
            return Err(fail("Backup snapshot destination already exists"));
        }
        self.db
            .execute("VACUUM INTO ?1", [destination.to_string_lossy().as_ref()])?;
        Ok(())
    }
    pub fn mark_conflict(&self, item: &str, reason: &str) -> Result<()> {
        self.db.execute(
            "INSERT OR REPLACE INTO conflicts VALUES(?,?)",
            params![item, reason],
        )?;
        Ok(())
    }
    pub fn clear_conflict(&self, item: &str) -> Result<()> {
        self.db
            .execute("DELETE FROM conflicts WHERE item_id=?", [item])?;
        Ok(())
    }
    pub fn conflicts(&self) -> Result<Vec<Conflict>> {
        let mut stmt = self
            .db
            .prepare("SELECT item_id,reason FROM conflicts ORDER BY item_id")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        let mut result = Vec::new();
        for row in rows {
            let (item_id, reason) = row?;
            let versions = self.heads(&item_id)?;
            result.push(Conflict {
                path: versions.first().map(|r| r.path.clone()).unwrap_or_default(),
                item_id,
                reason,
                versions,
            });
        }
        Ok(result)
    }
    pub fn resolve_conflict(
        &mut self,
        item: &str,
        content: Option<String>,
        path: &str,
        version: Option<&str>,
    ) -> Result<()> {
        let heads = self.heads(item)?;
        let chosen = heads
            .iter()
            .find(|r| Some(r.id.as_str()) == version)
            .or(heads.first())
            .ok_or_else(|| fail("No conflict versions"))?;
        self.check_collision(path, Some(item))?;
        let mut revision = chosen.clone();
        revision.id = Uuid::new_v4().to_string();
        revision.created_at = now();
        revision.parents = heads.iter().map(|r| r.id.clone()).collect();
        revision.path = path.into();
        if revision.kind == ItemKind::Note {
            revision.content = content.map(|c| with_identity(&c, item)).transpose()?;
            revision.deleted = revision.content.is_none();
        }
        self.insert_revision(&revision, false)?;
        self.apply_revision(&revision)?;
        self.clear_conflict(item)
    }
    pub fn apply_revision(&mut self, revision: &Revision) -> Result<()> {
        self.validate_revision(revision)?;
        self.check_collision(&revision.path, Some(&revision.item_id))?;
        let target = paths::inside(&self.root, &revision.path)?;
        let old = self.notes()?.into_iter().find(|n| n.id == revision.item_id);
        if revision.deleted {
            if revision.kind == ItemKind::Attachment && target.exists() {
                let owner = self.get_state(&format!("attachment_owner:{}", revision.path))?;
                let expected = self.get_state(&format!("attachment:{}", revision.path))?;
                if owner.as_deref() != Some(&revision.item_id)
                    || expected.as_deref() != Some(&hash_file(&target)?)
                {
                    return Err(fail(
                        "An attachment changed during deletion; its local file was preserved",
                    ));
                }
                fs::remove_file(&target)?;
            }
            if let Some(old) = old {
                let file = paths::inside(&self.root, &old.path)?;
                if file.exists() && hash(fs::read(&file)?.as_slice()) != old.hash {
                    return Err(fail("File changed during deletion; preserved on disk"));
                }
                if file.exists() {
                    fs::remove_file(file)?;
                }
                self.db
                    .execute("DELETE FROM notes WHERE id=?", [&revision.item_id])?;
                self.db
                    .execute("DELETE FROM search WHERE id=?", [&revision.item_id])?;
            }
            return Ok(());
        }
        if let Some(ref note) = old {
            if note.path == revision.path
                && revision.content.as_deref() == Some(&note.content)
                && target.exists()
                && hash_file(&target)? == note.hash
            {
                return Ok(());
            }
        }
        if target.exists()
            && old.as_ref().is_none_or(|n| n.path != revision.path)
            && (revision.kind == ItemKind::Note
                || self
                    .get_state(&format!("attachment_owner:{}", revision.path))?
                    .as_deref()
                    != Some(&revision.item_id))
        {
            return Err(fail("A local file already occupies the remote path"));
        }
        if let Some(ref note) = old {
            let file = paths::inside(&self.root, &note.path)?;
            if file.exists() && hash(&fs::read(file)?) != note.hash {
                return Err(fail(
                    "External edit arrived during sync; retained for the next scan",
                ));
            }
        }
        match revision.kind {
            ItemKind::Note => {
                let content = revision
                    .content
                    .as_ref()
                    .ok_or_else(|| fail("Missing note content"))?;
                if let Some(ref old) = old {
                    if old.path != revision.path {
                        self.record_move(old, revision)?;
                    }
                }
                paths::atomic_write(&target, content.as_bytes())?;
                self.index_note(&revision.item_id, &revision.path, content)?;
                self.recover_moves()?;
            }
            ItemKind::Attachment => {
                let blob = revision
                    .blob_id
                    .as_ref()
                    .ok_or_else(|| fail("Missing attachment data"))?;
                if target.exists()
                    && self
                        .get_state(&format!("attachment:{}", revision.path))?
                        .as_deref()
                        != Some(&hash_file(&target)?)
                {
                    return Err(fail(
                        "The attachment changed during sync; its local file was preserved",
                    ));
                }
                let bytes = fs::read(self.internal(&format!("blobs/{blob}"))?)?;
                if bytes.len() as u64 > paths::MAX_ATTACHMENT {
                    return Err(fail("Attachment exceeds limit"));
                }
                paths::atomic_write(&target, &bytes)?;
                self.set_state(&format!("attachment:{}", revision.path), &hash(&bytes))?;
                self.set_state(
                    &format!("attachment_owner:{}", revision.path),
                    &revision.item_id,
                )?;
            }
        }
        Ok(())
    }
    pub fn restore_revision(&mut self, id: &str) -> Result<()> {
        let old = self
            .revisions(None)?
            .into_iter()
            .find(|r| r.id == id && !r.deleted)
            .ok_or_else(|| fail("Restorable revision not found"))?;
        let mut revision = old.clone();
        revision.id = Uuid::new_v4().to_string();
        revision.created_at = now();
        revision.parents = self
            .heads(&old.item_id)?
            .iter()
            .map(|r| r.id.clone())
            .collect();
        self.insert_revision(&revision, false)?;
        self.apply_revision(&revision)?;
        self.clear_conflict(&revision.item_id)
    }
    pub fn keep_both_attachments(&mut self, item: &str, primary: &str, path: &str) -> Result<()> {
        let heads = self.heads(item)?;
        if heads.len() < 2
            || heads
                .iter()
                .any(|r| r.kind != ItemKind::Attachment || r.deleted)
        {
            return Err(fail("This action requires competing attachment versions"));
        }
        if !heads.iter().any(|r| r.id == primary) {
            return Err(fail("Choose a primary attachment version"));
        }
        for head in heads.iter().filter(|r| r.id != primary) {
            let new_item = Uuid::new_v5(
                &Uuid::NAMESPACE_OID,
                format!("conflict-copy:{item}:{}", head.id).as_bytes(),
            )
            .to_string();
            if !self.heads(&new_item)?.is_empty() {
                continue;
            }
            let source = Path::new(&head.path);
            let stem = source
                .file_stem()
                .and_then(|s| s.to_str())
                .ok_or_else(|| fail("Invalid attachment name"))?;
            let extension = source
                .extension()
                .and_then(|s| s.to_str())
                .map(|s| format!(".{s}"))
                .unwrap_or_default();
            let filename = format!("{stem} (conflict {}){extension}", &head.id[..8]);
            let copy_path = source
                .parent()
                .unwrap_or_else(|| Path::new(""))
                .join(filename)
                .to_string_lossy()
                .replace('\\', "/");
            self.check_collision(&copy_path, None)?;
            let mut copy = head.clone();
            copy.id = Uuid::new_v4().to_string();
            copy.item_id = new_item;
            copy.path = copy_path;
            copy.parents = vec![];
            copy.created_at = now();
            self.insert_revision(&copy, false)?;
            self.apply_revision(&copy)?;
        }
        self.resolve_conflict(item, None, path, Some(primary))
    }
    pub fn info(&self) -> Result<VaultInfo> {
        let mut folders = Vec::new();
        for entry in walkdir::WalkDir::new(&self.root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| e.file_name() != ".notes")
        {
            let entry = entry.map_err(|e| fail(e.to_string()))?;
            if entry.file_type().is_dir() && entry.path() != self.root {
                folders.push(
                    entry
                        .path()
                        .strip_prefix(&self.root)
                        .map_err(|_| fail("Folder outside vault"))?
                        .to_string_lossy()
                        .replace('\\', "/"),
                );
            }
        }
        folders.sort();
        let pending =
            self.db
                .query_row("SELECT count(*) FROM revisions WHERE uploaded=0", [], |r| {
                    r.get(0)
                })?;
        let conflicts = self.conflicts()?.len();
        let status = SyncStatus {
            state: self
                .get_state("sync_state")?
                .unwrap_or_else(|| "local".into()),
            pending,
            conflicts,
            last_sync: self.get_state("last_sync")?.and_then(|s| s.parse().ok()),
            message: self.get_state("sync_error")?.filter(|s| !s.is_empty()),
        };
        Ok(VaultInfo {
            root: self.root.to_string_lossy().into(),
            name: self
                .root
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("Vault")
                .into(),
            notes: self.notes()?,
            folders,
            status,
        })
    }
}

pub fn hash_file(path: &Path) -> Result<String> {
    use std::io::Read;
    let mut file = fs::File::open(path)?;
    let mut buffer = [0; 65536];
    let mut digest = Sha256::new();
    loop {
        let size = file.read(&mut buffer)?;
        if size == 0 {
            break;
        }
        digest.update(&buffer[..size]);
    }
    Ok(hex::encode(digest.finalize()))
}
