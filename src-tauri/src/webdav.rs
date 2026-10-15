//! Nextcloud-compatible WebDAV transport for retained encrypted full backups.
use crate::{backup::MAX_BACKUP, error::fail, Result};
use quick_xml::{events::Event, Reader};
use reqwest::{Client, Method, Response, StatusCode, Url};
use serde::{Deserialize, Serialize};
use std::{io::Write, path::Path, time::Duration};
use tokio_util::io::ReaderStream;
use zeroize::Zeroizing;

const FOLDER: &str = "Wattle Notes Backups";
const PROPS: &str = r#"<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/></d:prop></d:propfind>"#;
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Settings {
    pub url: String,
    pub username: String,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct BackupInfo {
    pub name: String,
    pub size: u64,
}
#[derive(Default)]
struct Resource {
    href: String,
    collection: bool,
    size: u64,
    ok: bool,
}

pub fn endpoint(value: &str) -> Result<Url> {
    let mut url = Url::parse(value.trim())
        .map_err(|_| fail("Enter the WebDAV URL shown in Nextcloud Files settings"))?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(fail(
            "WebDAV requires an HTTPS URL without embedded credentials, query, or fragment",
        ));
    }
    if !url.path().ends_with('/') {
        url.set_path(&format!("{}/", url.path()));
    }
    Ok(url)
}
pub fn credential_id(settings: &Settings) -> Result<String> {
    Ok(format!(
        "webdav:{}",
        crate::vault::hash(
            format!("{}\n{}", endpoint(&settings.url)?, settings.username).as_bytes()
        )
    ))
}
fn parse(xml: &[u8]) -> Result<Vec<Resource>> {
    let mut reader = Reader::from_reader(xml);
    reader.config_mut().trim_text(true);
    let mut response = None;
    let mut tag = String::new();
    let mut resources = Vec::new();
    let mut multistatus = false;
    loop {
        match reader
            .read_event()
            .map_err(|_| fail("WebDAV returned malformed XML"))?
        {
            Event::Start(e) => {
                tag = e.local_name().as_ref().to_string();
                match tag.as_str() {
                    "multistatus" => multistatus = true,
                    "response" => response = Some(Resource::default()),
                    "collection" => {
                        if let Some(r) = response.as_mut() {
                            r.collection = true;
                        }
                    }
                    _ => {}
                }
            }
            Event::Empty(e) if e.local_name().as_ref() == "collection" => {
                if let Some(r) = response.as_mut() {
                    r.collection = true;
                }
            }
            Event::Text(e) => {
                if let Some(r) = response.as_mut() {
                    let decoded = e.xml10_content();
                    let text = quick_xml::escape::unescape(&decoded)
                        .map_err(|_| fail("Invalid WebDAV encoding"))?;
                    match tag.as_str() {
                        "href" => r.href.push_str(&text),
                        "getcontentlength" => {
                            r.size = text.parse().map_err(|_| fail("Invalid WebDAV file size"))?
                        }
                        "status" if text.split_whitespace().nth(1) == Some("200") => r.ok = true,
                        _ => {}
                    }
                }
            }
            Event::GeneralRef(e) => {
                let value = e
                    .resolve_char_ref()
                    .map_err(|_| fail("Invalid WebDAV character reference"))?
                    .or_else(|| match e.as_ref() {
                        "amp" => Some('&'),
                        "lt" => Some('<'),
                        "gt" => Some('>'),
                        "quot" => Some('"'),
                        "apos" => Some('\''),
                        _ => None,
                    })
                    .ok_or_else(|| fail("Unsupported WebDAV entity"))?;
                if tag == "href" {
                    if let Some(r) = response.as_mut() {
                        r.href.push(value);
                    }
                } else {
                    return Err(fail("Unexpected WebDAV entity"));
                }
            }
            Event::CData(e) if tag == "href" => {
                if let Some(r) = response.as_mut() {
                    r.href.push_str(e.as_ref());
                }
            }
            Event::End(e) => {
                if e.local_name().as_ref() == "response" {
                    if resources.len() >= 5000 {
                        return Err(fail("WebDAV listing exceeds 5,000 entries"));
                    }
                    if let Some(r) = response.take() {
                        resources.push(r);
                    }
                }
                tag.clear();
            }
            Event::DocType(_) => return Err(fail("WebDAV XML document types are not allowed")),
            Event::Eof => break,
            _ => {}
        }
    }
    if !multistatus || response.is_some() {
        return Err(fail("This URL did not return a WebDAV directory listing"));
    }
    Ok(resources)
}
fn check_name(name: &str) -> Result<()> {
    if name.len() > 150
        || !name.ends_with(".wnbackup")
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
        || name.contains("..")
    {
        return Err(fail("Invalid backup filename"));
    }
    Ok(())
}

