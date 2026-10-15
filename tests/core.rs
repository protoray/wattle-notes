use async_trait::async_trait;
use notes_core::{
    crypto::{self, VaultConfig, VaultKey},
    drive::{Remote, RemoteFile},
    error::fail,
    links,
    model::{ItemKind, Revision},
    paths, sync,
    vault::{with_identity, Vault},
    Result,
};
use std::{
    collections::HashMap,
    fs,
    path::Path,
    sync::{Mutex, OnceLock},
};
use tempfile::TempDir;
use uuid::Uuid;

fn encryption() -> (VaultConfig, VaultKey, String) {
    static CONFIG: OnceLock<(VaultConfig, VaultKey, String)> = OnceLock::new();
    CONFIG
        .get_or_init(|| crypto::create_vault("correct horse battery staple").unwrap())
        .clone()
}
fn vault() -> (TempDir, Vault) {
    let dir = TempDir::new().unwrap();
    let vault = Vault::open(dir.path()).unwrap();
    (dir, vault)
}
fn revision(item: &str, path: &str, body: &str, parents: Vec<String>) -> Revision {
    Revision {
        id: Uuid::new_v4().to_string(),
        created_at: 1,
        item_id: item.into(),
        parents,
        path: path.into(),
        kind: ItemKind::Note,
        deleted: false,
        content: Some(with_identity(body, item).unwrap()),
        blob_id: None,
        dependencies: vec![],
    }
}

