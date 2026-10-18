use notes_core as core_lib;
#[path = "support/remote.rs"]
mod memory_remote;
use memory_remote::MemoryRemote;
use notes_core::{
    crypto::{self, VaultConfig, VaultKey},
    links,
    model::{ItemKind, Revision},
    paths, sync,
    vault::{with_identity, Vault},
};
use std::{
    fs,
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

#[test]
fn patched_sqlite_protects_notebook_schema_and_keeps_search_working() {
    let (_dir, mut v) = vault();
    assert!(
        rusqlite::version_number() >= 3_053_002,
        "SQLite {} is older than the security baseline",
        rusqlite::version()
    );
    assert!(v
        .db
        .db_config(rusqlite::config::DbConfig::SQLITE_DBCONFIG_DEFENSIVE)
        .unwrap());
    assert!(!v
        .db
        .db_config(rusqlite::config::DbConfig::SQLITE_DBCONFIG_TRUSTED_SCHEMA)
        .unwrap());
    let note = v.create_note("Security.md").unwrap();
    v.save_note(&note.id, "# Security\n\nneedle_73647", &note.hash)
        .unwrap();
    assert_eq!(v.search("needle_73647").unwrap().len(), 1);
    assert!(v
        .db
        .execute_batch("PRAGMA writable_schema=ON; DELETE FROM sqlite_schema WHERE name='notes';")
        .is_err());
    assert_eq!(v.notes().unwrap().len(), 1);
    assert_eq!(v.search("needle_73647").unwrap().len(), 1);
}

#[test]
fn patched_sqlite_opens_a_legacy_346_index_without_losing_notebook_data() {
    let dir = TempDir::new().unwrap();
    fs::create_dir(dir.path().join(".notes")).unwrap();
    let index = dir.path().join(".notes/index.db");
    fs::write(&index, include_bytes!("fixtures/legacy-sqlite346.bin")).unwrap();
    let old = rusqlite::Connection::open(&index).unwrap();
    let content: String = old
        .query_row("SELECT content FROM notes", [], |row| row.get(0))
        .unwrap();
    drop(old);
    fs::write(dir.path().join("Legacy.md"), &content).unwrap();
    let mut v = Vault::open(dir.path()).unwrap();
    let id = "93a55693-322f-4fd8-9859-fa54007657cb";
    let note = v.note(id).unwrap();
    assert!(note.content.contains("custom: preserved"));
    assert_eq!(note.tags, ["legacy"]);
    assert_eq!(
        v.get_state("security_fixture").unwrap().as_deref(),
        Some("legacy-state-preserved")
    );
    assert!(v
        .revisions(Some(id))
        .unwrap()
        .iter()
        .any(
            |revision| revision.id == "349af5dc-60ab-46bc-b03e-92fafca284cf"
                && revision.content.as_deref() == Some(content.as_str())
        ));
    assert_eq!(v.search("aardvark").unwrap()[0].id, id);
    let saved = v
        .save_note(id, &(note.content + "\nPatched engine edit.\n"), &note.hash)
        .unwrap();
    drop(v);
    let v = Vault::open(dir.path()).unwrap();
    assert_eq!(v.note(id).unwrap().content, saved.content);
    assert_eq!(v.search("Patched").unwrap()[0].id, id);
}

#[cfg(target_os = "linux")]
#[test]
fn patched_glib_string_iterators_preserve_values_in_both_directions() {
    use glib::variant::ToVariant;
    let variant = ["alpha", "日本語", "omega"].to_variant();
    let strings = || variant.array_iter_str().unwrap();
    assert_eq!(strings().collect::<Vec<_>>(), ["alpha", "日本語", "omega"]);
    assert_eq!(
        strings().rev().collect::<Vec<_>>(),
        ["omega", "日本語", "alpha"]
    );
    assert_eq!(strings().nth(1), Some("日本語"));
    assert_eq!(strings().nth_back(1), Some("日本語"));
    assert_eq!(strings().last(), Some("omega"));
    let mut ends = strings();
    assert_eq!(ends.next(), Some("alpha"));
    assert_eq!(ends.next_back(), Some("omega"));
    assert_eq!(ends.next(), Some("日本語"));
    assert_eq!(ends.next_back(), None);
    let empty = Vec::<String>::new().to_variant();
    assert_eq!(empty.array_iter_str().unwrap().next(), None);
}

#[test]
fn notebook_trash_preserves_nested_pages_files_and_empty_folders_after_restart() {
    let (dir, mut v) = vault();
    let page = v.create_note("Work/Plans/Page.md").unwrap();
    let other = v.create_note("Workshop/Keep.md").unwrap();
    v.create_folder("Work/Empty").unwrap();
    fs::create_dir_all(dir.path().join("Work/attachments")).unwrap();
    fs::write(
        dir.path().join("Work/attachments/image.png"),
        b"image bytes",
    )
    .unwrap();
    fs::write(dir.path().join("Work/.private-file"), b"unindexed bytes").unwrap();
    v.scan().unwrap();
    let attachment = v
        .revisions(None)
        .unwrap()
        .into_iter()
        .find(|r| r.kind == ItemKind::Attachment)
        .unwrap();
    v.delete_folder("Work").unwrap();
    assert!(!dir.path().join("Work").exists());
    assert!(v.note(&page.id).is_err());
    assert_eq!(v.note(&other.id).unwrap().path, "Workshop/Keep.md");
    assert!(v.heads(&page.id).unwrap()[0].deleted);
    assert!(v.heads(&attachment.item_id).unwrap()[0].deleted);
    assert!(v.search("Page").unwrap().is_empty());
    let entries = v.deleted_folders().unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].path, "Work");
    drop(v);
    let mut v = Vault::open(dir.path()).unwrap();
    v.restore_folder(&entries[0].id).unwrap();
    assert_eq!(v.note(&page.id).unwrap().content, page.content);
    assert!(dir.path().join("Work/Empty").is_dir());
    assert_eq!(
        fs::read(dir.path().join("Work/.private-file")).unwrap(),
        b"unindexed bytes"
    );
    assert_eq!(
        fs::read(dir.path().join("Work/attachments/image.png")).unwrap(),
        b"image bytes"
    );
    assert!(!v.heads(&attachment.item_id).unwrap()[0].deleted);
    assert!(v.deleted_folders().unwrap().is_empty());
    assert_eq!(v.search("Page").unwrap().len(), 1);
}