pub struct WebDav {
    client: Client,
    base: Url,
    username: String,
    password: Zeroizing<String>,
}
impl WebDav {
    pub fn new(settings: &Settings, password: Zeroizing<String>) -> Result<Self> {
        if settings.username.trim().is_empty() || password.is_empty() {
            return Err(fail("Enter a Nextcloud username and app password"));
        }
        Ok(Self {
            client: Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(600))
                .connect_timeout(Duration::from_secs(20))
                .build()?,
            base: endpoint(&settings.url)?,
            username: settings.username.clone(),
            password,
        })
    }
    // Used only by the integration test's loopback fixture; production never accepts HTTP.
    #[cfg(test)]
    fn loopback(settings: &Settings, password: Zeroizing<String>) -> Self {
        Self {
            client: Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap(),
            base: Url::parse(&settings.url).unwrap(),
            username: settings.username.clone(),
            password,
        }
    }
    fn folder(&self) -> Url {
        let mut url = self.base.clone();
        url.path_segments_mut()
            .expect("HTTPS URL has path segments")
            .pop_if_empty()
            .push(FOLDER)
            .push("");
        url
    }
    fn object(&self, name: &str) -> Url {
        let mut url = self.folder();
        url.path_segments_mut()
            .expect("HTTPS URL has path segments")
            .pop_if_empty()
            .push(name);
        url
    }
    async fn send(
        &self,
        method: Method,
        url: &Url,
        body: Option<&str>,
        depth: Option<&str>,
    ) -> Result<Response> {
        for attempt in 0..4 {
            let mut request = self
                .client
                .request(method.clone(), url.clone())
                .basic_auth(&self.username, Some(self.password.as_str()));
            if let Some(body) = body {
                request = request
                    .header("Content-Type", "application/xml; charset=utf-8")
                    .body(body.to_string());
            }
            if let Some(depth) = depth {
                request = request.header("Depth", depth);
            }
            match request.send().await {
                Ok(response)
                    if (response.status().is_server_error()
                        && response.status() != StatusCode::INSUFFICIENT_STORAGE)
                        || response.status() == StatusCode::TOO_MANY_REQUESTS => {}
                Ok(response) => return Self::checked(response),
                Err(error) if attempt == 3 => return Err(error.into()),
                Err(_) => {}
            }
            tokio::time::sleep(Duration::from_millis(250 * (1 << attempt))).await;
        }
        Err(fail(
            "Nextcloud is temporarily unavailable. Retry; local notes are safe.",
        ))
    }
    fn checked(response: Response) -> Result<Response> {
        match response.status() {
            StatusCode::UNAUTHORIZED => Err(fail("Nextcloud rejected the login. Check the username and app password.")),
            StatusCode::FORBIDDEN => Err(fail("Nextcloud denied access. Check folder permissions and your app password.")),
            StatusCode::INSUFFICIENT_STORAGE => Err(fail("Nextcloud storage is full. Free space, then retry.")),
            status if status.is_redirection() => Err(fail("WebDAV redirected the request. Use the final HTTPS WebDAV URL from Nextcloud Files settings.")),
            _ => Ok(response)
        }
    }
    async fn directory(&self, url: &Url, depth: &str) -> Result<Vec<Resource>> {
        let mut response = self
            .send(
                Method::from_bytes(b"PROPFIND").unwrap(),
                url,
                Some(PROPS),
                Some(depth),
            )
            .await?;
        if !response.status().is_success() {
            return Err(fail(format!(
                "WebDAV directory request returned HTTP {}",
                response.status().as_u16()
            )));
        }
        let mut xml = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            if xml.len() + chunk.len() > 2 * 1024 * 1024 {
                return Err(fail("WebDAV listing is too large"));
            }
            xml.extend_from_slice(&chunk);
        }
        parse(&xml)
    }
    pub async fn test(&self) -> Result<()> {
        let resources = self.directory(&self.base, "0").await?;
        if !resources.iter().any(|r| {
            r.ok && r.collection && self.base.join(&r.href).is_ok_and(|url| url == self.base)
        }) {
            return Err(fail(
                "Use a WebDAV folder URL, not the Nextcloud login page",
            ));
        }
        Ok(())
    }
    pub async fn list(&self) -> Result<Vec<BackupInfo>> {
        let response = self.send(Method::HEAD, &self.folder(), None, None).await?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(vec![]);
        }
        let folder = self.folder();
        let mut result = Vec::new();
        for resource in self.directory(&folder, "1").await? {
            let url = folder
                .join(&resource.href)
                .map_err(|_| fail("Invalid WebDAV resource URL"))?;
            if url.origin() != folder.origin()
                || !url.path().starts_with(folder.path())
                || !resource.ok
                || resource.collection
            {
                continue;
            }
            let name = &url.path()[folder.path().len()..];
            if !name.contains('/') && check_name(name).is_ok() {
                result.push(BackupInfo {
                    name: name.into(),
                    size: resource.size,
                });
            }
        }
        result.sort_by(|a, b| b.name.cmp(&a.name));
        Ok(result)
    }
    pub async fn download(&self, name: &str, destination: &Path) -> Result<()> {
        check_name(name)?;
        let mut response = self
            .send(Method::GET, &self.object(name), None, None)
            .await?;
        if !response.status().is_success() {
            return Err(fail(format!(
                "Backup download returned HTTP {}",
                response.status().as_u16()
            )));
        }
        if response
            .content_length()
            .is_some_and(|size| size > MAX_BACKUP)
        {
            return Err(fail("Backup exceeds 4 GiB"));
        }
        let mut output = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(destination)?;
        let result = async {
            let mut total = 0;
            while let Some(chunk) = response.chunk().await? {
                total += chunk.len() as u64;
                if total > MAX_BACKUP {
                    return Err(fail("Backup exceeds 4 GiB"));
                }
                output.write_all(&chunk)?;
            }
            output.sync_all()?;
            Ok(())
        }
        .await;
        drop(output);
        if result.is_err() {
            let _ = std::fs::remove_file(destination);
        }
        result
    }
    pub async fn upload(&self, name: &str, source: &Path) -> Result<()> {
        check_name(name)?;
        self.test().await?;
        let response = self
            .send(
                Method::from_bytes(b"MKCOL").unwrap(),
                &self.folder(),
                None,
                None,
            )
            .await?;
        if !response.status().is_success() && response.status() != StatusCode::METHOD_NOT_ALLOWED {
            return Err(fail(format!(
                "Could not create backup folder: HTTP {}",
                response.status().as_u16()
            )));
        }
        let temporary = self.object(&format!("{name}.partial"));
        let size = std::fs::metadata(source)?.len();
        if size > MAX_BACKUP {
            return Err(fail("Backup exceeds 4 GiB"));
        }
        for attempt in 0..4 {
            let file = tokio::fs::File::open(source).await?;
            let response = self
                .client
                .put(temporary.clone())
                .basic_auth(&self.username, Some(self.password.as_str()))
                .header("Content-Length", size)
                .body(reqwest::Body::wrap_stream(ReaderStream::new(file)))
                .send()
                .await;
            match response {
                Ok(response) => {
                    let response = Self::checked(response)?;
                    if response.status().is_success() {
                        break;
                    }
                    if !response.status().is_server_error()
                        && response.status() != StatusCode::TOO_MANY_REQUESTS
                    {
                        return Err(fail(format!(
                            "Backup upload returned HTTP {}",
                            response.status().as_u16()
                        )));
                    }
                }
                Err(error) if attempt == 3 => return Err(error.into()),
                Err(_) => {}
            }
            if attempt == 3 {
                return Err(fail(
                    "Backup upload was interrupted. Retry; incomplete backups are not listed.",
                ));
            }
            tokio::time::sleep(Duration::from_millis(250 * (1 << attempt))).await;
        }
        let moved = self
            .client
            .request(Method::from_bytes(b"MOVE").unwrap(), temporary)
            .basic_auth(&self.username, Some(self.password.as_str()))
            .header("Destination", self.object(name).as_str())
            .header("Overwrite", "F")
            .send()
            .await;
        if let Ok(response) = moved {
            if Self::checked(response)?.status().is_success() {
                return Ok(());
            }
        }
        // A lost MOVE response can already have published the object. Verify bytes before reporting success.
        let temp = tempfile::TempDir::new()?;
        let verified = temp.path().join("verify.enc");
        self.download(name, &verified).await?;
        if crate::vault::hash_file(&verified)? != crate::vault::hash_file(source)? {
            return Err(fail(
                "The uploaded backup did not match. Retry; local notes are safe.",
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn webdav_round_trip_retries_and_only_lists_committed_encrypted_backups() {
        use std::{
            collections::HashMap,
            sync::{Arc, Mutex},
        };
        use tokio::{
            io::{AsyncReadExt, AsyncWriteExt},
            net::TcpListener,
        };
        #[derive(Default)]
        struct Store {
            files: HashMap<String, Vec<u8>>,
            folder: bool,
            retried: bool,
            lost_move: bool,
        }
        let store = Arc::new(Mutex::new(Store::default()));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server_store = store.clone();
        let server = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let mut buffer = [0; 8192];
                let header_end = loop {
                    let n = socket.read(&mut buffer).await.unwrap();
                    if n == 0 {
                        return;
                    }
                    request.extend_from_slice(&buffer[..n]);
                    if let Some(position) = request.windows(4).position(|b| b == b"\r\n\r\n") {
                        break position + 4;
                    }
                };
                let headers = String::from_utf8(request[..header_end].to_vec()).unwrap();
                let header = |name: &str| {
                    headers.lines().skip(1).find_map(|line| {
                        line.split_once(':')
                            .filter(|(key, _)| key.eq_ignore_ascii_case(name))
                            .map(|(_, value)| value.trim().to_string())
                    })
                };
                let size: usize = header("Content-Length")
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0);
                while request.len() < header_end + size {
                    let n = socket.read(&mut buffer).await.unwrap();
                    if n == 0 {
                        break;
                    }
                    request.extend_from_slice(&buffer[..n]);
                }
                let mut parts = headers.lines().next().unwrap().split_whitespace();
                let method = parts.next().unwrap();
                let path = parts.next().unwrap();
                let (status, body, extra, lose_response) = {
                    let mut state = server_store.lock().unwrap();
                    let mut status = "200 OK";
                    let mut body = Vec::new();
                    let mut extra = "";
                    let mut lose = false;
                    if header("Authorization").as_deref() != Some("Basic dXNlcjpwYXNz") {
                        status = "401 Unauthorized";
                    } else if path == "/redirect/" {
                        status = "302 Found";
                        extra = "Location: http://127.0.0.1:9/elsewhere\r\n";
                    } else {
                        match method {
                            "PROPFIND" => {
                                status = "207 Multi-Status";
                                let mut xml = format!("<d:multistatus xmlns:d='DAV:'><d:response><d:href>{path}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>");
                                if path != "/dav/" {
                                    for (file, bytes) in &state.files {
                                        xml.push_str(&format!("<d:response><d:href>{file}</d:href><d:propstat><d:prop><d:getcontentlength>{}</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>",bytes.len()));
                                    }
                                    xml.push_str("<d:response><d:href>https://untrusted.invalid/outside.wnbackup</d:href><d:propstat><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>");
                                }
                                xml.push_str("</d:multistatus>");
                                body = xml.into_bytes();
                            }
                            "HEAD" => {
                                if !state.folder {
                                    status = "404 Not Found";
                                }
                            }
                            "MKCOL" => {
                                status = if state.folder {
                                    "405 Method Not Allowed"
                                } else {
                                    "201 Created"
                                };
                                state.folder = true;
                            }
                            "PUT" => {
                                if !state.retried {
                                    state.retried = true;
                                    status = "503 Unavailable";
                                } else {
                                    state
                                        .files
                                        .insert(path.into(), request[header_end..].to_vec());
                                    status = "201 Created";
                                }
                            }
                            "MOVE" => {
                                let destination = Url::parse(&header("Destination").unwrap())
                                    .unwrap()
                                    .path()
                                    .to_string();
                                let data = state.files.remove(path).unwrap();
                                state.files.insert(destination, data);
                                status = "201 Created";
                                if !state.lost_move {
                                    state.lost_move = true;
                                    lose = true;
                                }
                            }
                            "GET" => {
                                if let Some(data) = state.files.get(path) {
                                    body = data.clone();
                                } else {
                                    status = "404 Not Found";
                                }
                            }
                            _ => status = "405 Method Not Allowed",
                        }
                    }
                    (status, body, extra, lose)
                };
                if lose_response {
                    let _ = socket.shutdown().await;
                    continue;
                }
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n",
                    body.len()
                );
                socket.write_all(response.as_bytes()).await.unwrap();
                socket.write_all(&body).await.unwrap();
            }
        });
        let settings = Settings {
            url: format!("http://{address}/dav/"),
            username: "user".into(),
        };
        let client = WebDav::loopback(&settings, Zeroizing::new("pass".into()));
        client.test().await.unwrap();
        assert!(client.list().await.unwrap().is_empty());
        let dir = tempfile::TempDir::new().unwrap();
        let mut vault = crate::vault::Vault::open(dir.path().join("vault")).unwrap();
        let note = vault.create_note("Private.md").unwrap();
        let note = vault
            .save_note(&note.id, "# PRIVATE-WEBDAV-TRANSPORT-TEST", &note.hash)
            .unwrap();
        let (config, key, _) = crate::crypto::create_vault("correct horse battery staple").unwrap();
        let archive = dir.path().join("snapshot.enc");
        crate::backup::create(&mut vault, &config, &key, &archive).unwrap();
        client.upload("123-test.wnbackup", &archive).await.unwrap();
        store.lock().unwrap().files.insert(
            "/dav/Wattle%20Notes%20Backups/incomplete.wnbackup.partial".into(),
            b"partial".to_vec(),
        );
        let backups = client.list().await.unwrap();
        assert_eq!(backups.len(), 1);
        assert_eq!(backups[0].name, "123-test.wnbackup");
        let downloaded = dir.path().join("download.enc");
        client
            .download(&backups[0].name, &downloaded)
            .await
            .unwrap();
        assert_eq!(
            std::fs::read(&downloaded).unwrap(),
            std::fs::read(&archive).unwrap()
        );
        assert!(
            !String::from_utf8_lossy(&std::fs::read(downloaded.clone()).unwrap())
                .contains("PRIVATE-WEBDAV-TRANSPORT-TEST")
        );
        let restored = crate::backup::restore(
            &downloaded,
            dir.path(),
            "correct horse battery staple",
            false,
        )
        .unwrap();
        assert_eq!(
            crate::vault::Vault::open(restored)
                .unwrap()
                .note(&note.id)
                .unwrap()
                .content,
            note.content
        );
        assert!(WebDav::loopback(&settings, Zeroizing::new("wrong".into()))
            .test()
            .await
            .unwrap_err()
            .to_string()
            .contains("rejected"));
        let redirected = Settings {
            url: format!("http://{address}/redirect/"),
            ..settings
        };
        assert!(WebDav::loopback(&redirected, Zeroizing::new("pass".into()))
            .test()
            .await
            .unwrap_err()
            .to_string()
            .contains("redirected"));
        server.abort();
    }
    #[test]
    fn endpoints_and_listings_are_bounded_and_scoped() {
        for url in [
            "http://cloud.test/dav/",
            "https://u:p@cloud.test/dav/",
            "https://cloud.test/dav/?token=secret",
        ] {
            assert!(endpoint(url).is_err());
        }
        assert_eq!(
            endpoint("https://cloud.test/nextcloud/remote.php/dav/files/user")
                .unwrap()
                .as_str(),
            "https://cloud.test/nextcloud/remote.php/dav/files/user/"
        );
        assert!(parse(b"<html>login</html>").is_err());
        assert!(parse(b"<!DOCTYPE x><d:multistatus xmlns:d='DAV:'/>").is_err());
        let xml = b"<d:multistatus xmlns:d='DAV:'><d:response><d:href>/dav/test.wnbackup</d:href><d:propstat><d:prop><d:getcontentlength>123</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>";
        let resources = parse(xml).unwrap();
        assert_eq!(resources[0].size, 123);
        assert!(resources[0].ok);
        assert!(check_name("../bad.wnbackup").is_err());
    }
}