#[test]
fn encryption_roundtrip_authenticates_context_and_uses_fresh_nonces() {
    let (_, key, _) = encryption();
    let id = crypto::identity("vault", "item", "revision", "test");
    let one = crypto::seal(&key, &id, b"PRIVATE NOTE CONTENT").unwrap();
    let two = crypto::seal(&key, &id, b"PRIVATE NOTE CONTENT").unwrap();
    assert_ne!(one, two);
    assert!(!String::from_utf8_lossy(&one).contains("PRIVATE NOTE CONTENT"));
    assert_eq!(
        &*crypto::unseal(&key, &id, &one).unwrap(),
        b"PRIVATE NOTE CONTENT"
    );
    let other = crypto::identity("vault", "different item", "revision", "test");
    assert!(crypto::unseal(&key, &other, &one).is_err());
    assert!(crypto::unseal(&crypto::random_key(), &id, &one).is_err());
}
#[test]
fn passphrase_and_recovery_unlock_the_same_vault_without_google() {
    let (config, key, recovery) = encryption();
    assert_eq!(
        *crypto::unlock(&config, "correct horse battery staple", false)
            .unwrap()
            .0,
        *key.0
    );
    assert_eq!(*crypto::unlock(&config, &recovery, true).unwrap().0, *key.0);
    assert!(crypto::unlock(&config, "wrong passphrase", false).is_err());
    assert!(crypto::unlock(&config, "NN1-short", true).is_err());
}
#[test]
fn malicious_kdf_parameters_are_rejected_before_allocating_memory() {
    let (mut config, _, _) = encryption();
    config.memory_kib = u32::MAX;
    assert!(crypto::unlock(&config, "password", false).is_err());
    assert!(crypto::create_vault("short").is_err());
}
#[test]
fn metadata_tampering_and_unknown_versions_are_rejected() {
    let (_, key, _) = encryption();
    let id = crypto::identity("v", "i", "r", "p");
    let encoded = crypto::seal(&key, &id, b"secret").unwrap();
    let mut json: serde_json::Value = serde_json::from_slice(&encoded).unwrap();
    json["ciphertext"] = serde_json::json!("AAAA");
    assert!(crypto::unseal(&key, &id, &serde_json::to_vec(&json).unwrap()).is_err());
    let mut other = id.clone();
    other.version = 2;
    assert!(crypto::unseal(&key, &other, &encoded).is_err());
}
#[test]
fn streamed_attachments_reject_truncation_reordering_and_trailing_data() {
    let (_, key, _) = encryption();
    let id = crypto::identity("v", "blob", "blob", "attachment");
    let input = vec![0x61; 180000];
    let mut encrypted = Vec::new();
    crypto::seal_stream(&key, &id, input.as_slice(), &mut encrypted).unwrap();
    let mut output = Vec::new();
    crypto::unseal_stream(&key, &id, encrypted.as_slice(), &mut output).unwrap();
    assert_eq!(input, output);
    let mut truncated = encrypted.clone();
    truncated.truncate(truncated.len() - 20);
    assert!(crypto::unseal_stream(&key, &id, truncated.as_slice(), Vec::new()).is_err());
    let mut trailing = encrypted.clone();
    trailing.push(0);
    assert!(crypto::unseal_stream(&key, &id, trailing.as_slice(), Vec::new()).is_err());
    let header_len = u32::from_le_bytes(encrypted[10..14].try_into().unwrap()) as usize;
    let first = 14 + header_len;
    let frame = 1 + 4 + 24 + 65536 + 16;
    let mut reordered = encrypted.clone();
    reordered[first..first + frame].copy_from_slice(&encrypted[first + frame..first + 2 * frame]);
    assert!(crypto::unseal_stream(&key, &id, reordered.as_slice(), Vec::new()).is_err());
}
#[test]
fn empty_attachment_still_has_an_authenticated_final_frame() {
    let (_, key, _) = encryption();
    let id = crypto::identity("v", "b", "b", "attachment");
    let mut encrypted = Vec::new();
    crypto::seal_stream(&key, &id, &b""[..], &mut encrypted).unwrap();
    let mut out = Vec::new();
    crypto::unseal_stream(&key, &id, encrypted.as_slice(), &mut out).unwrap();
    assert!(out.is_empty());
}
#[test]
fn paths_reject_traversal_windows_names_and_symbolic_links() {
    for path in [
        "../secret",
        "/etc/passwd",
        "folder/../../secret",
        ".notes/index.db",
        ".NOTES/index.db",
        "CON.md",
        "folder/COM1.txt",
        "folder/abc.",
        "C:\\secret",
        "foo//bar",
    ] {
        assert!(paths::validate_relative(path).is_err(), "{path}");
    }
    assert!(paths::validate_relative("Work/日本語.md").is_ok());
    #[cfg(unix)]
    {
        let (dir, v) = vault();
        let elsewhere = TempDir::new().unwrap();
        std::os::unix::fs::symlink(elsewhere.path(), dir.path().join("linked")).unwrap();
        assert!(paths::inside(&v.root, "linked/file.md").is_err());
    }
}
#[test]
fn local_notes_preserve_metadata_and_search_survives_index_rebuild() {
    let (dir, mut v) = vault();
    fs::write(
        dir.path().join("Existing.md"),
        "---\ncustom: keep this\ntags: [work, personal]\n---\n# Existing\nA searchable aardvark.\n",
    )
    .unwrap();
    v.scan().unwrap();
    let note = v.notes().unwrap().remove(0);
    assert!(note.content.contains("custom: keep this"));
    assert_eq!(note.tags, vec!["personal", "work"]);
    assert_eq!(v.search("aardvark").unwrap().len(), 1);
    v.db.execute("DELETE FROM search", []).unwrap();
    v.rebuild_search().unwrap();
    assert_eq!(v.search("aardvark").unwrap()[0].id, note.id);
    assert!(v.search("\" OR arbitrary").is_ok());
}
#[test]
fn stale_editor_cannot_overwrite_an_external_edit_and_both_versions_survive() {
    let (dir, mut v) = vault();
    let note = v.create_note("Idea.md").unwrap();
    fs::write(
        dir.path().join("Idea.md"),
        format!("{}External thought.\n", note.content),
    )
    .unwrap();
    assert!(v
        .save_note(
            &note.id,
            &format!("{}Editor thought.\n", note.content),
            &note.hash
        )
        .is_err());
    assert!(fs::read_to_string(dir.path().join("Idea.md"))
        .unwrap()
        .contains("External thought"));
    let conflicts = v.conflicts().unwrap();
    assert_eq!(conflicts.len(), 1);
    assert_eq!(conflicts[0].versions.len(), 2);
}
#[test]
fn case_equivalent_note_names_are_rejected() {
    let (_v_dir, mut v) = vault();
    v.create_note("Idea.md").unwrap();
    assert!(v.create_note("idea.md").is_err());
}
#[test]
fn a_vault_cannot_be_opened_by_two_process_handles() {
    let (dir, _v) = vault();
    assert!(Vault::open(dir.path()).is_err());
}
#[test]
fn links_report_ambiguity_and_ignore_code_blocks() {
    let (_v_dir, mut v) = vault();
    v.create_note("A/Idea.md").unwrap();
    v.create_note("B/Idea.md").unwrap();
    assert_eq!(
        links::resolve("Home.md", "Idea", true, &v.notes().unwrap()).status,
        "ambiguous"
    );
    assert_eq!(
        links::targets("```\n[[not a link]]\n```\n[[B/Idea]] and `[[also not]]`\n").len(),
        1
    );
}
#[test]
fn rename_rewrites_links_and_preserves_note_identity() {
    let (_v_dir, mut v) = vault();
    let idea = v.create_note("Ideas/Idea.md").unwrap();
    let home = v.create_note("Home.md").unwrap();
    v.save_note(
        &home.id,
        &format!("{}[[Ideas/Idea]] and [idea](Ideas/Idea.md)\n", home.content),
        &home.hash,
    )
    .unwrap();
    let renamed = v.rename_note(&idea.id, "Work/Renamed.md").unwrap();
    assert_eq!(renamed.id, idea.id);
    let home = v.note(&home.id).unwrap();
    assert!(home.content.contains("[[Work/Renamed]]"));
    assert!(home.content.contains("(Work/Renamed.md)"));
}
#[test]
fn deleting_and_restoring_a_note_retains_history() {
    let (dir, mut v) = vault();
    let note = v.create_note("Idea.md").unwrap();
    let saved = v.heads(&note.id).unwrap()[0].id.clone();
    v.delete_note(&note.id).unwrap();
    assert!(!dir.path().join("Idea.md").exists());
    assert!(v.heads(&note.id).unwrap()[0].deleted);
    v.restore_revision(&saved).unwrap();
    assert_eq!(v.note(&note.id).unwrap().content, note.content);
    assert_eq!(v.revisions(Some(&note.id)).unwrap().len(), 3);
}
#[test]
fn export_includes_attachments_but_not_private_app_metadata_and_refuses_overwrites() {
    let (dir, mut v) = vault();
    v.create_note("A/Note.md").unwrap();
    fs::write(dir.path().join("file.txt"), "An attachment").unwrap();
    v.scan().unwrap();
    let dest = TempDir::new().unwrap();
    v.export_to(dest.path()).unwrap();
    assert!(dest.path().join("A/Note.md").exists());
    assert!(dest.path().join("file.txt").exists());
    assert!(!dest.path().join(".notes").exists());
    assert!(v.export_to(dest.path()).is_err());
}
#[test]
fn journal_recovers_an_interrupted_save_without_losing_an_external_edit() {
    let (dir, v) = vault();
    let root = dir.path().to_path_buf();
    let item = Uuid::new_v4().to_string();
    let note = revision(&item, "Recovered.md", "Pending save", vec![]);
    v.insert_revision(&note, false).unwrap();
    v.db.execute(
        "INSERT INTO writes VALUES(?,?,?)",
        rusqlite::params![note.path, note.content, ""],
    )
    .unwrap();
    drop(v);
    let recovered = Vault::open(&root).unwrap();
    assert!(recovered
        .note(&item)
        .unwrap()
        .content
        .contains("Pending save"));
    drop(recovered);
    let v = Vault::open(&root).unwrap();
    let base = v.note(&item).unwrap();
    let edit = revision(
        &item,
        "Recovered.md",
        "Pending second save",
        v.heads(&item)
            .unwrap()
            .iter()
            .map(|r| r.id.clone())
            .collect(),
    );
    v.insert_revision(&edit, false).unwrap();
    v.db.execute(
        "INSERT INTO writes VALUES(?,?,?)",
        rusqlite::params![edit.path, edit.content, base.hash],
    )
    .unwrap();
    fs::write(
        root.join("Recovered.md"),
        with_identity("External latest", &item).unwrap(),
    )
    .unwrap();
    drop(v);
    let recovered = Vault::open(&root).unwrap();
    assert!(fs::read_to_string(root.join("Recovered.md"))
        .unwrap()
        .contains("External latest"));
    assert_eq!(recovered.conflicts().unwrap().len(), 1);
}
#[test]
fn merge_ids_are_deterministic_and_nonoverlapping_edits_merge() {
    let item = Uuid::new_v4().to_string();
    let base = revision(&item, "Idea.md", "one\ntwo\nthree\n", vec![]);
    let a = revision(&item, "Idea.md", "ONE\ntwo\nthree\n", vec![base.id.clone()]);
    let b = revision(&item, "Idea.md", "one\ntwo\nTHREE\n", vec![base.id.clone()]);
    let all = vec![base, a.clone(), b.clone()];
    let first = sync::merge_heads(&[a.clone(), b.clone()], &all).unwrap();
    let second = sync::merge_heads(&[b, a], &all).unwrap();
    assert_eq!(first.id, second.id);
    assert!(first.content.unwrap().contains("ONE\ntwo\nTHREE"));
}
#[test]
fn missing_parents_cycles_and_cross_item_parents_are_rejected() {
    let a = Uuid::new_v4().to_string();
    let b = Uuid::new_v4().to_string();
    let mut one = revision(&a, "A.md", "A", vec![]);
    let two = revision(&b, "B.md", "B", vec![one.id.clone()]);
    assert!(sync::topological(&[one.clone(), two]).is_err());
    one.parents.push(Uuid::new_v4().to_string());
    assert!(sync::topological(&[one]).is_err());
}

