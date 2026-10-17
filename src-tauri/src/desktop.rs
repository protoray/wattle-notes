use crate::{
    backup,
    crypto::{self, VaultConfig, VaultKey},
    drive::{DriveClient, RemoteFile},
    error::fail,
    links,
    model::*,
    oauth::{self, OAuthSettings},
    paths, sync,
    vault::{self, Vault},
    webdav, Result,
};
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tauri::{Emitter, Manager, State};
use zeroize::Zeroizing;

#[derive(Default)]
struct Inner {
    vault: Mutex<Option<Vault>>,
    key: Mutex<Option<VaultKey>>,
    operations: Arc<tokio::sync::Mutex<()>>,
    syncing: std::sync::atomic::AtomicBool,
    progress: Mutex<Option<SyncProgress>>,
    can_exit: std::sync::atomic::AtomicBool,
}
#[derive(Clone, Default)]
pub struct AppState(Arc<Inner>);
type Command<T> = std::result::Result<T, String>;
#[tauri::command]
fn finish_exit(app: tauri::AppHandle, state: State<'_, AppState>) {
    state
        .0
        .can_exit
        .store(true, std::sync::atomic::Ordering::SeqCst);
    app.exit(0);
}
#[tauri::command]
fn restart_after_update(app: tauri::AppHandle, state: State<'_, AppState>) {
    // The frontend flushes the current note before installing/restarting.
    state
        .0
        .can_exit
        .store(true, std::sync::atomic::Ordering::SeqCst);
    app.request_restart();
}

async fn local<T: Send + 'static>(
    state: &AppState,
    work: impl FnOnce(&mut Vault) -> Result<T> + Send + 'static,
) -> Command<T> {
    let inner = state.0.clone();
    let operation = inner.operations.clone().lock_owned().await;
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = operation;
        let mut guard = inner.vault.lock().map_err(|_| fail("Vault lock failed"))?;
        work(
            guard
                .as_mut()
                .ok_or_else(|| fail("Open a local vault first"))?,
        )
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}
fn require_idle(inner: &Inner) -> Result<()> {
    if inner.syncing.load(std::sync::atomic::Ordering::SeqCst) {
        return Err(fail("Wait for Google Drive sync to finish before changing the notebook or its connection/encryption settings."));
    }
    Ok(())
}
async fn exclusive_local<T: Send + 'static>(
    state: &AppState,
    work: impl FnOnce(&mut Vault) -> Result<T> + Send + 'static,
) -> Command<T> {
    let inner = state.0.clone();
    local(state, move |v| {
        require_idle(&inner)?;
        work(v)
    })
    .await
}

struct ActiveSync(Arc<Inner>);
impl ActiveSync {
    fn begin(inner: Arc<Inner>) -> Result<Self> {
        inner
            .syncing
            .compare_exchange(
                false,
                true,
                std::sync::atomic::Ordering::SeqCst,
                std::sync::atomic::Ordering::SeqCst,
            )
            .map_err(|_| fail("Google Drive sync is already running"))?;
        Ok(Self(inner))
    }
}
impl Drop for ActiveSync {
    fn drop(&mut self) {
        *self.0.progress.lock().unwrap() = None;
        self.0
            .syncing
            .store(false, std::sync::atomic::Ordering::SeqCst);
    }
}
fn config(vault: &Vault) -> Result<Option<VaultConfig>> {
    let path = vault.internal("vault.json")?;
    if !path.exists() {
        return Ok(None);
    }
    Ok(Some(serde_json::from_slice(&fs::read(path)?)?))
}
fn settings(vault: &Vault) -> Result<OAuthSettings> {
    match vault.get_state("oauth_settings")? {
        Some(json) => Ok(serde_json::from_str(&json)?),
        None => Ok(OAuthSettings {
            client_id: option_env!("GOOGLE_CLIENT_ID").unwrap_or_default().into(),
            client_secret: option_env!("GOOGLE_CLIENT_SECRET").map(String::from),
        }),
    }
}
async fn client(oauth_settings: &OAuthSettings) -> Result<DriveClient> {
    let token = oauth::load_secret("google-refresh-token")?
        .ok_or_else(|| fail("Connect Google Drive in Settings first"))?;
    let tokens = oauth::refresh(oauth_settings, &token).await?;
    if let Some(refresh) = tokens.refresh_token {
        oauth::store_secret("google-refresh-token", &refresh)?;
    }
    DriveClient::new(tokens.access_token)
}