#[test]
fn empty_notebooks_can_be_deleted_restored_and_deleted_again() {
    let (_dir, mut v) = vault();
    v.create_folder("Empty/Nested").unwrap();
    v.delete_folder("Empty").unwrap();
    assert!(!v.root.join("Empty").exists());
    let first = v.deleted_folders().unwrap().remove(0);
    v.restore_folder(&first.id).unwrap();
    assert!(v.root.join("Empty/Nested").is_dir());
    v.delete_folder("Empty").unwrap();
    let second = v.deleted_folders().unwrap().remove(0);
    assert_ne!(first.id, second.id);
    assert!(v.restore_folder(&first.id).is_err());
    v.restore_folder(&second.id).unwrap();
    assert!(v.root.join("Empty/Nested").is_dir());
}

#[test]
fn notebook_trash_rolls_back_failed_indexing_without_losing_files() {
    let (_dir, mut v) = vault();
    let note = v.create_note("Work/Page.md").unwrap();
    v.db.execute_batch("CREATE TEMP TRIGGER fail_delete BEFORE INSERT ON revisions WHEN json_extract(NEW.data,'$.deleted') = 1 BEGIN SELECT RAISE(ABORT,'simulated index failure'); END;").unwrap();
    assert!(v.delete_folder("Work").is_err());
    assert_eq!(
        fs::read_to_string(v.root.join("Work/Page.md")).unwrap(),
        note.content
    );
    assert_eq!(v.note(&note.id).unwrap().content, note.content);
    assert!(v.deleted_folders().unwrap().is_empty());
    v.db.execute_batch("DROP TRIGGER fail_delete;").unwrap();
    v.delete_folder("Work").unwrap();
    let deleted = v.deleted_folders().unwrap().remove(0);
    v.db.execute_batch("CREATE TEMP TRIGGER fail_restore BEFORE INSERT ON revisions WHEN json_extract(NEW.data,'$.deleted') = 0 BEGIN SELECT RAISE(ABORT,'simulated index failure'); END;").unwrap();
    assert!(v.restore_folder(&deleted.id).is_err());
    assert!(!v.root.join("Work").exists());
    assert_eq!(v.deleted_folders().unwrap()[0].id, deleted.id);
    v.db.execute_batch("DROP TRIGGER fail_restore;").unwrap();
    v.restore_folder(&deleted.id).unwrap();
    assert_eq!(v.note(&note.id).unwrap().content, note.content);
}