type StoredFile = (RemoteFile, Option<String>, Vec<u8>);
#[derive(Default)]
struct MemoryRemote {
    files: Mutex<HashMap<String, StoredFile>>,
    fail_next: Mutex<bool>,
}
#[async_trait]
impl Remote for MemoryRemote {
    async fn allocate_id(&self) -> Result<String> {
        Ok(Uuid::new_v4().to_string())
    }
    async fn list(&self, parent: Option<&str>) -> Result<Vec<RemoteFile>> {
        let files = self.files.lock().unwrap();
        Ok(files
            .values()
            .filter(|(f, p, _)| {
                !f.trashed
                    && match parent {
                        Some(parent) => p.as_deref() == Some(parent),
                        None => f
                            .app_properties
                            .get("newNotesRole")
                            .is_some_and(|role| role == "vault"),
                    }
            })
            .map(|(f, _, _)| f.clone())
            .collect())
    }
    async fn create_folder(
        &self,
        id: &str,
        parent: Option<&str>,
        name: &str,
        properties: &HashMap<String, String>,
    ) -> Result<()> {
        self.files.lock().unwrap().entry(id.into()).or_insert((
            RemoteFile {
                id: id.into(),
                name: name.into(),
                mime_type: "application/vnd.google-apps.folder".into(),
                app_properties: properties.clone(),
                size: None,
                trashed: false,
                version: None,
            },
            parent.map(String::from),
            vec![],
        ));
        Ok(())
    }
    async fn upload(
        &self,
        id: &str,
        parent: &str,
        name: &str,
        path: &Path,
        properties: &HashMap<String, String>,
        replace: bool,
    ) -> Result<()> {
        let bytes = fs::read(path)?;
        let mut files = self.files.lock().unwrap();
        if !files.contains_key(id) || replace {
            files.insert(
                id.into(),
                (
                    RemoteFile {
                        id: id.into(),
                        name: name.into(),
                        mime_type: "application/octet-stream".into(),
                        app_properties: properties.clone(),
                        size: Some(bytes.len().to_string()),
                        trashed: false,
                        version: Some(notes_core::vault::hash(&bytes)),
                    },
                    Some(parent.into()),
                    bytes,
                ),
            );
        }
        let mut should_fail = self.fail_next.lock().unwrap();
        if *should_fail {
            *should_fail = false;
            return Err(fail("Simulated uncertain upload delivery"));
        }
        Ok(())
    }
    async fn download(&self, id: &str, destination: &Path, limit: u64) -> Result<()> {
        let files = self.files.lock().unwrap();
        let (_, _, bytes) = files.get(id).ok_or_else(|| fail("Missing remote file"))?;
        if bytes.len() as u64 > limit {
            return Err(fail("Too large"));
        }
        fs::create_dir_all(destination.parent().unwrap())?;
        fs::write(destination, bytes)?;
        Ok(())
    }
    async fn start_cursor(&self) -> Result<String> {
        Ok("cursor".into())
    }
    async fn changes(&self, _cursor: &str) -> Result<(String, Vec<String>)> {
        Ok(("next-cursor".into(), vec![]))
    }
    async fn trash(&self, id: &str) -> Result<()> {
        if let Some((file, _, _)) = self.files.lock().unwrap().get_mut(id) {
            file.trashed = true;
        }
        Ok(())
    }
}