fn switch_vault(
    inner: &Inner,
    root: &Path,
    remember: impl FnOnce(&str) -> Result<()>,
) -> Result<VaultInfo> {
    require_idle(inner)?;
    let mut guard = inner.vault.lock().map_err(|_| fail("Vault lock failed"))?;
    // A missing remembered folder may be on an unmounted disk. Do not silently
    // recreate it as an empty notebook, or release the current notebook on error.
    let root = root.canonicalize()?;
    if let Some(current) = guard.as_mut().filter(|current| current.root == root) {
        current.scan()?;
        let info = current.info()?;
        remember(&info.root)?;
        return Ok(info);
    }
    let vault = Vault::open(&root)?;
    let mut next_key = None;
    if let Some(config) = config(&vault)? {
        if let Ok(Some(raw)) = oauth::load_secret(&format!("vault:{}", config.vault_id)) {
            if let Ok(bytes) = hex::decode(raw.as_str()) {
                if let Ok(key) = <[u8; 32]>::try_from(bytes.as_slice()) {
                    next_key = Some(VaultKey(Zeroizing::new(key)));
                }
            }
        }
    }
    let info = vault.info()?;
    let mut key = inner
        .key
        .lock()
        .map_err(|_| fail("Encryption lock failed"))?;
    // All fallible preparation, including remembering the selection, completes
    // before publishing either the new notebook or its encryption key.
    remember(&info.root)?;
    *guard = Some(vault);
    *key = next_key;
    Ok(info)
}
#[tauri::command]
async fn open_vault(
    state: State<'_, AppState>,
    root: String,
    app: tauri::AppHandle,
) -> Command<VaultInfo> {
    let inner = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = inner.operations.clone().blocking_lock_owned();
        switch_vault(&inner, Path::new(&root), |root| {
            let folder = app
                .path()
                .app_config_dir()
                .map_err(|_| fail("App configuration directory unavailable"))?;
            fs::create_dir_all(&folder)?;
            paths::atomic_write(&folder.join("last-vault.json"), &serde_json::to_vec(root)?)
        })
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}
#[tauri::command]
fn last_vault(app: tauri::AppHandle) -> Command<Option<String>> {
    let path = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("last-vault.json");
    if !path.exists() {
        return Ok(None);
    }
    Ok(serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?).ok())
}
#[tauri::command]
async fn vault_info(state: State<'_, AppState>) -> Command<VaultInfo> {
    local(&state, |v| {
        v.scan()?;
        v.info()
    })
    .await
}
#[tauri::command]
async fn create_note(state: State<'_, AppState>, path: String) -> Command<Note> {
    local(&state, move |v| v.create_note(&path)).await
}
#[tauri::command]
async fn save_note(
    state: State<'_, AppState>,
    id: String,
    content: String,
    expected: String,
) -> Command<Note> {
    local(&state, move |v| v.save_note(&id, &content, &expected)).await
}
#[tauri::command]
async fn set_tags(state: State<'_, AppState>, id: String, tags: Vec<String>) -> Command<Note> {
    local(&state, move |v| {
        let note = v.note(&id)?;
        let (mut meta, body) = crate::vault::frontmatter(&note.content)?;
        meta.insert(
            serde_yaml::Value::String("tags".into()),
            serde_yaml::to_value(tags)?,
        );
        v.save_note(
            &id,
            &format!("---\n{}---\n{}", serde_yaml::to_string(&meta)?, body),
            &note.hash,
        )
    })
    .await
}
#[tauri::command]
async fn rename_note(state: State<'_, AppState>, id: String, path: String) -> Command<Note> {
    local(&state, move |v| v.rename_note(&id, &path)).await
}
#[tauri::command]
async fn delete_note(state: State<'_, AppState>, id: String) -> Command<()> {
    local(&state, move |v| v.delete_note(&id)).await
}
#[tauri::command]
async fn create_folder(state: State<'_, AppState>, path: String) -> Command<()> {
    local(&state, move |v| v.create_folder(&path)).await
}
#[tauri::command]
async fn delete_folder(state: State<'_, AppState>, path: String) -> Command<()> {
    exclusive_local(&state, move |v| v.delete_folder(&path)).await
}
#[tauri::command]
async fn deleted_folders(state: State<'_, AppState>) -> Command<Vec<DeletedFolder>> {
    local(&state, |v| v.deleted_folders()).await
}
#[tauri::command]
async fn restore_folder(state: State<'_, AppState>, id: String) -> Command<()> {
    exclusive_local(&state, move |v| v.restore_folder(&id)).await
}
#[tauri::command]
async fn search_notes(state: State<'_, AppState>, query: String) -> Command<Vec<Note>> {
    local(&state, move |v| v.search(&query)).await
}
#[tauri::command]
async fn import_folder(state: State<'_, AppState>, source: String) -> Command<VaultInfo> {
    local(&state, move |v| {
        v.copy_from(&PathBuf::from(source))?;
        v.info()
    })
    .await
}
#[tauri::command]
async fn export_vault(state: State<'_, AppState>, destination: String) -> Command<()> {
    local(&state, move |v| v.export_to(&PathBuf::from(destination))).await
}
#[tauri::command]
async fn import_attachment(
    state: State<'_, AppState>,
    source: String,
    expected_root: String,
    note_id: String,
) -> Command<String> {
    local(&state, move |v| {
        v.check_attachment_target(&expected_root, &note_id)?;
        v.import_attachment(&PathBuf::from(source))
    })
    .await
}
#[tauri::command]
async fn import_clipboard_image(
    state: State<'_, AppState>,
    expected_root: String,
    note_id: String,
    mime: String,
    bytes: Vec<u8>,
) -> Command<String> {
    local(&state, move |v| {
        v.import_clipboard_image(&expected_root, &note_id, &mime, &bytes)
    })
    .await
}
#[tauri::command]
async fn attachment_bytes(
    state: State<'_, AppState>,
    source_note: String,
    target: String,
) -> Command<crate::images::LocalImage> {
    local(&state, move |v| {
        let note = v.note(&source_note)?;
        crate::images::read(&v.root, &note.path, &target)
    })
    .await
}

