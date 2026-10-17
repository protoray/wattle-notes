use super::core_lib::{
    drive::{Remote, RemoteFile},
    error::fail,
    Result,
};
use async_trait::async_trait;
use std::{collections::HashMap, fs, path::Path, sync::Mutex};
use uuid::Uuid;
type StoredFile = (RemoteFile, Option<String>, Vec<u8>);
#[derive(Default)]
pub(crate) struct MemoryRemote {
    pub(crate) files: Mutex<HashMap<String, StoredFile>>,
    pub(crate) fail_next: Mutex<bool>,
    pub(crate) list_calls: std::sync::atomic::AtomicUsize,
    pub(crate) uploads: Mutex<Vec<String>>,
    pub(crate) downloads: Mutex<Vec<String>>,
    pub(crate) omit_upload_versions: std::sync::atomic::AtomicBool,
}
#[async_trait]
impl Remote for MemoryRemote {
    async fn allocate_id(&self) -> Result<String> {
        Ok(Uuid::new_v4().to_string())
    }
    async fn list(&self, parent: Option<&str>) -> Result<Vec<RemoteFile>> {
        self.list_calls
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
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
    ) -> Result<Option<String>> {
        self.uploads.lock().unwrap().push(id.into());
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
                        version: Some(super::core_lib::vault::hash(&bytes)),
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
        Ok(
            if self
                .omit_upload_versions
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                None
            } else {
                files.get(id).and_then(|(file, _, _)| file.version.clone())
            },
        )
    }
    async fn download(&self, id: &str, destination: &Path, limit: u64) -> Result<()> {
        self.downloads.lock().unwrap().push(id.into());
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