#[tokio::test]
async fn encrypted_sync_restores_a_fresh_device_and_never_uploads_plaintext() {
    let (_a_dir, mut a) = vault();
    let (_b_dir, mut b) = vault();
    let remote = MemoryRemote::default();
    let (config, key, recovery) = encryption();
    let n = a.create_note("Work/Secret.md").unwrap();
    a.save_note(&n.id, &format!("{}TOP SECRET BODY\n", n.content), &n.hash)
        .unwrap();
    fs::write(a.root.join("attachment.txt"), "TOP SECRET ATTACHMENT").unwrap();
    sync::synchronize(&mut a, &remote, &config, &key)
        .await
        .unwrap();
    let recovered_key = crypto::unlock(&config, &recovery, true).unwrap();
    sync::synchronize(&mut b, &remote, &config, &recovered_key)
        .await
        .unwrap();
    assert!(b.note(&n.id).unwrap().content.contains("TOP SECRET BODY"));
    assert_eq!(
        fs::read_to_string(b.root.join("attachment.txt")).unwrap(),
        "TOP SECRET ATTACHMENT"
    );
    for (_, _, bytes) in remote.files.lock().unwrap().values() {
        let text = String::from_utf8_lossy(bytes);
        assert!(!text.contains("TOP SECRET BODY"));
        assert!(!text.contains("TOP SECRET ATTACHMENT"));
        assert!(!text.contains("correct horse"));
    }
    assert!(remote
        .files
        .lock()
        .unwrap()
        .values()
        .any(|(f, _, _)| f.name == "Secret.md.enc"));
    assert_eq!(a.info().unwrap().status.pending, 0);
}
#[tokio::test]
async fn two_offline_devices_merge_then_converge() {
    let (_a_dir, mut a) = vault();
    let (_b_dir, mut b) = vault();
    let remote = MemoryRemote::default();
    let (config, key, _) = encryption();
    let n = a.create_note("Idea.md").unwrap();
    a.save_note(
        &n.id,
        &with_identity("one\ntwo\nthree\n", &n.id).unwrap(),
        &n.hash,
    )
    .unwrap();
    sync::synchronize(&mut a, &remote, &config, &key)
        .await
        .unwrap();
    sync::synchronize(&mut b, &remote, &config, &key)
        .await
        .unwrap();
    let na = a.note(&n.id).unwrap();
    let nb = b.note(&n.id).unwrap();
    a.save_note(&n.id, &na.content.replace("one", "ONE"), &na.hash)
        .unwrap();
    b.save_note(&n.id, &nb.content.replace("three", "THREE"), &nb.hash)
        .unwrap();
    sync::synchronize(&mut a, &remote, &config, &key)
        .await
        .unwrap();
    sync::synchronize(&mut b, &remote, &config, &key)
        .await
        .unwrap();
    sync::synchronize(&mut a, &remote, &config, &key)
        .await
        .unwrap();
    assert_eq!(
        a.note(&n.id).unwrap().content,
        b.note(&n.id).unwrap().content
    );
    assert!(a.note(&n.id).unwrap().content.contains("ONE\ntwo\nTHREE"));
    assert!(a.conflicts().unwrap().is_empty());
}
#[tokio::test]
async fn overlapping_edits_preserve_both_versions_and_resolve_across_devices() {
    let (_a_dir, mut a) = vault();
    let (_b_dir, mut b) = vault();
    let remote = MemoryRemote::default();
    let (config, key, _) = encryption();
    let n = a.create_note("Idea.md").unwrap();
    sync::synchronize(&mut a, &remote, &config, &key)
        .await
        .unwrap();
    sync::synchronize(&mut b, &remote, &config, &key)
        .await
        .unwrap();
    let na = a.note(&n.id).unwrap();
    let nb = b.note(&n.id).unwrap();
    a.save_note(&n.id, &na.content.replace("# Idea", "# Device A"), &na.hash)
        .unwrap();
    b.save_note(&n.id, &nb.content.replace("# Idea", "# Device B"), &nb.hash)
        .unwrap();
    sync::synchronize(&mut a, &remote, &config, &key)
        .await
        .unwrap();
    sync::synchronize(&mut b, &remote, &config, &key)
        .await
        .unwrap();
    assert_eq!(b.conflicts().unwrap()[0].versions.len(), 2);
    b.resolve_conflict(
        &n.id,
        Some(with_identity("# Combined", &n.id).unwrap()),
        "Idea.md",
        None,
    )
    .unwrap();
    sync::synchronize(&mut b, &remote, &config, &key)
        .await
        .unwrap();
    sync::synchronize(&mut a, &remote, &config, &key)
        .await
        .unwrap();
    assert!(a.note(&n.id).unwrap().content.contains("Combined"));
    assert!(a.conflicts().unwrap().is_empty());
}
#[tokio::test]
async fn delete_versus_edit_preserves_the_edit_and_never_silently_deletes_it() {
    let (_a_dir, mut a) = vault();
    let (_b_dir, mut b) = vault();
    let remote = MemoryRemote::default();
    let (config, key, _) = encryption();
    let n = a.create_note("Idea.md").unwrap();
    sync::synchronize(&mut a, &remote, &config, &key)
        .await
        .unwrap();
    sync::synchronize(&mut b, &remote, &config, &key)
        .await
        .unwrap();
    a.delete_note(&n.id).unwrap();
    let nb = b.note(&n.id).unwrap();
    b.save_note(&n.id, &format!("{}Keep this thought", nb.content), &nb.hash)
        .unwrap();
    sync::synchronize(&mut a, &remote, &config, &key)
        .await
        .unwrap();
    sync::synchronize(&mut b, &remote, &config, &key)
        .await
        .unwrap();
    assert!(b.note(&n.id).unwrap().content.contains("Keep this thought"));
    assert_eq!(b.conflicts().unwrap().len(), 1);
}
#[tokio::test]
async fn interrupted_upload_is_idempotent_and_missing_remote_history_pauses_sync() {
    let (_v_dir, mut v) = vault();
    let remote = MemoryRemote::default();
    let (config, key, _) = encryption();
    let n = v.create_note("Idea.md").unwrap();
    *remote.fail_next.lock().unwrap() = true;
    assert!(sync::synchronize(&mut v, &remote, &config, &key)
        .await
        .is_err());
    sync::synchronize(&mut v, &remote, &config, &key)
        .await
        .unwrap();
    let count = remote.files.lock().unwrap().len();
    sync::synchronize(&mut v, &remote, &config, &key)
        .await
        .unwrap();
    assert_eq!(count, remote.files.lock().unwrap().len());
    let id = remote
        .files
        .lock()
        .unwrap()
        .iter()
        .find(|(_, (f, _, _))| {
            f.app_properties
                .get("newNotesRole")
                .is_some_and(|r| r == "revision")
        })
        .map(|(id, _)| id.clone())
        .unwrap();
    remote.files.lock().unwrap().remove(&id);
    assert!(sync::synchronize(&mut v, &remote, &config, &key)
        .await
        .is_err());
    assert!(v.note(&n.id).is_ok());
    assert_eq!(v.info().unwrap().status.state, "error");
}
#[tokio::test]
async fn three_offline_devices_preserve_all_nonoverlapping_edits() {
    let (_a_dir, mut a) = vault();
    let (_b_dir, mut b) = vault();
    let (_c_dir, mut c) = vault();
    let remote = MemoryRemote::default();
    let (config, key, _) = encryption();
    let n = a.create_note("Idea.md").unwrap();
    a.save_note(
        &n.id,
        &with_identity("one\nspacer\ntwo\nspacer\nthree\n", &n.id).unwrap(),
        &n.hash,
    )
    .unwrap();
    for v in [&mut a, &mut b, &mut c] {
        sync::synchronize(v, &remote, &config, &key).await.unwrap();
    }
    for (v, old, new) in [
        (&mut a, "one", "ONE"),
        (&mut b, "two", "TWO"),
        (&mut c, "three", "THREE"),
    ] {
        let note = v.note(&n.id).unwrap();
        v.save_note(&n.id, &note.content.replace(old, new), &note.hash)
            .unwrap();
    }
    for v in [&mut a, &mut b, &mut c] {
        sync::synchronize(v, &remote, &config, &key).await.unwrap();
    }
    for v in [&mut a, &mut b] {
        sync::synchronize(v, &remote, &config, &key).await.unwrap();
    }
    let content = a.note(&n.id).unwrap().content;
    assert!(content.contains("ONE"));
    assert!(content.contains("TWO"));
    assert!(content.contains("THREE"));
    assert!(a.conflicts().unwrap().is_empty());
}

