use crate::{
    crypto::{self, VaultConfig, VaultKey},
    drive::{Remote, RemoteFile},
    error::fail,
    model::{ItemKind, Revision, SyncProgress, SyncStatus},
    paths,
    vault::{now, Vault},
    Result,
};
use rusqlite::{params, OptionalExtension};
use std::{
    collections::{HashMap, HashSet},
    fs,
};
use uuid::Uuid;

fn properties(role: &str, vault: &str) -> HashMap<String, String> {
    HashMap::from([
        ("newNotesRole".into(), role.into()),
        ("newNotesVault".into(), vault.into()),
    ])
}
fn property(file: &RemoteFile, key: &str) -> String {
    file.app_properties.get(key).cloned().unwrap_or_default()
}

pub async fn discover(remote: &impl Remote) -> Result<Vec<RemoteFile>> {
    remote.list(None).await
}

pub async fn remote_config(vault: &Vault, remote: &impl Remote, root: &str) -> Result<VaultConfig> {
    let files = remote.list(Some(root)).await?;
    let configs: Vec<_> = files
        .iter()
        .filter(|f| property(f, "newNotesRole") == "config")
        .collect();
    if configs.len() != 1 {
        return Err(fail(
            "The remote vault has no unique encryption configuration",
        ));
    }
    let file = vault.internal("transfer/config.download")?;
    remote.download(&configs[0].id, &file, 65536).await?;
    let config: VaultConfig = serde_json::from_slice(&fs::read(&file)?)?;
    fs::remove_file(file)?;
    Ok(config)
}

async fn ensured_folder(
    vault: &Vault,
    remote: &impl Remote,
    parent: Option<&str>,
    name: &str,
    role: &str,
    config: &VaultConfig,
) -> Result<String> {
    let state_key = format!("folder:{role}");
    let files = remote.list(parent).await?;
    if let Some(id) = vault.get_state(&state_key)? {
        if files.iter().any(|f| f.id == id) {
            return Ok(id);
        }
        if vault.get_state(&format!("ready:{role}"))?.is_some() {
            return Err(fail("An app-managed Drive folder is missing. Sync paused; local files are preserved. Restore it from Drive Trash, then retry."));
        }
        remote
            .create_folder(&id, parent, name, &properties(role, &config.vault_id))
            .await?;
        vault.set_state(&format!("ready:{role}"), "1")?;
        return Ok(id);
    }
    let matches: Vec<_> = files
        .iter()
        .filter(|f| {
            property(f, "newNotesRole") == role && property(f, "newNotesVault") == config.vault_id
        })
        .collect();
    if matches.len() > 1 {
        return Err(fail(
            "Multiple app-managed Drive folders share this vault identity",
        ));
    }
    let id = if let Some(file) = matches.first() {
        file.id.clone()
    } else {
        remote.allocate_id().await?
    };
    vault.set_state(&state_key, &id)?;
    if matches.is_empty() {
        remote
            .create_folder(&id, parent, name, &properties(role, &config.vault_id))
            .await?;
    }
    vault.set_state(&format!("ready:{role}"), "1")?;
    Ok(id)
}

async fn allocated(vault: &Vault, remote: &impl Remote, key: &str) -> Result<String> {
    if let Some(id) = vault.get_state(key)? {
        return Ok(id);
    }
    let id = remote.allocate_id().await?;
    vault.set_state(key, &id)?;
    Ok(id)
}

pub async fn synchronize(
    vault: &mut Vault,
    remote: &impl Remote,
    config: &VaultConfig,
    key: &VaultKey,
) -> Result<SyncStatus> {
    synchronize_with_progress(vault, remote, config, key, &|_| {}).await
}