#[test]
fn interrupted_notebook_moves_are_reconciled_on_reopen() {
    let (dir, mut v) = vault();
    let note = v.create_note("Work/Page.md").unwrap();
    let id = Uuid::new_v4().to_string();
    let metadata = v
        .internal(&format!("folder-trash/{id}/entry.json"))
        .unwrap();
    let contents = v.internal(&format!("folder-trash/{id}/contents")).unwrap();
    paths::atomic_write(
        &metadata,
        &serde_json::to_vec(&notes_core::model::DeletedFolder {
            id: id.clone(),
            path: "Work".into(),
            deleted_at: 1,
        })
        .unwrap(),
    )
    .unwrap();
    // Simulate exit after the move but before deletion revisions are indexed.
    fs::rename(v.root.join("Work"), &contents).unwrap();
    drop(v);
    v = Vault::open(dir.path()).unwrap();
    assert!(v.heads(&note.id).unwrap()[0].deleted);
    assert_eq!(v.deleted_folders().unwrap()[0].id, id);
    // Simulate the matching restore interruption before the live scan.
    fs::rename(&contents, v.root.join("Work")).unwrap();
    drop(v);
    v = Vault::open(dir.path()).unwrap();
    assert_eq!(v.note(&note.id).unwrap().content, note.content);
    assert!(!v.heads(&note.id).unwrap()[0].deleted);
    assert!(v.deleted_folders().unwrap().is_empty());
}

#[test]
fn notebook_trash_rejects_root_unsafe_paths_conflicts_and_restore_collisions() {
    let (dir, mut v) = vault();
    let note = v.create_note("Work/Page.md").unwrap();
    for path in [
        "",
        ".",
        "..",
        "../outside",
        ".notes",
        "Work/../Work",
        "Work/Page.md",
    ] {
        assert!(v.delete_folder(path).is_err(), "{path}");
    }
    v.mark_conflict(&note.id, "test conflict").unwrap();
    assert!(v.delete_folder("Work").is_err());
    assert!(dir.path().join("Work/Page.md").exists());
    v.clear_conflict(&note.id).unwrap();
    let saved = v.heads(&note.id).unwrap()[0].id.clone();
    v.delete_folder("Work").unwrap();
    let deleted = v.deleted_folders().unwrap().remove(0);
    v.create_note("Work/Keep.md").unwrap();
    assert!(v.restore_folder(&deleted.id).is_err());
    assert!(dir.path().join("Work/Keep.md").exists());
    // Restore the original page separately, move it elsewhere, and ensure whole
    // folder recovery will not introduce a second file with the same identity.
    v.restore_revision(&saved).unwrap();
    v.rename_note(&note.id, "Elsewhere.md").unwrap();
    v.delete_folder("Work").unwrap();
    assert!(v.restore_folder(&deleted.id).is_err());
    assert!(dir.path().join("Elsewhere.md").exists());
    assert!(v.restore_folder("../outside").is_err());
}