#[test]
fn malformed_unicode_percent_links_do_not_panic() {
    let (_dir, mut v) = vault();
    v.create_note("Idea.md").unwrap();
    assert_eq!(
        links::resolve("Home.md", "%😊", true, &v.notes().unwrap()).status,
        "broken"
    );
}

#[tokio::test]
async fn modified_remote_revision_is_authenticated_again_and_local_content_survives() {
    let (_dir, mut v) = vault();
    let remote = MemoryRemote::default();
    let (config, key, _) = encryption();
    let note = v.create_note("Idea.md").unwrap();
    sync::synchronize(&mut v, &remote, &config, &key)
        .await
        .unwrap();
    sync::synchronize(&mut v, &remote, &config, &key)
        .await
        .unwrap();
    {
        let mut files = remote.files.lock().unwrap();
        let (_, _, bytes) = files
            .values_mut()
            .find(|(f, _, _)| {
                f.app_properties
                    .get("newNotesRole")
                    .is_some_and(|r| r == "revision")
            })
            .unwrap();
        bytes[0] = b'!';
    }
    {
        let mut files = remote.files.lock().unwrap();
        for (f, _, bytes) in files.values_mut() {
            if f.app_properties
                .get("newNotesRole")
                .is_some_and(|r| r == "revision")
            {
                f.version = Some(notes_core::vault::hash(bytes));
            }
        }
    }
    assert!(sync::synchronize(&mut v, &remote, &config, &key)
        .await
        .is_err());
    assert_eq!(v.note(&note.id).unwrap().content, note.content);
}