pub async fn synchronize_with_progress(
    vault: &mut Vault,
    remote: &impl Remote,
    config: &VaultConfig,
    key: &VaultKey,
    report: &(impl Fn(SyncProgress) + Sync),
) -> Result<SyncStatus> {
    vault.set_state("sync_state", "syncing")?;
    vault.set_state("sync_error", "")?;
    let cached = crate::sync_transport::ListingCache::new(remote);
    let outcome = sync_inner(vault, &cached, config, key, report).await;
    match outcome {
        Ok(()) => {
            vault.set_state("last_sync", &now().to_string())?;
            vault.set_state(
                "sync_state",
                if !vault.conflicts()?.is_empty() {
                    "conflict"
                } else if vault.info()?.status.pending > 0 {
                    "pending"
                } else {
                    "synced"
                },
            )?;
            Ok(vault.info()?.status)
        }
        Err(error) => {
            vault.set_state("sync_state", "error")?;
            vault.set_state("sync_error", &error.to_string())?;
            Err(error)
        }
    }
}

async fn sync_inner(
    vault: &mut Vault,
    remote: &impl Remote,
    config: &VaultConfig,
    key: &VaultKey,
    report: &(impl Fn(SyncProgress) + Sync),
) -> Result<()> {
    report(progress("Scanning local notes", 0, 0));
    vault.scan()?;
    report(progress("Checking Google Drive folders", 0, 0));
    let cursor = match vault.get_state("changes_cursor")? {
        Some(cursor) => cursor,
        None => remote.start_cursor().await?,
    };
    let name = format!("Wattle Notes - {}", vault.info()?.name);
    let root = ensured_folder(vault, remote, None, &name, "vault", config).await?;
    let internal = ensured_folder(vault, remote, Some(&root), ".sync", "sync", config).await?;
    let objects = ensured_folder(
        vault,
        remote,
        Some(&internal),
        "objects",
        "revisions",
        config,
    )
    .await?;
    let blobs = ensured_folder(vault, remote, Some(&internal), "blobs", "blobs", config).await?;
    let config_id = allocated(vault, remote, "config_drive_id").await?;
    if vault.get_state("config_uploaded")?.is_none() {
        let remote_files = remote.list(Some(&root)).await?;
        if let Some(existing) = remote_files
            .iter()
            .find(|f| property(f, "newNotesRole") == "config")
        {
            let found = remote_config(vault, remote, &root).await?;
            if serde_json::to_string(&found)? != serde_json::to_string(config)? {
                return Err(fail(
                    "Remote vault key configuration does not match this device",
                ));
            }
            vault.set_state("config_drive_id", &existing.id)?;
        } else {
            let temp = vault.internal("transfer/vault.json")?;
            paths::atomic_write(&temp, &serde_json::to_vec(config)?)?;
            remote
                .upload(
                    &config_id,
                    &root,
                    "vault.json",
                    &temp,
                    &properties("config", &config.vault_id),
                    false,
                )
                .await?;
            fs::remove_file(temp)?;
        }
        vault.set_state("config_uploaded", "1")?;
    }
    let remote_blobs = remote.list(Some(&blobs)).await?;
    let remote_revisions = remote.list(Some(&objects)).await?;
    verify_remote_history(vault, &remote_revisions, &remote_blobs)?;
    report(progress("Downloading attachments", 0, remote_blobs.len()));
    for (index, file) in remote_blobs.iter().enumerate() {
        report(progress(
            "Downloading attachments",
            index,
            remote_blobs.len(),
        ));
        if property(file, "newNotesRole") != "blob"
            || property(file, "newNotesVault") != config.vault_id
        {
            continue;
        }
        let blob_id = property(file, "newNotesBlob");
        Uuid::parse_str(&blob_id).map_err(|_| fail("Invalid encrypted attachment identity"))?;
        let known: bool = vault.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM blobs WHERE id=?)",
            [&blob_id],
            |r| r.get(0),
        )?;
        let cache_key = format!("remote_version:{}", file.id);
        let unchanged = known
            && vault.internal(&format!("blobs/{blob_id}"))?.exists()
            && file.version.as_ref().is_some_and(|version| {
                vault.get_state(&cache_key).ok().flatten().as_ref() == Some(version)
            });
        if !unchanged {
            let temp = vault.internal(&format!("transfer/{blob_id}.enc"))?;
            remote
                .download(&file.id, &temp, paths::MAX_ATTACHMENT + 128 * 1024)
                .await?;
            let destination = vault.internal(&format!("blobs/{blob_id}"))?;
            fs::create_dir_all(
                destination
                    .parent()
                    .ok_or_else(|| fail("Missing blob parent"))?,
            )?;
            let output = destination.with_extension("partial");
            let outcome = crypto::unseal_stream(
                key,
                &crypto::identity(&config.vault_id, &blob_id, &blob_id, "attachment"),
                fs::File::open(&temp)?,
                fs::File::create(&output)?,
            );
            if let Err(error) = outcome {
                let _ = fs::remove_file(output);
                return Err(error);
            }
            if destination.exists() {
                if crate::vault::hash_file(&destination)? != crate::vault::hash_file(&output)? {
                    let _ = fs::remove_file(output);
                    return Err(fail(
                        "An immutable attachment changed on Drive; the local copy was preserved",
                    ));
                }
                fs::remove_file(output)?;
            } else {
                fs::rename(output, &destination)?;
            }
            fs::remove_file(temp)?;
            vault.db.execute(
                "INSERT OR IGNORE INTO blobs(id,local_path) VALUES(?,?)",
                params![blob_id, format!("blobs/{blob_id}")],
            )?;
        }
        if let Some(version) = &file.version {
            vault.set_state(&cache_key, version)?;
        }
        vault.db.execute(
            "UPDATE blobs SET uploaded=1,drive_id=? WHERE id=?",
            params![file.id, blob_id],
        )?;
    }
    report(progress(
        "Downloading note history",
        0,
        remote_revisions.len(),
    ));
    for (index, file) in remote_revisions.iter().enumerate() {
        report(progress(
            "Downloading note history",
            index,
            remote_revisions.len(),
        ));
        if property(file, "newNotesRole") != "revision"
            || property(file, "newNotesVault") != config.vault_id
        {
            continue;
        }
        let id = property(file, "newNotesRevision");
        let item = property(file, "newNotesItem");
        Uuid::parse_str(&id).map_err(|_| fail("Invalid remote revision identity"))?;
        Uuid::parse_str(&item).map_err(|_| fail("Invalid remote item identity"))?;
        let known: bool = vault.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM revisions WHERE id=?)",
            [&id],
            |r| r.get(0),
        )?;
        let cache_key = format!("remote_version:{}", file.id);
        let unchanged = known
            && file.version.as_ref().is_some_and(|version| {
                vault.get_state(&cache_key).ok().flatten().as_ref() == Some(version)
            });
        if !unchanged {
            let temp = vault.internal(&format!("transfer/{id}.enc"))?;
            remote.download(&file.id, &temp, 32 * 1024 * 1024).await?;
            let bytes = crypto::unseal(
                key,
                &crypto::identity(&config.vault_id, &item, &id, "revision"),
                &fs::read(&temp)?,
            )?;
            let revision: Revision = serde_json::from_slice(&bytes)?;
            if revision.id != id || revision.item_id != item {
                return Err(fail("Remote revision identity mismatch"));
            }
            vault.insert_revision(&revision, true)?;
            fs::remove_file(temp)?;
        }
        if let Some(version) = &file.version {
            vault.set_state(&cache_key, version)?;
        }
        vault.db.execute(
            "UPDATE revisions SET uploaded=1,drive_id=? WHERE id=?",
            params![file.id, id],
        )?;
    }
    report(progress("Merging note history", 0, 0));
    validate_graph(vault)?;
    reconcile(vault)?;
    // All blob dependencies reach Drive before their referencing revision.
    let pending_blobs: Vec<(String, String)> = {
        let mut statement = vault
            .db
            .prepare("SELECT id,local_path FROM blobs WHERE uploaded=0 ORDER BY id")?;
        let rows = statement.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<std::result::Result<_, _>>()?
    };
    let blob_total = pending_blobs.len();
    report(progress("Uploading attachments", 0, blob_total));
    for (index, (id, local)) in pending_blobs.into_iter().enumerate() {
        report(progress("Uploading attachments", index, blob_total));
        let remote_id = allocated(vault, remote, &format!("upload_blob:{id}")).await?;
        let temp = vault.internal(&format!("transfer/{id}.enc"))?;
        fs::create_dir_all(
            temp.parent()
                .ok_or_else(|| fail("Missing transfer directory"))?,
        )?;
        crypto::seal_stream(
            key,
            &crypto::identity(&config.vault_id, &id, &id, "attachment"),
            fs::File::open(vault.internal(&local)?)?,
            fs::File::create(&temp)?,
        )?;
        let mut props = properties("blob", &config.vault_id);
        props.insert("newNotesBlob".into(), id.clone());
        remote
            .upload(
                &remote_id,
                &blobs,
                &format!("{id}.enc"),
                &temp,
                &props,
                false,
            )
            .await?;
        fs::remove_file(temp)?;
        vault.db.execute(
            "UPDATE blobs SET uploaded=1,drive_id=? WHERE id=?",
            params![remote_id, id],
        )?;
        report(progress("Uploading attachments", index + 1, blob_total));
    }
    // Topological order permits a new device to verify the complete history after any interruption.
    let all = vault.revisions(None)?;
    let ordered = topological(&all)?;
    let revision_total: usize =
        vault
            .db
            .query_row("SELECT count(*) FROM revisions WHERE uploaded=0", [], |r| {
                r.get(0)
            })?;
    let mut uploaded_count = 0;
    report(progress("Uploading note history", 0, revision_total));
    for revision in ordered {
        let uploaded: bool = vault.db.query_row(
            "SELECT uploaded FROM revisions WHERE id=?",
            [&revision.id],
            |r| r.get(0),
        )?;
        if uploaded {
            continue;
        }
        // Local editing can add revisions/attachments while a network request is
        // in flight. Leave these queued if their dependencies missed this pass.
        let mut ready = true;
        for blob in revision.dependencies.iter().chain(revision.blob_id.iter()) {
            ready &= vault
                .db
                .query_row("SELECT uploaded FROM blobs WHERE id=?", [blob], |r| {
                    r.get::<_, bool>(0)
                })?;
        }
        for parent in &revision.parents {
            ready &=
                vault
                    .db
                    .query_row("SELECT uploaded FROM revisions WHERE id=?", [parent], |r| {
                        r.get::<_, bool>(0)
                    })?;
        }
        if !ready {
            continue;
        }
        let remote_id =
            allocated(vault, remote, &format!("upload_revision:{}", revision.id)).await?;
        let temp = vault.internal(&format!("transfer/{}.enc", revision.id))?;
        let bytes = crypto::seal(
            key,
            &crypto::identity(
                &config.vault_id,
                &revision.item_id,
                &revision.id,
                "revision",
            ),
            &serde_json::to_vec(&revision)?,
        )?;
        paths::atomic_write(&temp, &bytes)?;
        let mut props = properties("revision", &config.vault_id);
        props.insert("newNotesRevision".into(), revision.id.clone());
        props.insert("newNotesItem".into(), revision.item_id.clone());
        remote
            .upload(
                &remote_id,
                &objects,
                &format!("{}.enc", revision.id),
                &temp,
                &props,
                false,
            )
            .await?;
        fs::remove_file(temp)?;
        vault.db.execute(
            "UPDATE revisions SET uploaded=1,drive_id=? WHERE id=?",
            params![remote_id, revision.id],
        )?;
        uploaded_count += 1;
        report(progress(
            "Uploading note history",
            uploaded_count,
            revision_total,
        ));
    }
    refresh_projection(vault, remote, config, key, &root, report).await?;
    report(progress("Finishing sync", 0, 0));
    // Full scan is the recovery baseline; cursor consumption detects removals and records the next incremental starting point.
    let (next, removed) = remote.changes(&cursor).await?;
    let immutable: HashSet<String> = remote_revisions
        .iter()
        .chain(&remote_blobs)
        .map(|f| f.id.clone())
        .collect();
    if removed.iter().any(|id| immutable.contains(id)) {
        return Err(fail("Encrypted history was removed during sync. Local notes are preserved; restore missing Drive files."));
    }
    vault.set_state("changes_cursor", &next)?;
    Ok(())
}