#[cfg(unix)]
#[test]
fn notebook_trash_does_not_follow_symlinks() {
    use std::os::unix::fs::symlink;
    let (_dir, mut v) = vault();
    let outside = TempDir::new().unwrap();
    fs::write(outside.path().join("keep.txt"), b"outside").unwrap();
    symlink(outside.path(), v.root.join("Linked")).unwrap();
    assert!(v.delete_folder("Linked").is_err());
    v.create_folder("Work").unwrap();
    symlink(outside.path(), v.root.join("Work/link")).unwrap();
    v.delete_folder("Work").unwrap();
    let deleted = v.deleted_folders().unwrap().remove(0);
    v.restore_folder(&deleted.id).unwrap();
    assert!(fs::symlink_metadata(v.root.join("Work/link"))
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(
        fs::read(outside.path().join("keep.txt")).unwrap(),
        b"outside"
    );
}

#[tokio::test]
async fn notebook_deletion_and_restore_sync_pages_and_attachments() {
    let (_a, mut a) = vault();
    let (_b, mut b) = vault();
    let remote = MemoryRemote::default();
    let (config, key, _) = encryption();
    let note = a.create_note("Work/Page.md").unwrap();
    fs::write(a.root.join("Work/image.png"), b"attachment").unwrap();
    for v in [&mut a, &mut b] {
        sync::synchronize(v, &remote, &config, &key).await.unwrap();
    }
    a.delete_folder("Work").unwrap();
    for v in [&mut a, &mut b] {
        sync::synchronize(v, &remote, &config, &key).await.unwrap();
    }
    assert!(b.notes().unwrap().is_empty());
    assert!(!b.root.join("Work/image.png").exists());
    assert!(b.deleted_folders().unwrap().is_empty());
    let deleted = a.deleted_folders().unwrap().remove(0);
    a.restore_folder(&deleted.id).unwrap();
    for v in [&mut a, &mut b] {
        sync::synchronize(v, &remote, &config, &key).await.unwrap();
    }
    assert_eq!(b.note(&note.id).unwrap().content, note.content);
    assert_eq!(
        fs::read(b.root.join("Work/image.png")).unwrap(),
        b"attachment"
    );
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

#[tokio::test]
async fn attachment_heavy_notebook_sync_lists_each_drive_folder_once_and_reports_progress() {
    let (dir, mut source) = vault();
    let (_restored_dir, mut restored) = vault();
    let remote = MemoryRemote::default();
    let (config, key, _) = encryption();
    fs::create_dir_all(dir.path().join("Imported/assets")).unwrap();
    for index in 0..100 {
        fs::write(
            dir.path().join(format!("Imported/Page {index}.md")),
            format!("# Page {index}\n![photo](assets/photo-{index}.png)"),
        )
        .unwrap();
        fs::write(
            dir.path()
                .join(format!("Imported/assets/photo-{index}.png")),
            [137, 80, 78, 71, index as u8],
        )
        .unwrap();
    }
    let events = Mutex::new(Vec::new());
    let report = |progress| events.lock().unwrap().push(progress);
    let status = sync::synchronize_with_progress(&mut source, &remote, &config, &key, &report)
        .await
        .unwrap();
    assert_eq!(status.pending, 0);
    let first_lists = remote.list_calls.load(std::sync::atomic::Ordering::SeqCst);
    assert!(
        first_lists <= 7,
        "folder listings must scale with folders, not files: {first_lists}"
    );
    let events = events.into_inner().unwrap();
    assert!(events
        .iter()
        .any(|p| p.stage == "Uploading attachments" && p.completed == 100 && p.total == 100));
    assert!(events
        .iter()
        .any(|p| p.stage == "Uploading note history" && p.completed == 200 && p.total == 200));
    // Metadata checks must not appear as transfers, rewrite local attachments,
    // or download this device's own freshly uploaded history.
    let attachment = dir.path().join("Imported/assets/photo-0.png");
    let preserved_time = std::time::UNIX_EPOCH + std::time::Duration::from_secs(123456);
    fs::OpenOptions::new()
        .write(true)
        .open(&attachment)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(preserved_time))
        .unwrap();
    let idle_events = Mutex::new(Vec::new());
    remote.uploads.lock().unwrap().clear();
    remote.downloads.lock().unwrap().clear();
    sync::synchronize_with_progress(&mut source, &remote, &config, &key, &|p| {
        idle_events.lock().unwrap().push(p)
    })
    .await
    .unwrap();
    assert!(remote.uploads.lock().unwrap().is_empty());
    assert!(remote.downloads.lock().unwrap().is_empty());
    assert_eq!(
        fs::metadata(&attachment).unwrap().modified().unwrap(),
        preserved_time
    );
    assert!(!idle_events
        .lock()
        .unwrap()
        .iter()
        .any(|p| p.stage.starts_with("Downloading")
            || p.stage.starts_with("Uploading")
            || p.stage == "Updating Drive notebook"));
    let second_lists = remote.list_calls.load(std::sync::atomic::Ordering::SeqCst) - first_lists;
    assert!(
        second_lists <= 7,
        "unchanged sync must not relist a folder per note: {second_lists}"
    );
    let note = source.notes().unwrap().remove(0);
    source
        .save_note(
            &note.id,
            &(note.content.clone() + "\nOne changed page."),
            &note.hash,
        )
        .unwrap();
    let edit_events = Mutex::new(Vec::new());
    sync::synchronize_with_progress(&mut source, &remote, &config, &key, &|p| {
        edit_events.lock().unwrap().push(p)
    })
    .await
    .unwrap();
    let uploads = remote.uploads.lock().unwrap().clone();
    assert_eq!(
        uploads.len(),
        2,
        "one history object and one readable mirror, not the whole notebook"
    );
    {
        let files = remote.files.lock().unwrap();
        let roles: std::collections::HashSet<_> = uploads
            .iter()
            .map(|id| {
                let props = &files[id].0.app_properties;
                assert_eq!(props.get("newNotesItem"), Some(&note.id));
                props["newNotesRole"].as_str()
            })
            .collect();
        assert_eq!(
            roles,
            std::collections::HashSet::from(["revision", "projection"])
        );
    }
    assert!(remote.downloads.lock().unwrap().is_empty());
    assert!(edit_events
        .lock()
        .unwrap()
        .iter()
        .any(|p| p.stage == "Updating Drive notebook" && p.total == 1 && p.completed == 1));
    assert!(!edit_events
        .lock()
        .unwrap()
        .iter()
        .any(|p| p.stage == "Uploading attachments" || p.stage.starts_with("Downloading")));
    assert_eq!(
        fs::metadata(&attachment).unwrap().modified().unwrap(),
        preserved_time
    );
    remote.uploads.lock().unwrap().clear();
    sync::synchronize(&mut source, &remote, &config, &key)
        .await
        .unwrap();
    assert!(remote.uploads.lock().unwrap().is_empty());
    assert!(remote.downloads.lock().unwrap().is_empty());
    sync::synchronize(&mut restored, &remote, &config, &key)
        .await
        .unwrap();
    assert_eq!(restored.notes().unwrap().len(), 100);
    let changed = restored.note(&note.id).unwrap();
    assert!(changed.content.contains("One changed page."));
    for index in 0..100 {
        assert_eq!(
            fs::read(
                restored
                    .root
                    .join(format!("Imported/assets/photo-{index}.png"))
            )
            .unwrap(),
            vec![137, 80, 78, 71, index as u8]
        );
    }
    // Other devices' edits must still be received by periodic checks.
    restored
        .save_note(
            &changed.id,
            &(changed.content.clone() + "\nFrom another device."),
            &changed.hash,
        )
        .unwrap();
    sync::synchronize(&mut restored, &remote, &config, &key)
        .await
        .unwrap();
    remote.uploads.lock().unwrap().clear();
    remote.downloads.lock().unwrap().clear();
    let remote_events = Mutex::new(Vec::new());
    sync::synchronize_with_progress(&mut source, &remote, &config, &key, &|p| {
        remote_events.lock().unwrap().push(p)
    })
    .await
    .unwrap();
    assert!(source
        .note(&note.id)
        .unwrap()
        .content
        .contains("From another device."));
    assert_eq!(remote.downloads.lock().unwrap().len(), 1);
    assert!(remote.uploads.lock().unwrap().is_empty());
    assert!(remote_events
        .lock()
        .unwrap()
        .iter()
        .any(|p| p.stage == "Downloading note history" && p.total == 1 && p.completed == 1));
}

#[tokio::test]
async fn missing_upload_version_requires_authenticated_read_before_caching() {
    let (dir, mut source) = vault();
    let remote = MemoryRemote::default();
    let (config, key, _) = encryption();
    source.create_note("Page.md").unwrap();
    fs::write(dir.path().join("photo.png"), b"attachment").unwrap();
    remote
        .omit_upload_versions
        .store(true, std::sync::atomic::Ordering::SeqCst);
    sync::synchronize(&mut source, &remote, &config, &key)
        .await
        .unwrap();
    assert!(remote.downloads.lock().unwrap().is_empty());
    sync::synchronize(&mut source, &remote, &config, &key)
        .await
        .unwrap();
    assert_eq!(
        remote.downloads.lock().unwrap().len(),
        3,
        "one blob and two history objects must be verified without a completion version"
    );
    remote.downloads.lock().unwrap().clear();
    remote.uploads.lock().unwrap().clear();
    sync::synchronize(&mut source, &remote, &config, &key)
        .await
        .unwrap();
    assert!(remote.downloads.lock().unwrap().is_empty());
    assert!(remote.uploads.lock().unwrap().is_empty());
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

#[test]
fn local_image_reader_decodes_imported_links_and_supplies_raster_mime_types() {
    use notes_core::images;
    let (dir, mut v) = vault();
    let note = v.create_note("Ideas/Note.md").unwrap();
    let source = tempfile::Builder::new()
        .prefix("screen shot café #100% (copy) ")
        .suffix(".PNG")
        .tempfile()
        .unwrap();
    fs::write(source.path(), b"\x89PNG\r\n\x1a\n").unwrap();
    let imported = v.import_attachment(source.path()).unwrap();
    let target = links::relative_path(&note.path, &imported);
    let encoded = target
        .replace('%', "%25")
        .replace(' ', "%20")
        .replace('#', "%23")
        .replace('(', "%28")
        .replace(')', "%29");
    let image = images::read(dir.path(), &note.path, &encoded).unwrap();
    assert_eq!(image.bytes, fs::read(source.path()).unwrap());
    assert_eq!(image.mime_type, "image/png");
    for (ext, mime) in [
        ("jpg", "image/jpeg"),
        ("jpeg", "image/jpeg"),
        ("gif", "image/gif"),
        ("webp", "image/webp"),
        ("avif", "image/avif"),
    ] {
        fs::write(dir.path().join(format!("photo.{ext}")), b"test bytes").unwrap();
        assert_eq!(
            images::read(dir.path(), &note.path, &format!("../photo.{ext}"))
                .unwrap()
                .mime_type,
            mime
        );
    }
}

#[test]
fn local_image_reader_keeps_paths_and_sizes_bounded() {
    use notes_core::images;
    let (dir, _) = vault();
    for target in [
        "../outside.png",
        "%2e%2e/outside.png",
        "/outside.png",
        "//example.com/image.png",
        "https://example.com/image.png",
        "file:///tmp/outside.png",
        ".notes/image.png",
        "picture.svg",
        "data:image/png;base64,aaa",
    ] {
        assert!(
            images::read(dir.path(), "Note.md", target).is_err(),
            "{target}"
        );
    }
    fs::create_dir(dir.path().join("directory.png")).unwrap();
    assert!(images::read(dir.path(), "Note.md", "directory.png").is_err());
    let big = fs::File::create(dir.path().join("big.png")).unwrap();
    big.set_len(images::MAX_INLINE_IMAGE + 1).unwrap();
    assert!(images::read(dir.path(), "Note.md", "big.png").is_err());
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink("big.png", dir.path().join("link.png")).unwrap();
        assert!(images::read(dir.path(), "Note.md", "link.png").is_err());
    }
}

#[test]
fn pasted_images_are_local_indexed_attachments_and_do_not_trust_filenames() {
    let (_dir, mut vault) = vault();
    let note = vault.create_note("Folder/Note.md").unwrap();
    let root = vault.root.to_str().unwrap().to_owned();
    let png = b"\x89PNG\r\n\x1a\nclipboard raster";
    let path = vault
        .import_clipboard_image(&root, &note.id, "image/png", png)
        .unwrap();
    assert!(path.starts_with("attachments/"));
    assert!(path.ends_with("-pasted-image.png"));
    assert_eq!(fs::read(vault.root.join(&path)).unwrap(), png);
    assert!(vault
        .revisions(None)
        .unwrap()
        .iter()
        .any(|r| r.path == path && r.kind == ItemKind::Attachment));
    let other = vault
        .import_clipboard_image(&root, &note.id, "image/png", png)
        .unwrap();
    assert_ne!(path, other);
}

#[test]
fn pasted_images_reject_stale_notebooks_deleted_notes_spoofed_types_and_oversize() {
    let (_dir, mut vault) = vault();
    let note = vault.create_note("Note.md").unwrap();
    let root = vault.root.to_str().unwrap().to_owned();
    let png = b"\x89PNG\r\n\x1a\nclipboard raster";
    assert!(vault
        .import_clipboard_image("/different/notebook", &note.id, "image/png", png)
        .is_err());
    assert!(vault
        .import_clipboard_image(&root, "missing-note", "image/png", png)
        .is_err());
    assert!(vault
        .import_clipboard_image(&root, &note.id, "image/svg+xml", b"<svg/>")
        .is_err());
    assert!(vault
        .import_clipboard_image(&root, &note.id, "image/png", b"<html/>")
        .is_err());
    assert!(vault
        .import_clipboard_image(&root, &note.id, "image/jpeg", png)
        .is_err());
    assert!(vault
        .import_clipboard_image(&root, &note.id, "image/png", b"")
        .is_err());
    assert!(vault
        .import_clipboard_image(&root, &note.id, "image/png", &vec![0; 10 * 1024 * 1024 + 1])
        .is_err());
    assert!(!vault.root.join("attachments").exists());
    fs::remove_file(vault.root.join("Note.md")).unwrap();
    assert!(vault
        .import_clipboard_image(&root, &note.id, "image/png", png)
        .is_err());
}

#[cfg(unix)]
#[test]
fn pasted_images_cannot_write_through_an_attachments_symlink() {
    use std::os::unix::fs::symlink;
    let (_dir, mut vault) = vault();
    let note = vault.create_note("Note.md").unwrap();
    let outside = TempDir::new().unwrap();
    symlink(outside.path(), vault.root.join("attachments")).unwrap();
    let root = vault.root.to_str().unwrap().to_owned();
    assert!(vault
        .import_clipboard_image(&root, &note.id, "image/png", b"\x89PNG\r\n\x1a\n")
        .is_err());
    assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
}