#[tokio::test]
async fn fresh_device_restores_unresolved_conflicts_as_readable_notes() {
    let (_a, mut a) = vault();
    let (_b, mut b) = vault();
    let (_c, mut c) = vault();
    let remote = MemoryRemote::default();
    let (config, key, _) = encryption();
    let note = a.create_note("Idea.md").unwrap();
    sync::synchronize(&mut a, &remote, &config, &key)
        .await
        .unwrap();
    sync::synchronize(&mut b, &remote, &config, &key)
        .await
        .unwrap();
    let first = a.note(&note.id).unwrap();
    let second = b.note(&note.id).unwrap();
    a.save_note(
        &note.id,
        &first.content.replace("# Idea", "# First"),
        &first.hash,
    )
    .unwrap();
    b.save_note(
        &note.id,
        &second.content.replace("# Idea", "# Second"),
        &second.hash,
    )
    .unwrap();
    sync::synchronize(&mut a, &remote, &config, &key)
        .await
        .unwrap();
    sync::synchronize(&mut b, &remote, &config, &key)
        .await
        .unwrap();
    sync::synchronize(&mut c, &remote, &config, &key)
        .await
        .unwrap();
    assert!(c.note(&note.id).is_ok());
    assert_eq!(c.conflicts().unwrap()[0].versions.len(), 2);
    c.scan().unwrap();
    assert_eq!(c.conflicts().unwrap()[0].versions.len(), 2);
}

#[tokio::test]
async fn attachment_dependencies_survive_interruption_and_binary_conflicts_retain_both_blobs() {
    let (_a, mut a) = vault();
    let (_b, mut b) = vault();
    let remote = MemoryRemote::default();
    let (config, key, _) = encryption();
    fs::write(a.root.join("diagram.txt"), "original binary").unwrap();
    sync::synchronize(&mut a, &remote, &config, &key)
        .await
        .unwrap();
    sync::synchronize(&mut b, &remote, &config, &key)
        .await
        .unwrap();
    fs::write(a.root.join("diagram.txt"), "binary A").unwrap();
    fs::write(b.root.join("diagram.txt"), "binary B").unwrap();
    sync::synchronize(&mut a, &remote, &config, &key)
        .await
        .unwrap();
    sync::synchronize(&mut b, &remote, &config, &key)
        .await
        .unwrap();
    let conflict = b.conflicts().unwrap().remove(0);
    assert_eq!(conflict.versions.len(), 2);
    let content: Vec<String> = conflict
        .versions
        .iter()
        .map(|r| {
            fs::read_to_string(
                b.internal(&format!("blobs/{}", r.blob_id.as_ref().unwrap()))
                    .unwrap(),
            )
            .unwrap()
        })
        .collect();
    assert!(content.contains(&"binary A".into()));
    assert!(content.contains(&"binary B".into()));
}