fn progress(stage: &str, completed: usize, total: usize) -> SyncProgress {
    SyncProgress {
        stage: stage.into(),
        completed,
        total,
    }
}

fn verify_remote_history(
    vault: &Vault,
    revisions: &[RemoteFile],
    blobs: &[RemoteFile],
) -> Result<()> {
    let ids: HashSet<&str> = revisions
        .iter()
        .chain(blobs)
        .map(|f| f.id.as_str())
        .collect();
    for table in ["revisions", "blobs"] {
        let mut stmt = vault.db.prepare(&format!(
            "SELECT drive_id FROM {table} WHERE uploaded=1 AND drive_id IS NOT NULL"
        ))?;
        for id in stmt.query_map([], |r| r.get::<_, String>(0))? {
            if !ids.contains(id?.as_str()) {
                return Err(fail("An encrypted history file is missing from Drive. Local files are preserved. Restore it from Drive Trash."));
            }
        }
    }
    Ok(())
}

pub fn topological(revisions: &[Revision]) -> Result<Vec<Revision>> {
    use std::collections::BTreeSet;
    let by_id: HashMap<&str, &Revision> = revisions.iter().map(|r| (r.id.as_str(), r)).collect();
    if by_id.len() != revisions.len() {
        return Err(fail("Duplicate revision identities"));
    }
    let mut degree: HashMap<&str, usize> = HashMap::new();
    let mut children: HashMap<&str, Vec<&str>> = HashMap::new();
    let mut ready = BTreeSet::new();
    for revision in revisions {
        let unique: HashSet<&str> = revision.parents.iter().map(String::as_str).collect();
        if unique.len() != revision.parents.len() {
            return Err(fail("Duplicate revision parents"));
        }
        for parent in &revision.parents {
            if by_id
                .get(parent.as_str())
                .is_none_or(|r| r.item_id != revision.item_id)
            {
                return Err(fail(
                    "A revision has a missing parent or references another item",
                ));
            }
            children.entry(parent).or_default().push(&revision.id);
        }
        degree.insert(&revision.id, revision.parents.len());
        if revision.parents.is_empty() {
            ready.insert(revision.id.as_str());
        }
    }
    let mut ordered = Vec::new();
    while let Some(id) = ready.pop_first() {
        ordered.push((*by_id[id]).clone());
        if let Some(descendants) = children.get(id) {
            for child in descendants {
                let count = degree
                    .get_mut(child)
                    .ok_or_else(|| fail("Invalid revision graph"))?;
                *count -= 1;
                if *count == 0 {
                    ready.insert(child);
                }
            }
        }
    }
    if ordered.len() != revisions.len() {
        return Err(fail("Revision history contains a cycle"));
    }
    Ok(ordered)
}

