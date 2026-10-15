use crate::{error::fail, Result};
use async_trait::async_trait;
use reqwest::{Client, Method, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, path::Path, time::Duration};

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFile {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub mime_type: String,
    #[serde(default)]
    pub app_properties: HashMap<String, String>,
    #[serde(default)]
    pub size: Option<String>,
    #[serde(default)]
    pub trashed: bool,
    #[serde(default)]
    pub version: Option<String>,
}

#[async_trait]
pub trait Remote: Send + Sync {
    async fn allocate_id(&self) -> Result<String>;
    async fn list(&self, parent: Option<&str>) -> Result<Vec<RemoteFile>>;
    async fn create_folder(
        &self,
        id: &str,
        parent: Option<&str>,
        name: &str,
        properties: &HashMap<String, String>,
    ) -> Result<()>;
    async fn upload(
        &self,
        id: &str,
        parent: &str,
        name: &str,
        path: &Path,
        properties: &HashMap<String, String>,
        replace: bool,
    ) -> Result<()>;
    async fn download(&self, id: &str, destination: &Path, limit: u64) -> Result<()>;
    async fn start_cursor(&self) -> Result<String>;
    async fn changes(&self, cursor: &str) -> Result<(String, Vec<String>)>;
    async fn trash(&self, id: &str) -> Result<()>;
}

pub struct DriveClient {
    client: Client,
    token: zeroize::Zeroizing<String>,
}
impl DriveClient {
    pub fn new(token: String) -> Result<Self> {
        Ok(Self {
            client: Client::builder()
                .timeout(Duration::from_secs(120))
                .build()?,
            token: zeroize::Zeroizing::new(token),
        })
    }
    async fn request(
        &self,
        method: Method,
        url: &str,
        body: Option<&Value>,
    ) -> Result<reqwest::Response> {
        for attempt in 0..5u32 {
            let mut request = self
                .client
                .request(method.clone(), url)
                .bearer_auth(self.token.as_str());
            if let Some(body) = body {
                request = request.json(body);
            }
            match request.send().await {
                Ok(response) if response.status().is_success() => return Ok(response),
                Ok(response) if response.status() == StatusCode::CONFLICT && method == Method::POST => return Ok(response),
                Ok(response) if response.status() == StatusCode::UNAUTHORIZED => return Err(fail("Google sign-in expired. Reconnect your account.")),
                Ok(response) if response.status() == StatusCode::FORBIDDEN => return Err(fail("Drive access was refused or its quota was reached. Check account permissions and storage.")),
                Ok(response) if response.status().is_server_error() || response.status() == StatusCode::TOO_MANY_REQUESTS => {},
                Ok(response) => return Err(fail(format!("Drive returned HTTP {}. Local files are unchanged.",response.status().as_u16()))),
                Err(_) if attempt < 4 => {},
                Err(error) => return Err(error.into()),
            }
            tokio::time::sleep(Duration::from_millis(500 * (1u64 << attempt))).await;
        }
        Err(fail(
            "Drive is temporarily unavailable. Pending uploads are retained.",
        ))
    }
    fn file_url(id: &str) -> Result<String> {
        if id.is_empty()
            || id.len() > 200
            || !id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            return Err(fail("Invalid Drive file ID"));
        }
        Ok(format!("https://www.googleapis.com/drive/v3/files/{id}"))
    }
}