#[tauri::command]
async fn note_links(state: State<'_, AppState>, id: String) -> Command<serde_json::Value> {
    local(&state, move |v| {
        let notes = v.notes()?;
        let note = v.note(&id)?;
        let outbound: Vec<_> = links::targets(&note.content)
            .iter()
            .filter(|(t, _, _, _)| t.ends_with(".md") || !t.contains('.'))
            .map(|(target, _, _, wiki)| links::resolve(&note.path, target, *wiki, &notes))
            .collect();
        let backlinks: Vec<_> = notes
            .iter()
            .filter(|n| {
                n.id != id
                    && links::targets(&n.content)
                        .iter()
                        .any(|(target, _, _, wiki)| {
                            links::resolve(&n.path, target, *wiki, &notes)
                                .resolved_id
                                .as_deref()
                                == Some(&id)
                        })
            })
            .cloned()
            .collect();
        Ok(serde_json::json!({"outbound":outbound,"backlinks":backlinks}))
    })
    .await
}
#[tauri::command]
async fn conflicts(state: State<'_, AppState>) -> Command<Vec<Conflict>> {
    local(&state, |v| v.conflicts()).await
}
#[tauri::command]
async fn resolve_conflict(
    state: State<'_, AppState>,
    item: String,
    content: Option<String>,
    path: String,
    version: Option<String>,
) -> Command<()> {
    local(&state, move |v| {
        v.resolve_conflict(&item, content, &path, version.as_deref())
    })
    .await
}
#[tauri::command]
async fn history(state: State<'_, AppState>, item: Option<String>) -> Command<Vec<Revision>> {
    local(&state, move |v| v.revisions(item.as_deref())).await
}
#[tauri::command]
async fn restore_revision(state: State<'_, AppState>, id: String) -> Command<()> {
    local(&state, move |v| v.restore_revision(&id)).await
}
#[tauri::command]
async fn keep_both_attachments(
    state: State<'_, AppState>,
    item: String,
    primary: String,
    path: String,
) -> Command<()> {
    local(&state, move |v| {
        v.keep_both_attachments(&item, &primary, &path)
    })
    .await
}