fn validate_graph(vault: &Vault) -> Result<()> {
    for revision in topological(&vault.revisions(None)?)? {
        for blob in revision.dependencies.iter().chain(revision.blob_id.iter()) {
            let exists: bool = vault.db.query_row(
                "SELECT EXISTS(SELECT 1 FROM blobs WHERE id=?)",
                [blob],
                |r| r.get(0),
            )?;
            if !exists || !vault.internal(&format!("blobs/{blob}"))?.exists() {
                return Err(fail("A revision is missing an attachment dependency; sync is paused without changing local files"));
            }
        }
    }
    Ok(())
}

fn ancestors(start: &str, all: &[Revision]) -> HashSet<String> {
    let mut result = HashSet::new();
    let mut queue = vec![start.to_string()];
    while let Some(id) = queue.pop() {
        if result.insert(id.clone()) {
            if let Some(revision) = all.iter().find(|r| r.id == id) {
                queue.extend(revision.parents.clone());
            }
        }
    }
    result
}
pub fn merge_heads(heads: &[Revision], all: &[Revision]) -> Result<Revision> {
    if heads.is_empty() {
        return Err(fail("No revisions to merge"));
    }
    let mut heads = heads.to_vec();
    heads.sort_by(|a, b| a.id.cmp(&b.id));
    let mut merged = heads[0].clone();
    let mut parents: Vec<String> = heads.iter().map(|r| r.id.clone()).collect();
    parents.sort();
    if heads.iter().all(|r| {
        r.path == merged.path
            && r.deleted == merged.deleted
            && r.content == merged.content
            && r.blob_id == merged.blob_id
    }) {
        merged.id = Uuid::new_v5(
            &Uuid::NAMESPACE_OID,
            format!("{}:{}", merged.item_id, parents.join(",")).as_bytes(),
        )
        .to_string();
        merged.parents = parents;
        return Ok(merged);
    }
    if merged.kind != ItemKind::Note
        || heads
            .iter()
            .any(|r| r.kind != ItemKind::Note || r.deleted || r.path != merged.path)
    {
        return Err(fail(
            "Conflicting paths, deletions, or binary attachment edits need review",
        ));
    }
    let mut common = ancestors(&heads[0].id, all);
    for head in heads.iter().skip(1) {
        let other = ancestors(&head.id, all);
        common.retain(|id| other.contains(id));
    }
    let lowest: Vec<_> = all
        .iter()
        .filter(|r| {
            common.contains(&r.id)
                && !all
                    .iter()
                    .any(|child| common.contains(&child.id) && child.parents.contains(&r.id))
        })
        .collect();
    if lowest.len() != 1 {
        return Err(fail("There is no unique shared ancestor for these edits"));
    }
    let base = lowest[0]
        .content
        .as_deref()
        .ok_or_else(|| fail("The shared ancestor has no Markdown content"))?;
    let mut content = merged
        .content
        .clone()
        .ok_or_else(|| fail("Missing merge content"))?;
    for head in heads.iter().skip(1) {
        content = diffy::merge(
            base,
            &content,
            head.content
                .as_deref()
                .ok_or_else(|| fail("Missing merge content"))?,
        )
        .map_err(|_| fail("Overlapping Markdown edits need review"))?;
        merged.dependencies.extend(head.dependencies.clone());
    }
    merged.dependencies.sort();
    merged.dependencies.dedup();
    merged.id = Uuid::new_v5(
        &Uuid::NAMESPACE_OID,
        format!("{}:{}", merged.item_id, parents.join(",")).as_bytes(),
    )
    .to_string();
    merged.created_at = heads.iter().map(|r| r.created_at).max().unwrap_or(0);
    merged.parents = parents;
    merged.content = Some(content);
    Ok(merged)
}