#[test]
fn externally_deleted_attachment_gets_a_restorable_tombstone() {
    let (_dir, mut v) = vault();
    fs::write(v.root.join("diagram.txt"), "attachment").unwrap();
    v.scan().unwrap();
    let saved = v.revisions(None).unwrap().remove(0);
    fs::remove_file(v.root.join("diagram.txt")).unwrap();
    v.scan().unwrap();
    assert!(v.heads(&saved.item_id).unwrap()[0].deleted);
    v.restore_revision(&saved.id).unwrap();
    assert_eq!(
        fs::read_to_string(v.root.join("diagram.txt")).unwrap(),
        "attachment"
    );
}

#[tokio::test]
async fn a_remote_path_collision_never_overwrites_an_unrelated_local_note() {
    let (_a, mut a) = vault();
    let (_b, mut b) = vault();
    let remote = MemoryRemote::default();
    let (config, key, _) = encryption();
    let remote_note = a.create_note("Idea.md").unwrap();
    let local_note = b.create_note("Idea.md").unwrap();
    let local = b
        .save_note(
            &local_note.id,
            &format!("{}Local unique body", local_note.content),
            &local_note.hash,
        )
        .unwrap();
    sync::synchronize(&mut a, &remote, &config, &key)
        .await
        .unwrap();
    sync::synchronize(&mut b, &remote, &config, &key)
        .await
        .unwrap();
    assert_eq!(b.note(&local_note.id).unwrap().content, local.content);
    assert!(b
        .conflicts()
        .unwrap()
        .iter()
        .any(|c| c.item_id == remote_note.id));
}

#[test]
fn oauth_state_and_callback_paths_are_validated() {
    assert_eq!(
        notes_core::oauth::validate_callback("/oauth/callback?state=expected&code=123", "expected")
            .unwrap(),
        "123"
    );
    assert!(notes_core::oauth::validate_callback(
        "/oauth/callback?state=attacker&code=123",
        "expected"
    )
    .is_err());
    assert!(
        notes_core::oauth::validate_callback("/wrong?state=expected&code=123", "expected").is_err()
    );
    assert!(notes_core::oauth::validate_callback(
        "/oauth/callback?state=expected&error=access_denied",
        "expected"
    )
    .is_err());
}

#[test]
fn interrupted_rename_recovers_without_duplicate_ids_or_losing_a_late_edit() {
    let (dir, mut v) = vault();
    let original = v.create_note("Old.md").unwrap();
    let parents = v
        .heads(&original.id)
        .unwrap()
        .iter()
        .map(|r| r.id.clone())
        .collect();
    let moved = revision(&original.id, "New.md", "Moved note", parents);
    v.insert_revision(&moved, false).unwrap();
    fs::write(v.root.join("New.md"), moved.content.as_ref().unwrap()).unwrap();
    fs::write(
        v.root.join("Old.md"),
        with_identity("Late edit in old file", &original.id).unwrap(),
    )
    .unwrap();
    v.db.execute(
        "INSERT INTO moves VALUES(?,?,?,?,?)",
        rusqlite::params![original.id, "Old.md", "New.md", original.hash, moved.id],
    )
    .unwrap();
    drop(v);
    let recovered = Vault::open(dir.path()).unwrap();
    assert!(!dir.path().join("Old.md").exists());
    assert!(recovered
        .note(&original.id)
        .unwrap()
        .content
        .contains("Moved note"));
    let conflicts = recovered.conflicts().unwrap();
    assert_eq!(conflicts.len(), 1);
    assert!(conflicts[0]
        .versions
        .iter()
        .any(|r| r.content.as_ref().is_some_and(|s| s.contains("Late edit"))));
}

#[tokio::test]
async fn keeping_both_conflicting_attachments_materializes_and_syncs_each_file() {
    let (_a, mut a) = vault();
    let (_b, mut b) = vault();
    let (_c, mut c) = vault();
    let remote = MemoryRemote::default();
    let (config, key, _) = encryption();
    fs::write(a.root.join("diagram.txt"), "original").unwrap();
    sync::synchronize(&mut a, &remote, &config, &key)
        .await
        .unwrap();
    sync::synchronize(&mut b, &remote, &config, &key)
        .await
        .unwrap();
    fs::write(a.root.join("diagram.txt"), "binary A").unwrap();
    fs::write(b.root.join("diagram.txt"), "binary B").unwrap();
    sync::synchronize(&mut a, &remote, &config, &key)
        .await
        .unwrap();
    sync::synchronize(&mut b, &remote, &config, &key)
        .await
        .unwrap();
    let conflict = b.conflicts().unwrap().remove(0);
    b.keep_both_attachments(&conflict.item_id, &conflict.versions[0].id, "diagram.txt")
        .unwrap();
    sync::synchronize(&mut b, &remote, &config, &key)
        .await
        .unwrap();
    sync::synchronize(&mut c, &remote, &config, &key)
        .await
        .unwrap();
    let contents: Vec<String> = fs::read_dir(&c.root)
        .unwrap()
        .filter_map(|entry| {
            let path = entry.ok()?.path();
            if path.is_file() {
                fs::read_to_string(path).ok()
            } else {
                None
            }
        })
        .collect();
    assert!(contents.contains(&"binary A".into()));
    assert!(contents.contains(&"binary B".into()));
    assert!(c.conflicts().unwrap().is_empty());
}