#[derive(Serialize)]
struct AccountInfo {
    encrypted: bool,
    unlocked: bool,
    connected: bool,
    bundled_client: bool,
    settings: OAuthSettings,
}
#[tauri::command]
async fn account_info(state: State<'_, AppState>) -> Command<AccountInfo> {
    let inner = state.0.clone();
    local(&state, move |v| {
        Ok(AccountInfo {
            bundled_client: !option_env!("GOOGLE_CLIENT_ID")
                .unwrap_or_default()
                .trim()
                .is_empty(),
            encrypted: config(v)?.is_some(),
            unlocked: inner
                .key
                .lock()
                .map_err(|_| fail("Encryption lock failed"))?
                .is_some(),
            connected: !settings(v)?.client_id.is_empty()
                && oauth::load_secret("google-refresh-token")?.is_some(),
            settings: settings(v)?,
        })
    })
    .await
}
#[tauri::command]
async fn configure_encryption(
    state: State<'_, AppState>,
    passphrase: String,
    remember: bool,
) -> Command<String> {
    let inner = state.0.clone();
    exclusive_local(&state, move |v| {
        let passphrase = Zeroizing::new(passphrase);
        if config(v)?.is_some() {
            return Err(fail("This vault already has an encryption key"));
        }
        let (config, key, recovery) = crypto::create_vault(&passphrase)?;
        paths::atomic_write(&v.internal("vault.json")?, &serde_json::to_vec(&config)?)?;
        if remember {
            oauth::store_secret(&format!("vault:{}", config.vault_id), &hex::encode(*key.0))?;
        }
        *inner
            .key
            .lock()
            .map_err(|_| fail("Encryption lock failed"))? = Some(key);
        Ok(recovery)
    })
    .await
}
#[tauri::command]
async fn unlock_sync(
    state: State<'_, AppState>,
    secret: String,
    recovery: bool,
    remember: bool,
) -> Command<()> {
    let inner = state.0.clone();
    exclusive_local(&state, move |v| {
        let secret = Zeroizing::new(secret);
        let config = config(v)?.ok_or_else(|| fail("Set up encryption first"))?;
        let key = crypto::unlock(&config, &secret, recovery)?;
        if remember {
            oauth::store_secret(&format!("vault:{}", config.vault_id), &hex::encode(*key.0))?;
        }
        *inner
            .key
            .lock()
            .map_err(|_| fail("Encryption lock failed"))? = Some(key);
        Ok(())
    })
    .await
}
#[tauri::command]
async fn lock_sync(state: State<'_, AppState>) -> Command<()> {
    let inner = state.0.clone();
    exclusive_local(&state, move |v| {
        *inner
            .key
            .lock()
            .map_err(|_| fail("Encryption lock failed"))? = None;
        if let Some(config) = config(v)? {
            oauth::forget_secret(&format!("vault:{}", config.vault_id))?;
        }
        v.set_state("sync_state", "locked")?;
        Ok(())
    })
    .await
}
#[tauri::command]
async fn save_oauth_settings(
    state: State<'_, AppState>,
    client_id: String,
    client_secret: Option<String>,
) -> Command<()> {
    if !option_env!("GOOGLE_CLIENT_ID")
        .unwrap_or_default()
        .trim()
        .is_empty()
    {
        return Err("Google sign-in is configured by this app build".into());
    }
    exclusive_local(&state, move |v| {
        v.set_state(
            "oauth_settings",
            &serde_json::to_string(&OAuthSettings {
                client_id: client_id.trim().into(),
                client_secret: client_secret.filter(|s| !s.is_empty()),
            })?,
        )
    })
    .await
}
#[tauri::command]
async fn connect_drive(state: State<'_, AppState>) -> Command<()> {
    let settings = exclusive_local(&state, |v| settings(v)).await?;
    let tokens = oauth::authorize(&settings)
        .await
        .map_err(|e| e.to_string())?;
    let refresh = tokens.refresh_token.ok_or_else(|| {
        "Google did not return a refresh token. Revoke the previous grant and reconnect."
            .to_string()
    })?;
    oauth::store_secret("google-refresh-token", &refresh).map_err(|e| e.to_string())
}
#[tauri::command]
async fn disconnect_drive(state: State<'_, AppState>) -> Command<()> {
    exclusive_local(&state, |v| {
        oauth::forget_secret("google-refresh-token")?;
        v.set_state("sync_state", "local")
    })
    .await
}
#[tauri::command]
async fn discover_vaults(state: State<'_, AppState>) -> Command<Vec<RemoteFile>> {
    let settings = exclusive_local(&state, |v| settings(v)).await?;
    let client = client(&settings).await.map_err(|e| e.to_string())?;
    sync::discover(&client).await.map_err(|e| e.to_string())
}
#[tauri::command]
async fn join_remote_vault(
    state: State<'_, AppState>,
    root_id: String,
    secret: String,
    recovery: bool,
    remember: bool,
) -> Command<()> {
    let settings = exclusive_local(&state, |v| settings(v)).await?;
    let client = client(&settings).await.map_err(|e| e.to_string())?;
    let inner = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = inner.operations.clone().blocking_lock_owned();
        require_idle(&inner)?;
        let mut guard = inner.vault.lock().map_err(|_| fail("Vault lock failed"))?;
        let v = guard
            .as_mut()
            .ok_or_else(|| fail("Open an empty local vault first"))?;
        if !v.notes()?.is_empty() || !v.revisions(None)?.is_empty() || config(v)?.is_some() {
            return Err(fail(
                "Restore into an empty vault without existing encryption settings",
            ));
        }
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        let config = runtime.block_on(sync::remote_config(v, &client, &root_id))?;
        let secret = Zeroizing::new(secret);
        let key = crypto::unlock(&config, &secret, recovery)?;
        paths::atomic_write(&v.internal("vault.json")?, &serde_json::to_vec(&config)?)?;
        v.set_state("folder:vault", &root_id)?;
        v.set_state("ready:vault", "1")?;
        if remember {
            oauth::store_secret(&format!("vault:{}", config.vault_id), &hex::encode(*key.0))?;
        }
        *inner
            .key
            .lock()
            .map_err(|_| fail("Encryption lock failed"))? = Some(key);
        Ok::<_, crate::Error>(())
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}
#[tauri::command]
async fn sync_now(state: State<'_, AppState>) -> Command<SyncStatus> {
    let inner = state.0.clone();
    let running = ActiveSync::begin(inner.clone()).map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let _running = running;
        let (root, config, key, settings) = {
            let _operation = inner.operations.clone().blocking_lock_owned();
            let guard = inner.vault.lock().map_err(|_| fail("Vault lock failed"))?;
            let v = guard
                .as_ref()
                .ok_or_else(|| fail("Open a local vault first"))?;
            let config =
                config(v)?.ok_or_else(|| fail("Set up sync encryption in Settings first"))?;
            let key = inner
                .key
                .lock()
                .map_err(|_| fail("Encryption lock failed"))?
                .clone()
                .ok_or_else(|| fail("Unlock sync in Settings first"))?;
            (v.root.clone(), config, key, settings(v)?)
        };
        *inner.progress.lock().unwrap() = Some(SyncProgress {
            stage: "Connecting to Google Drive".into(),
            completed: 0,
            total: 0,
        });
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        runtime.block_on(async {
            let client = client(&settings).await?;
            let remote =
                crate::sync_transport::BackgroundRemote::new(client, inner.operations.clone())
                    .await;
            // The primary handle retains the process file lock. Both connections use
            // the same operation gate for local work, released only during network I/O.
            let mut worker = Vault::connect(&root)?;
            sync::synchronize_with_progress(&mut worker, &remote, &config, &key, &|progress| {
                *inner.progress.lock().unwrap() = Some(progress);
            })
            .await
        })
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}
#[tauri::command]
fn sync_progress(state: State<'_, AppState>) -> Command<Option<SyncProgress>> {
    Ok(state
        .0
        .progress
        .lock()
        .map_err(|_| "Sync progress lock failed")?
        .clone())
}
#[derive(Serialize)]
struct WebDavInfo {
    settings: webdav::Settings,
    configured: bool,
    last_backup: Option<String>,
}
fn webdav_settings(v: &Vault) -> Result<webdav::Settings> {
    match v.get_state("webdav_settings")?.filter(|s| !s.is_empty()) {
        Some(raw) => Ok(serde_json::from_str(&raw)?),
        None => Ok(webdav::Settings::default()),
    }
}
fn webdav_client(v: &Vault) -> Result<webdav::WebDav> {
    let settings = webdav_settings(v)?;
    let password = oauth::load_secret(&webdav::credential_id(&settings)?)?
        .ok_or_else(|| fail("Connect Nextcloud in Settings first"))?;
    webdav::WebDav::new(&settings, password)
}
#[tauri::command]
async fn webdav_info(state: State<'_, AppState>) -> Command<WebDavInfo> {
    local(&state, |v| {
        let settings = webdav_settings(v)?;
        let configured = !settings.url.is_empty()
            && oauth::load_secret(&webdav::credential_id(&settings)?)?.is_some();
        Ok(WebDavInfo {
            settings,
            configured,
            last_backup: v.get_state("webdav_last_backup")?,
        })
    })
    .await
}
#[tauri::command]
async fn configure_webdav(
    state: State<'_, AppState>,
    url: String,
    username: String,
    password: Option<String>,
) -> Command<()> {
    let runtime = tokio::runtime::Handle::current();
    local(&state, move |v| {
        let settings = webdav::Settings {
            url: webdav::endpoint(&url)?.to_string(),
            username: username.trim().into(),
        };
        let credential = webdav::credential_id(&settings)?;
        let password = match password.filter(|p| !p.is_empty()) {
            Some(p) => Zeroizing::new(p),
            None => oauth::load_secret(&credential)?
                .ok_or_else(|| fail("Enter a Nextcloud app password"))?,
        };
        let client = webdav::WebDav::new(&settings, password.clone())?;
        runtime.block_on(client.test())?;
        oauth::store_secret(&credential, &password)?;
        v.set_state("webdav_settings", &serde_json::to_string(&settings)?)?;
        Ok(())
    })
    .await
}
#[tauri::command]
async fn disconnect_webdav(state: State<'_, AppState>) -> Command<()> {
    local(&state, |v| {
        let settings = webdav_settings(v)?;
        if !settings.url.is_empty() {
            oauth::forget_secret(&webdav::credential_id(&settings)?)?;
        }
        v.set_state("webdav_settings", "")?;
        v.set_state("webdav_last_backup", "")?;
        Ok(())
    })
    .await
}
#[tauri::command]
async fn backup_webdav(state: State<'_, AppState>) -> Command<String> {
    let runtime = tokio::runtime::Handle::current();
    let inner = state.0.clone();
    local(&state, move |v| {
        let config =
            config(v)?.ok_or_else(|| fail("Set up encryption in Protect your notes first"))?;
        let key = inner
            .key
            .lock()
            .map_err(|_| fail("Encryption lock failed"))?
            .clone()
            .ok_or_else(|| fail("Unlock encryption before backing up"))?;
        let client = webdav_client(v)?;
        let temp = tempfile::TempDir::new()?;
        let archive = temp.path().join("backup.enc");
        let id = backup::create(v, &config, &key, &archive)?;
        let name = format!("{}-{}-{id}.wnbackup", vault::now(), config.vault_id);
        runtime.block_on(client.upload(&name, &archive))?;
        v.set_state("webdav_last_backup", &name)?;
        Ok(name)
    })
    .await
}
#[tauri::command]
async fn list_webdav_backups(state: State<'_, AppState>) -> Command<Vec<webdav::BackupInfo>> {
    let runtime = tokio::runtime::Handle::current();
    local(&state, move |v| runtime.block_on(webdav_client(v)?.list())).await
}
#[tauri::command]
async fn restore_webdav_backup(
    state: State<'_, AppState>,
    name: String,
    parent: String,
    secret: String,
    recovery: bool,
) -> Command<String> {
    let runtime = tokio::runtime::Handle::current();
    local(&state, move |v| {
        let parent = PathBuf::from(parent).canonicalize()?;
        if parent.starts_with(&v.root) {
            return Err(fail(
                "Choose a restore location outside the current notebook",
            ));
        }
        let secret = Zeroizing::new(secret);
        let temp = tempfile::TempDir::new()?;
        let archive = temp.path().join("download.enc");
        runtime.block_on(webdav_client(v)?.download(&name, &archive))?;
        Ok(backup::restore(&archive, &parent, &secret, recovery)?
            .to_string_lossy()
            .into())
    })
    .await
}
#[tauri::command]
fn open_external(url: String) -> Command<()> {
    let parsed = url::Url::parse(&url).map_err(|_| "Invalid link".to_string())?;
    if !["https", "http", "mailto"].contains(&parsed.scheme()) {
        return Err("This link type cannot be opened".into());
    }
    open::that(parsed.as_str()).map_err(|e| e.to_string())
}
pub fn run() {
    let app = tauri::Builder::default()
        .menu(|app| {
            use tauri::menu::{Menu, MenuItem, MenuItemKind};
            let menu = Menu::default(app)?;
            // Native predefined Quit/Exit actions can terminate before ExitRequested.
            // Route them through the same frontend flush as window-close instead.
            for item in menu.items()? {
                if let MenuItemKind::Submenu(submenu) = item {
                    for (position, child) in submenu.items()?.into_iter().enumerate() {
                        if let MenuItemKind::Predefined(predefined) = child {
                            let text = predefined.text()?;
                            let label = text.replace('&', "");
                            if label == "Exit" || label == "Quit" || label.starts_with("Quit ") {
                                submenu.remove(&predefined)?;
                                submenu.insert(
                                    &MenuItem::with_id(
                                        app,
                                        "save-and-quit",
                                        text,
                                        true,
                                        Some("CmdOrCtrl+Q"),
                                    )?,
                                    position,
                                )?;
                            }
                        }
                    }
                }
            }
            Ok(menu)
        })
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "save-and-quit" {
                let _ = app.emit("notes-close-requested", ());
            }
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            webdav_info,
            configure_webdav,
            disconnect_webdav,
            backup_webdav,
            list_webdav_backups,
            restore_webdav_backup,
            open_vault,
            last_vault,
            vault_info,
            create_note,
            save_note,
            set_tags,
            rename_note,
            delete_note,
            create_folder,
            delete_folder,
            deleted_folders,
            restore_folder,
            search_notes,
            import_folder,
            export_vault,
            import_attachment,
            import_clipboard_image,
            attachment_bytes,
            note_links,
            conflicts,
            resolve_conflict,
            history,
            restore_revision,
            keep_both_attachments,
            account_info,
            configure_encryption,
            unlock_sync,
            lock_sync,
            save_oauth_settings,
            connect_drive,
            disconnect_drive,
            discover_vaults,
            join_remote_vault,
            sync_now,
            sync_progress,
            finish_exit,
            restart_after_update,
            open_external
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.emit("notes-close-requested", ());
            }
        })
        .build(tauri::generate_context!())
        .expect("Wattle Notes could not start");
    app.run(|handle, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            if !handle
                .state::<AppState>()
                .0
                .can_exit
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                api.prevent_exit();
                let _ = handle.emit("notes-close-requested", ());
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate as core_lib;
    use crate::drive::Remote;
    use async_trait::async_trait;
    use std::collections::HashMap;
    mod memory_remote {
        include!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../tests/support/remote.rs"
        ));
    }

    struct PausedRemote {
        started: Arc<tokio::sync::Notify>,
        resume: Arc<tokio::sync::Notify>,
    }
    #[async_trait]
    impl Remote for PausedRemote {
        async fn allocate_id(&self) -> Result<String> {
            unreachable!()
        }
        async fn list(&self, _: Option<&str>) -> Result<Vec<RemoteFile>> {
            self.started.notify_one();
            self.resume.notified().await;
            Err(fail("Synthetic network failure"))
        }
        async fn create_folder(
            &self,
            _: &str,
            _: Option<&str>,
            _: &str,
            _: &HashMap<String, String>,
        ) -> Result<()> {
            unreachable!()
        }
        async fn upload(
            &self,
            _: &str,
            _: &str,
            _: &str,
            _: &Path,
            _: &HashMap<String, String>,
            _: bool,
        ) -> Result<Option<String>> {
            unreachable!()
        }
        async fn download(&self, _: &str, _: &Path, _: u64) -> Result<()> {
            unreachable!()
        }
        async fn start_cursor(&self) -> Result<String> {
            unreachable!()
        }
        async fn changes(&self, _: &str) -> Result<(String, Vec<String>)> {
            unreachable!()
        }
        async fn trash(&self, _: &str) -> Result<()> {
            unreachable!()
        }
    }

    #[tokio::test]
    async fn slow_drive_requests_do_not_block_local_images_or_saves_and_relock_on_failure() {
        let dir = tempfile::TempDir::new().unwrap();
        let inner = Arc::new(session(dir.path()));
        let state = AppState(inner.clone());
        let running = ActiveSync::begin(inner.clone()).unwrap();
        let root = dir.path().join("current");
        fs::create_dir(root.join("assets")).unwrap();
        let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD,
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=").unwrap();
        fs::write(root.join("assets/photo.png"), &bytes).unwrap();
        let started = Arc::new(tokio::sync::Notify::new());
        let resume = Arc::new(tokio::sync::Notify::new());
        let remote = crate::sync_transport::BackgroundRemote::new(
            PausedRemote {
                started: started.clone(),
                resume: resume.clone(),
            },
            inner.operations.clone(),
        )
        .await;
        let request = tokio::spawn(async move {
            let result = remote.list(None).await;
            (remote, result)
        });
        started.notified().await;
        let read_and_saved = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            local(&state, |v| {
                let note = v.notes()?.remove(0);
                let image = crate::images::read(&v.root, &note.path, "assets/photo.png")?;
                v.save_note(&note.id, "Saved while Drive is waiting", &note.hash)?;
                Ok((image.bytes, config(v)?.is_some()))
            }),
        )
        .await
        .expect("local reads/saves must finish before the remote request resumes")
        .unwrap();
        assert_eq!(read_and_saved, (bytes, false));
        assert!(
            Vault::open(&root).is_err(),
            "primary handle must retain the process lock"
        );
        assert!(switch_vault(&inner, &dir.path().join("next"), |_| Ok(())).is_err());
        resume.notify_one();
        let (remote, result) = request.await.unwrap();
        assert!(result.is_err());
        assert!(
            inner.operations.try_lock().is_err(),
            "error handling must hold the local gate again"
        );
        drop(remote);
        assert!(inner.operations.try_lock().is_ok());
        drop(running);
        assert!(require_idle(&inner).is_ok());
    }

    #[test]
    fn duplicate_sync_is_rejected_and_guard_always_clears_progress() {
        let inner = Arc::new(Inner::default());
        let running = ActiveSync::begin(inner.clone()).unwrap();
        assert!(ActiveSync::begin(inner.clone()).is_err());
        *inner.progress.lock().unwrap() = Some(SyncProgress {
            stage: "Uploading attachments".into(),
            completed: 2,
            total: 100,
        });
        drop(running);
        assert!(inner.progress.lock().unwrap().is_none());
        assert!(require_idle(&inner).is_ok());
    }

    #[tokio::test]
    async fn edits_and_new_attachments_during_upload_remain_pending_until_dependencies_are_uploaded(
    ) {
        let dir = tempfile::TempDir::new().unwrap();
        let mut primary = Vault::open(dir.path()).unwrap();
        let note = primary.create_note("Page.md").unwrap();
        fs::write(dir.path().join("first.png"), b"first attachment").unwrap();
        primary.scan().unwrap();
        let mut worker = Vault::connect(dir.path()).unwrap();
        let (config, key, _) = crypto::create_vault("synthetic sync test passphrase").unwrap();
        let remote = memory_remote::MemoryRemote::default();
        let edited = std::sync::atomic::AtomicBool::new(false);
        let primary = Mutex::new(primary);
        let callback = |p: SyncProgress| {
            if p.stage == "Uploading attachments"
                && p.completed == 1
                && !edited.swap(true, std::sync::atomic::Ordering::SeqCst)
            {
                // Simulate a local operation completing while the network gate is
                // yielded. Add a new blob after this pass's blob list was captured.
                let mut primary = primary.lock().unwrap();
                fs::write(primary.root.join("late.png"), b"new attachment").unwrap();
                primary.scan().unwrap();
                let latest = primary.note(&note.id).unwrap();
                primary
                    .save_note(
                        &note.id,
                        "Saved during sync\n![new](late.png)",
                        &latest.hash,
                    )
                    .unwrap();
            }
        };
        let status =
            sync::synchronize_with_progress(&mut worker, &remote, &config, &key, &callback)
                .await
                .unwrap();
        assert!(edited.load(std::sync::atomic::Ordering::SeqCst));
        assert!(status.pending > 0);
        assert_eq!(status.state, "pending");
        let primary = primary.into_inner().unwrap();
        let latest = primary.heads(&note.id).unwrap().remove(0);
        let uploaded: bool = primary
            .db
            .query_row(
                "SELECT uploaded FROM revisions WHERE id=?",
                [&latest.id],
                |r| r.get(0),
            )
            .unwrap();
        assert!(
            !uploaded,
            "a new note revision must wait for its new attachment blob"
        );
        let restored_dir = tempfile::TempDir::new().unwrap();
        let mut restored = Vault::open(restored_dir.path()).unwrap();
        sync::synchronize(&mut restored, &remote, &config, &key)
            .await
            .unwrap();
        assert!(
            !restored.root.join("late.png").exists(),
            "incomplete attachment history must never be published"
        );
        let status = sync::synchronize(&mut worker, &remote, &config, &key)
            .await
            .unwrap();
        assert_eq!(status.pending, 0);
        sync::synchronize(&mut restored, &remote, &config, &key)
            .await
            .unwrap();
        assert!(restored
            .note(&note.id)
            .unwrap()
            .content
            .contains("Saved during sync"));
        assert_eq!(
            fs::read(restored.root.join("late.png")).unwrap(),
            b"new attachment"
        );
    }

    fn session(parent: &Path) -> Inner {
        let mut vault = Vault::open(parent.join("current")).unwrap();
        vault.create_note("Current.md").unwrap();
        fs::create_dir(parent.join("next")).unwrap();
        Inner {
            vault: Mutex::new(Some(vault)),
            key: Mutex::new(Some(VaultKey(Zeroizing::new([7; 32])))),
            ..Inner::default()
        }
    }
    fn assert_current(inner: &Inner, root: &Path) {
        let mut guard = inner.vault.lock().unwrap();
        let vault = guard.as_mut().unwrap();
        assert_eq!(vault.root, root.canonicalize().unwrap());
        let note = vault.notes().unwrap().remove(0);
        vault
            .save_note(&note.id, "Still writable", &note.hash)
            .unwrap();
        assert_eq!(*inner.key.lock().unwrap().as_ref().unwrap().0, [7; 32]);
        assert!(
            Vault::open(root).is_err(),
            "the current notebook must stay locked"
        );
    }
    #[test]
    fn failed_notebook_selection_preserves_the_current_handle_and_key() {
        let dir = tempfile::TempDir::new().unwrap();
        let inner = session(dir.path());
        let missing = dir.path().join("missing");
        assert!(switch_vault(&inner, &missing, |_| Ok(())).is_err());
        assert!(
            !missing.exists(),
            "an unavailable folder must not be recreated"
        );
        assert_current(&inner, &dir.path().join("current"));

        let next = dir.path().join("next");
        let locked = Vault::open(&next).unwrap();
        assert!(switch_vault(&inner, &next, |_| Ok(())).is_err());
        assert_current(&inner, &dir.path().join("current"));
        drop(locked);
        fs::write(
            next.join(".notes/vault.json"),
            b"malformed encryption config",
        )
        .unwrap();
        assert!(switch_vault(&inner, &next, |_| Ok(())).is_err());
        assert_current(&inner, &dir.path().join("current"));
    }
    #[test]
    fn failed_preference_write_does_not_publish_the_candidate_notebook() {
        let dir = tempfile::TempDir::new().unwrap();
        let inner = session(dir.path());
        let next = dir.path().join("next");
        assert!(switch_vault(&inner, &next, |_| Err(fail("preference write failed"))).is_err());
        assert_current(&inner, &dir.path().join("current"));
        assert!(
            Vault::open(next).is_ok(),
            "failed candidates must release their file lock"
        );
    }
    #[test]
    fn reselecting_the_same_notebook_preserves_its_unlocked_key() {
        let dir = tempfile::TempDir::new().unwrap();
        let inner = session(dir.path());
        let current = dir.path().join("current");
        fs::write(current.join("External.md"), "# External edit").unwrap();
        let info = switch_vault(&inner, &current.join("."), |_| Ok(())).unwrap();
        assert_eq!(info.notes.len(), 2);
        assert_current(&inner, &current);
    }
    #[test]
    fn successful_notebook_selection_releases_the_old_lock_and_clears_its_key() {
        let dir = tempfile::TempDir::new().unwrap();
        let inner = session(dir.path());
        let next = dir.path().join("next");
        let info = switch_vault(&inner, &next, |root| {
            assert_eq!(root, next.canonicalize().unwrap().to_string_lossy());
            Ok(())
        })
        .unwrap();
        assert_eq!(info.root, next.canonicalize().unwrap().to_string_lossy());
        assert!(inner.key.lock().unwrap().is_none());
        assert!(Vault::open(dir.path().join("current")).is_ok());
        assert!(Vault::open(next).is_err());
    }
}