pub fn reconcile(vault: &mut Vault) -> Result<()> {
    let all = vault.revisions(None)?;
    let items: HashSet<String> = all.iter().map(|r| r.item_id.clone()).collect();
    // Attachments must exist before notes that link to them.
    let mut items: Vec<String> = items.into_iter().collect();
    items.sort_by_key(|id| {
        if all
            .iter()
            .any(|r| r.item_id == *id && r.kind == ItemKind::Attachment)
        {
            0
        } else {
            1
        }
    });
    for item in items {
        let heads = vault.heads(&item)?;
        let chosen = if heads.len() == 1 {
            heads[0].clone()
        } else {
            match merge_heads(&heads, &all) {
                Ok(merged) => {
                    vault.insert_revision(&merged, false)?;
                    merged
                }
                Err(error) => {
                    if vault.note(&item).is_err() {
                        if let Some(visible) = heads
                            .iter()
                            .filter(|r| !r.deleted && r.kind == ItemKind::Note)
                            .min_by(|a, b| a.id.cmp(&b.id))
                        {
                            // A new device still gets a readable note while every competing head remains available for resolution.
                            let _ = vault.apply_revision(visible);
                        }
                    }
                    vault.mark_conflict(&item, &error.to_string())?;
                    continue;
                }
            }
        };
        if let Err(error) = vault.apply_revision(&chosen) {
            vault.mark_conflict(&item, &error.to_string())?;
        } else {
            vault.clear_conflict(&item)?;
        }
    }
    Ok(())
}