#[test]
fn empty_frontmatter_and_oversized_path_components_are_handled() {
    assert_eq!(
        notes_core::vault::frontmatter("---\n---\n# Empty")
            .unwrap()
            .1,
        "# Empty"
    );
    assert!(paths::validate_relative(&format!("{}.md", "a".repeat(256))).is_err());
}

#[test]
fn encrypted_full_backups_restore_current_files_history_and_conflicts() {
    let (_source, mut source) = vault();
    let (config, key, recovery) = encryption();
    let note = source.create_note("Work/Backup test.md").unwrap();
    let note = source
        .save_note(
            &note.id,
            "---\ntags: [backup-marker]\n---\n# Backup test\n\nWEBDAV-PRIVATE-NOTE-98765\n",
            &note.hash,
        )
        .unwrap();
    let linked = source.create_note("Linked.md").unwrap();
    let linked = source
        .save_note(
            &linked.id,
            "# Linked\n\n[[Work/Backup test]]\n",
            &linked.hash,
        )
        .unwrap();
    fs::write(
        source.root.join("Linked.md"),
        with_identity("# External edit\n", &linked.id).unwrap(),
    )
    .unwrap();
    assert!(source
        .save_note(&linked.id, "# Overlapping draft\n", &linked.hash)
        .is_err());
    let payload = tempfile::NamedTempFile::new().unwrap();
    fs::write(payload.path(), b"WEBDAV-PRIVATE-ATTACHMENT-98765").unwrap();
    let attachment = source.import_attachment(payload.path()).unwrap();
    let deleted = source.create_note("Deleted.md").unwrap();
    source.delete_note(&deleted.id).unwrap();
    source.create_folder("Empty folder").unwrap();
    let archive_parent = TempDir::new().unwrap();
    let archive = archive_parent.path().join("test.wnbackup");
    notes_core::backup::create(&mut source, &config, &key, &archive).unwrap();
    let bytes = fs::read(&archive).unwrap();
    let visible = String::from_utf8_lossy(&bytes);
    assert!(!visible.contains("WEBDAV-PRIVATE-NOTE-98765"));
    assert!(!visible.contains("WEBDAV-PRIVATE-ATTACHMENT-98765"));
    assert!(!visible.contains("backup-marker"));
    let parent = TempDir::new().unwrap();
    for (secret, is_recovery) in [
        ("correct horse battery staple", false),
        (recovery.as_str(), true),
    ] {
        let restored =
            notes_core::backup::restore(&archive, parent.path(), secret, is_recovery).unwrap();
        let restored = Vault::open(restored).unwrap();
        assert_eq!(restored.note(&note.id).unwrap().content, note.content);
        assert_eq!(
            restored.revisions(None).unwrap().len(),
            source.revisions(None).unwrap().len()
        );
        assert_eq!(
            restored.conflicts().unwrap().len(),
            source.conflicts().unwrap().len()
        );
        assert!(restored.root.join("Empty folder").is_dir());
        assert_eq!(
            fs::read(restored.root.join(&attachment)).unwrap(),
            b"WEBDAV-PRIVATE-ATTACHMENT-98765"
        );
        assert_eq!(restored.search("98765").unwrap().len(), 1);
        assert!(!restored.root.join("Deleted.md").exists());
    }
}
#[test]
fn backup_restore_rejects_bad_keys_tampering_and_truncation_without_publishing() {
    let (_source, mut source) = vault();
    source.create_note("Test.md").unwrap();
    let (config, key, _) = encryption();
    let dir = TempDir::new().unwrap();
    let archive = dir.path().join("test.wnbackup");
    notes_core::backup::create(&mut source, &config, &key, &archive).unwrap();
    let parent = TempDir::new().unwrap();
    assert!(
        notes_core::backup::restore(&archive, parent.path(), "wrong passphrase", false).is_err()
    );
    let original = fs::read(&archive).unwrap();
    let mut variants = vec![original[..original.len() - 10].to_vec(), original.clone()];
    variants[1].push(1);
    let mut tampered = original;
    let last = tampered.len() - 2;
    tampered[last] ^= 1;
    variants.push(tampered);
    for variant in variants {
        fs::write(&archive, variant).unwrap();
        assert!(notes_core::backup::restore(
            &archive,
            parent.path(),
            "correct horse battery staple",
            false
        )
        .is_err());
        assert_eq!(fs::read_dir(parent.path()).unwrap().count(), 0);
    }
}
