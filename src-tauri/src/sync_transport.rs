//! Keep local notebook operations serialized, but never hold their gate over Drive I/O.
use crate::{
    drive::{Remote, RemoteFile},
    Result,
};
use async_trait::async_trait;
use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, Mutex},
};
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

pub struct BackgroundRemote<R> {
    remote: R,
    gate: Arc<AsyncMutex<()>>,
    held: AsyncMutex<Option<OwnedMutexGuard<()>>>,
}

impl<R: Remote> BackgroundRemote<R> {
    pub async fn new(remote: R, gate: Arc<AsyncMutex<()>>) -> Self {
        let held = gate.clone().lock_owned().await;
        Self {
            remote,
            gate,
            held: AsyncMutex::new(Some(held)),
        }
    }
    async fn network<T>(&self, request: impl std::future::Future<Output = Result<T>>) -> Result<T> {
        drop(self.held.lock().await.take());
        let result = request.await;
        // Reacquire even on errors: synchronize() records its outcome in the database.
        let held = self.gate.clone().lock_owned().await;
        *self.held.lock().await = Some(held);
        result
    }
}

#[async_trait]
impl<R: Remote> Remote for BackgroundRemote<R> {
    async fn allocate_id(&self) -> Result<String> {
        self.network(self.remote.allocate_id()).await
    }
    async fn list(&self, parent: Option<&str>) -> Result<Vec<RemoteFile>> {
        self.network(self.remote.list(parent)).await
    }
    async fn create_folder(
        &self,
        id: &str,
        parent: Option<&str>,
        name: &str,
        properties: &HashMap<String, String>,
    ) -> Result<()> {
        self.network(self.remote.create_folder(id, parent, name, properties))
            .await
    }
    async fn upload(
        &self,
        id: &str,
        parent: &str,
        name: &str,
        path: &Path,
        properties: &HashMap<String, String>,
        replace: bool,
    ) -> Result<Option<String>> {
        self.network(
            self.remote
                .upload(id, parent, name, path, properties, replace),
        )
        .await
    }
    async fn download(&self, id: &str, destination: &Path, limit: u64) -> Result<()> {
        self.network(self.remote.download(id, destination, limit))
            .await
    }
    async fn start_cursor(&self) -> Result<String> {
        self.network(self.remote.start_cursor()).await
    }
    async fn changes(&self, cursor: &str) -> Result<(String, Vec<String>)> {
        self.network(self.remote.changes(cursor)).await
    }
    async fn trash(&self, id: &str) -> Result<()> {
        self.network(self.remote.trash(id)).await
    }
}

/// One full listing per parent per sync pass, updated after our own successful writes.
/// Never reuse this cache across passes: missing history/mirror detection must stay live.
pub(crate) struct ListingCache<'a, R> {
    remote: &'a R,
    listings: Mutex<HashMap<Option<String>, Vec<RemoteFile>>>,
}
impl<'a, R: Remote> ListingCache<'a, R> {
    pub fn new(remote: &'a R) -> Self {
        Self {
            remote,
            listings: Mutex::new(HashMap::new()),
        }
    }
    fn remember(&self, parent: Option<&str>, file: RemoteFile) {
        if let Some(files) = self
            .listings
            .lock()
            .unwrap()
            .get_mut(&parent.map(String::from))
        {
            files.retain(|existing| existing.id != file.id);
            files.push(file);
        }
    }
}
#[async_trait]
impl<R: Remote> Remote for ListingCache<'_, R> {
    async fn allocate_id(&self) -> Result<String> {
        self.remote.allocate_id().await
    }
    async fn list(&self, parent: Option<&str>) -> Result<Vec<RemoteFile>> {
        let key = parent.map(String::from);
        let cached = self.listings.lock().unwrap().get(&key).cloned();
        if let Some(files) = cached {
            return Ok(files);
        }
        let files = self.remote.list(parent).await?;
        self.listings.lock().unwrap().insert(key, files.clone());
        Ok(files)
    }
    async fn create_folder(
        &self,
        id: &str,
        parent: Option<&str>,
        name: &str,
        properties: &HashMap<String, String>,
    ) -> Result<()> {
        self.remote
            .create_folder(id, parent, name, properties)
            .await?;
        self.remember(
            parent,
            RemoteFile {
                id: id.into(),
                name: name.into(),
                mime_type: "application/vnd.google-apps.folder".into(),
                app_properties: properties.clone(),
                size: None,
                trashed: false,
                version: None,
            },
        );
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
    ) -> Result<Option<String>> {
        let version = self
            .remote
            .upload(id, parent, name, path, properties, replace)
            .await?;
        self.remember(
            Some(parent),
            RemoteFile {
                id: id.into(),
                name: name.into(),
                mime_type: "application/octet-stream".into(),
                app_properties: properties.clone(),
                size: None,
                trashed: false,
                version: version.clone(),
            },
        );
        Ok(version)
    }
    async fn download(&self, id: &str, destination: &Path, limit: u64) -> Result<()> {
        self.remote.download(id, destination, limit).await
    }
    async fn start_cursor(&self) -> Result<String> {
        self.remote.start_cursor().await
    }
    async fn changes(&self, cursor: &str) -> Result<(String, Vec<String>)> {
        self.remote.changes(cursor).await
    }
    async fn trash(&self, id: &str) -> Result<()> {
        self.remote.trash(id).await?;
        for files in self.listings.lock().unwrap().values_mut() {
            files.retain(|file| file.id != id);
        }
        Ok(())
    }
}