async fn refresh_projection(
    vault: &Vault,
    remote: &impl Remote,
    config: &VaultConfig,
    key: &VaultKey,
    root: &str,
    report: &(impl Fn(SyncProgress) + Sync),
) -> Result<()> {
    let conflicts: HashSet<String> = vault
        .conflicts()?
        .iter()
        .map(|c| c.item_id.clone())
        .collect();
    let all = vault.revisions(None)?;
    let items: HashSet<String> = all.iter().map(|r| r.item_id.clone()).collect();
    let total = items.len();
    report(progress("Updating Drive notebook", 0, total));
    for (index, item) in items.into_iter().enumerate() {
        report(progress("Updating Drive notebook", index, total));
        if conflicts.contains(&item) {
            continue;
        }
        let heads = vault.heads(&item)?;
        if heads.len() != 1 {
            continue;
        }
        let revision = &heads[0];
        let uploaded: bool = vault.db.query_row(
            "SELECT uploaded FROM revisions WHERE id=?",
            [&revision.id],
            |r| r.get(0),
        )?;
        if !uploaded {
            continue;
        }
        let prior: Option<(String, String)> = vault
            .db
            .query_row(
                "SELECT drive_id,path FROM projection WHERE item_id=?",
                [&item],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((id, path)) = &prior {
            if revision.deleted || path != &revision.path {
                remote.trash(id).await?;
                vault
                    .db
                    .execute("DELETE FROM projection WHERE item_id=?", [&item])?;
            }
        }
        if revision.deleted {
            continue;
        }
        let mut parent = root.to_string();
        let segments: Vec<&str> = revision.path.split('/').collect();
        let mut logical = String::new();
        for segment in &segments[..segments.len() - 1] {
            if !logical.is_empty() {
                logical.push('/');
            }
            logical.push_str(segment);
            parent = ensured_folder(
                vault,
                remote,
                Some(&parent),
                segment,
                &format!("tree:{}", crate::vault::hash(logical.as_bytes())),
                config,
            )
            .await?;
        }
        let matching = prior.as_ref().filter(|(_, path)| path == &revision.path);
        let existing = remote.list(Some(&parent)).await?.into_iter().find(|f| {
            property(f, "newNotesRole") == "projection" && property(f, "newNotesItem") == item
        });
        if let Some(file) = &existing {
            if property(file, "newNotesRevision") == revision.id
                && file.name
                    == format!(
                        "{}.enc",
                        segments.last().ok_or_else(|| fail("Missing filename"))?
                    )
            {
                vault.db.execute(
                    "INSERT OR REPLACE INTO projection VALUES(?,?,?)",
                    params![item, file.id, revision.path],
                )?;
                continue;
            }
        }
        let (id, replace) = if let Some(file) = existing {
            (file.id, true)
        } else if let Some((id, _)) = matching {
            (id.clone(), false)
        } else {
            (
                allocated(
                    vault,
                    remote,
                    &format!("projection_id:{item}:{}", revision.path),
                )
                .await?,
                false,
            )
        };
        if matching.is_some() && !replace {
            return Err(fail("A readable Drive mirror file was removed. Restore it from Drive Trash; local notes and encrypted history are preserved."));
        }
        let temp = vault.internal(&format!("transfer/projection-{item}.enc"))?;
        match revision.kind {
            ItemKind::Note => {
                let bytes = crypto::seal(
                    key,
                    &crypto::identity(&config.vault_id, &item, &revision.id, "mirror"),
                    revision
                        .content
                        .as_ref()
                        .ok_or_else(|| fail("Missing note content"))?
                        .as_bytes(),
                )?;
                paths::atomic_write(&temp, &bytes)?;
            }
            ItemKind::Attachment => {
                let blob = revision
                    .blob_id
                    .as_ref()
                    .ok_or_else(|| fail("Missing attachment"))?;
                crypto::seal_stream(
                    key,
                    &crypto::identity(&config.vault_id, &item, &revision.id, "mirror"),
                    fs::File::open(vault.internal(&format!("blobs/{blob}"))?)?,
                    fs::File::create(&temp)?,
                )?;
            }
        }
        let mut props = properties("projection", &config.vault_id);
        props.insert("newNotesItem".into(), item.clone());
        props.insert("newNotesRevision".into(), revision.id.clone());
        remote
            .upload(
                &id,
                &parent,
                &format!(
                    "{}.enc",
                    segments.last().ok_or_else(|| fail("Missing filename"))?
                ),
                &temp,
                &props,
                replace,
            )
            .await?;
        fs::remove_file(temp)?;
        vault.db.execute(
            "INSERT OR REPLACE INTO projection VALUES(?,?,?)",
            params![item, id, revision.path],
        )?;
    }
    report(progress("Updating Drive notebook", total, total));
    Ok(())
}