#[async_trait]
impl Remote for DriveClient {
    async fn allocate_id(&self) -> Result<String> {
        let data: Value = self.request(Method::GET,"https://www.googleapis.com/drive/v3/files/generateIds?count=1&space=drive&type=files",None).await?.json().await?;
        data["ids"][0]
            .as_str()
            .map(String::from)
            .ok_or_else(|| fail("Drive did not allocate a file identity"))
    }
    async fn list(&self, parent: Option<&str>) -> Result<Vec<RemoteFile>> {
        let query = match parent {
            Some(id) => {
                Self::file_url(id)?;
                format!("'{id}' in parents and trashed=false")
            }
            None => "trashed=false and appProperties has { key='newNotesRole' and value='vault' }"
                .into(),
        };
        let mut result = Vec::new();
        let mut page = String::new();
        loop {
            let mut url = url::Url::parse("https://www.googleapis.com/drive/v3/files")
                .map_err(|_| fail("Invalid Drive endpoint"))?;
            url.query_pairs_mut().extend_pairs([
                ("q", query.as_str()),
                ("pageSize", "1000"),
                ("spaces", "drive"),
                (
                    "fields",
                    "nextPageToken,files(id,name,mimeType,appProperties,size,trashed,version)",
                ),
            ]);
            if !page.is_empty() {
                url.query_pairs_mut().append_pair("pageToken", &page);
            }
            let data: Value = self
                .request(Method::GET, url.as_str(), None)
                .await?
                .json()
                .await?;
            let files: Vec<RemoteFile> = serde_json::from_value(data["files"].clone())?;
            result.extend(files);
            if result.len() > 100000 {
                return Err(fail(
                    "Drive folder exceeds this release's 100,000-object limit",
                ));
            }
            page = data["nextPageToken"].as_str().unwrap_or_default().into();
            if page.is_empty() {
                break;
            }
        }
        Ok(result)
    }
    async fn create_folder(
        &self,
        id: &str,
        parent: Option<&str>,
        name: &str,
        properties: &HashMap<String, String>,
    ) -> Result<()> {
        Self::file_url(id)?;
        let mut body = json!({"id":id,"name":name,"mimeType":"application/vnd.google-apps.folder","appProperties":properties});
        if let Some(parent) = parent {
            Self::file_url(parent)?;
            body["parents"] = json!([parent]);
        }
        self.request(
            Method::POST,
            "https://www.googleapis.com/drive/v3/files",
            Some(&body),
        )
        .await?;
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
        Self::file_url(id)?;
        Self::file_url(parent)?;
        let length = tokio::fs::metadata(path).await?.len();
        let body = if replace {
            json!({"name":name,"appProperties":properties})
        } else {
            json!({"id":id,"name":name,"parents":[parent],"appProperties":properties})
        };
        let endpoint = if replace {
            format!("https://www.googleapis.com/upload/drive/v3/files/{id}?uploadType=resumable")
        } else {
            "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable".into()
        };
        for attempt in 0..5u32 {
            let response = self
                .client
                .request(
                    if replace { Method::PATCH } else { Method::POST },
                    &endpoint,
                )
                .bearer_auth(self.token.as_str())
                .header("X-Upload-Content-Type", "application/octet-stream")
                .header("X-Upload-Content-Length", length)
                .json(&body)
                .send()
                .await?;
            if response.status() == StatusCode::CONFLICT && !replace {
                return Ok(());
            }
            if !response.status().is_success() {
                if response.status().is_server_error()
                    || response.status() == StatusCode::TOO_MANY_REQUESTS
                {
                    tokio::time::sleep(Duration::from_millis(500 * (1 << attempt))).await;
                    continue;
                }
                return Err(fail(format!(
                    "Drive could not start an encrypted upload (HTTP {})",
                    response.status().as_u16()
                )));
            }
            let location = response
                .headers()
                .get("location")
                .and_then(|h| h.to_str().ok())
                .ok_or_else(|| fail("Drive upload session is missing"))?
                .to_string();
            let url = url::Url::parse(&location).map_err(|_| fail("Invalid upload session"))?;
            if url.scheme() != "https" || url.host_str() != Some("www.googleapis.com") {
                return Err(fail("Untrusted Drive upload session"));
            }
            let mut file = tokio::fs::File::open(path).await?;
            use tokio::io::{AsyncReadExt, AsyncSeekExt};
            let mut offset = 0u64;
            while offset < length {
                file.seek(std::io::SeekFrom::Start(offset)).await?;
                let count = std::cmp::min(1024 * 1024, length - offset) as usize;
                let mut buffer = vec![0; count];
                file.read_exact(&mut buffer).await?;
                let response = self
                    .client
                    .put(&location)
                    .bearer_auth(self.token.as_str())
                    .header("Content-Length", count)
                    .header(
                        "Content-Range",
                        format!("bytes {}-{}/{}", offset, offset + count as u64 - 1, length),
                    )
                    .body(buffer)
                    .send()
                    .await;
                match response {
                    Ok(r) if r.status().is_success() => {
                        if offset + count as u64 != length {
                            return Err(fail("Drive completed an incomplete upload"));
                        }
                        return Ok(());
                    }
                    Ok(r) if r.status().as_u16() == 308 => {
                        offset = acknowledged_offset(&r)?;
                        if offset > length {
                            return Err(fail("Invalid upload acknowledgment"));
                        }
                    }
                    Ok(r)
                        if !r.status().is_server_error()
                            && r.status() != StatusCode::TOO_MANY_REQUESTS =>
                    {
                        break
                    }
                    _ => {
                        // Query the session after uncertain delivery, then resume acknowledged bytes.
                        tokio::time::sleep(Duration::from_millis(500 * (1 << attempt))).await;
                        let status = self
                            .client
                            .put(&location)
                            .bearer_auth(self.token.as_str())
                            .header("Content-Length", 0)
                            .header("Content-Range", format!("bytes */{length}"))
                            .send()
                            .await?;
                        if status.status().is_success() {
                            return Ok(());
                        }
                        if status.status().as_u16() != 308 {
                            break;
                        }
                        offset = acknowledged_offset(&status)?;
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(500 * (1 << attempt))).await;
        }
        Err(fail(
            "Encrypted upload interrupted. Its identity and local data are retained for retry.",
        ))
    }
    async fn download(&self, id: &str, destination: &Path, limit: u64) -> Result<()> {
        let mut response = self
            .request(
                Method::GET,
                &format!("{}?alt=media", Self::file_url(id)?),
                None,
            )
            .await?;
        if response.content_length().is_some_and(|n| n > limit) {
            return Err(fail("Remote file exceeds its resource limit"));
        }
        if let Some(parent) = destination.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let temp = destination.with_extension(format!("{}.download", uuid::Uuid::new_v4()));
        let outcome = async {
            use tokio::io::AsyncWriteExt;
            let mut file = tokio::fs::File::create(&temp).await?;
            let mut total = 0;
            while let Some(bytes) = response.chunk().await? {
                total += bytes.len() as u64;
                if total > limit {
                    return Err(fail("Remote file exceeds its resource limit"));
                }
                file.write_all(&bytes).await?;
            }
            file.sync_all().await?;
            drop(file);
            tokio::fs::rename(&temp, destination).await?;
            Ok(())
        }
        .await;
        if outcome.is_err() {
            let _ = tokio::fs::remove_file(&temp).await;
        }
        outcome
    }
    async fn start_cursor(&self) -> Result<String> {
        let value: Value = self
            .request(
                Method::GET,
                "https://www.googleapis.com/drive/v3/changes/startPageToken",
                None,
            )
            .await?
            .json()
            .await?;
        value["startPageToken"]
            .as_str()
            .map(String::from)
            .ok_or_else(|| fail("Drive change cursor is missing"))
    }
    async fn changes(&self, cursor: &str) -> Result<(String, Vec<String>)> {
        let mut page = cursor.to_string();
        let mut removed = Vec::new();
        loop {
            let mut url = url::Url::parse("https://www.googleapis.com/drive/v3/changes")
                .map_err(|_| fail("Invalid Drive endpoint"))?;
            url.query_pairs_mut().extend_pairs([
                ("pageToken", page.as_str()),
                ("spaces", "drive"),
                (
                    "fields",
                    "nextPageToken,newStartPageToken,changes(fileId,removed,file(trashed))",
                ),
            ]);
            let value: Value = self
                .request(Method::GET, url.as_str(), None)
                .await?
                .json()
                .await?;
            if let Some(changes) = value["changes"].as_array() {
                for change in changes {
                    if change["removed"].as_bool() == Some(true)
                        || change["file"]["trashed"].as_bool() == Some(true)
                    {
                        if let Some(id) = change["fileId"].as_str() {
                            removed.push(id.into());
                        }
                    }
                }
            }
            if let Some(next) = value["nextPageToken"].as_str() {
                page = next.into();
            } else {
                return Ok((
                    value["newStartPageToken"].as_str().unwrap_or(&page).into(),
                    removed,
                ));
            }
        }
    }
    async fn trash(&self, id: &str) -> Result<()> {
        self.request(
            Method::PATCH,
            &Self::file_url(id)?,
            Some(&json!({"trashed":true})),
        )
        .await?;
        Ok(())
    }
}

fn acknowledged_offset(response: &reqwest::Response) -> Result<u64> {
    match response
        .headers()
        .get("range")
        .and_then(|h| h.to_str().ok())
    {
        None => Ok(0),
        Some(range) => range
            .strip_prefix("bytes=0-")
            .and_then(|s| s.parse::<u64>().ok())
            .and_then(|n| n.checked_add(1))
            .ok_or_else(|| fail("Invalid Drive upload acknowledgment")),
    }
}
