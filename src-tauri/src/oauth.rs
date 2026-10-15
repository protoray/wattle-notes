use crate::{error::fail, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    time::{timeout, Duration},
};
use url::Url;
use zeroize::Zeroizing;

#[derive(Clone, Serialize, Deserialize)]
pub struct OAuthSettings {
    pub client_id: String,
    pub client_secret: Option<String>,
}
#[derive(Deserialize)]
pub struct Tokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_in: u64,
}

fn random() -> String {
    let mut data = [0; 32];
    OsRng.fill_bytes(&mut data);
    B64.encode(data)
}
pub fn authorization_url(
    settings: &OAuthSettings,
    redirect: &str,
    verifier: &str,
    state: &str,
) -> Result<Url> {
    if settings.client_id.trim().is_empty() {
        return Err(fail(
            "Set a Google Desktop OAuth client ID in Settings first",
        ));
    }
    let mut url = Url::parse("https://accounts.google.com/o/oauth2/v2/auth")
        .map_err(|_| fail("Invalid OAuth endpoint"))?;
    url.query_pairs_mut().extend_pairs([
        ("client_id", settings.client_id.as_str()),
        ("redirect_uri", redirect),
        ("response_type", "code"),
        ("scope", "https://www.googleapis.com/auth/drive.file"),
        (
            "code_challenge",
            &B64.encode(Sha256::digest(verifier.as_bytes())),
        ),
        ("code_challenge_method", "S256"),
        ("state", state),
        ("access_type", "offline"),
        ("prompt", "consent"),
    ]);
    Ok(url)
}

pub fn validate_callback(target: &str, expected_state: &str) -> Result<String> {
    let url = Url::parse(&format!("http://127.0.0.1{target}"))
        .map_err(|_| fail("Invalid OAuth callback"))?;
    if url.path() != "/oauth/callback" {
        return Err(fail("Unexpected authorization callback path"));
    }
    let values: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
    if values.get("state").map(String::as_str) != Some(expected_state) {
        return Err(fail("Authorization state mismatch"));
    }
    if values.contains_key("error") {
        return Err(fail("Google authorization was cancelled or refused"));
    }
    values
        .get("code")
        .filter(|s| !s.is_empty() && s.len() < 4096)
        .cloned()
        .ok_or_else(|| fail("No authorization code was received"))
}

pub async fn authorize(settings: &OAuthSettings) -> Result<Tokens> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let redirect = format!(
        "http://127.0.0.1:{}/oauth/callback",
        listener.local_addr()?.port()
    );
    let verifier = Zeroizing::new(random());
    let state = random();
    open::that(authorization_url(settings, &redirect, &verifier, &state)?.as_str())
        .map_err(|_| fail("Could not open the system browser"))?;
    let code = timeout(Duration::from_secs(180), async {
        loop {
            let (mut socket, _) = listener.accept().await?;
            let mut request = Vec::new(); let mut chunk = [0;1024];
            timeout(Duration::from_secs(5),async {
                while request.len() < 8192 {
                    let size = socket.read(&mut chunk).await?; if size == 0 { break; }
                    request.extend_from_slice(&chunk[..size]); if request.windows(4).any(|w| w == b"\r\n\r\n") { break; }
                }
                Ok::<(),std::io::Error>(())
            }).await.map_err(|_| fail("Authorization callback timed out"))??;
            let text = String::from_utf8_lossy(&request);
            let first = text.lines().next().unwrap_or_default(); let target = first.split_whitespace().nth(1).unwrap_or_default();
            let result = if first.starts_with("GET ") { validate_callback(target,&state) } else { Err(fail("Invalid callback method")) };
            let body = if result.is_ok() { "Authorization complete. You can close this window and return to Wattle Notes." } else { "This authorization callback was not accepted. Return to Wattle Notes." };
            let response = format!("HTTP/1.1 {}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{}",if result.is_ok() { "200 OK" } else { "400 Bad Request" },body.len(),body);
            socket.write_all(response.as_bytes()).await?;
            if result.is_ok() || text.contains("error=") { return result; }
        }
    }).await.map_err(|_| fail("Google sign-in timed out. Try connecting again."))??;
    let mut fields = vec![
        ("client_id", settings.client_id.clone()),
        ("code", code),
        ("code_verifier", verifier.to_string()),
        ("redirect_uri", redirect),
        ("grant_type", "authorization_code".into()),
    ];
    if let Some(secret) = &settings.client_secret {
        fields.push(("client_secret", secret.clone()));
    }
    token_request(&fields).await
}

pub async fn refresh(settings: &OAuthSettings, refresh_token: &str) -> Result<Tokens> {
    let mut fields = vec![
        ("client_id", settings.client_id.clone()),
        ("refresh_token", refresh_token.to_string()),
        ("grant_type", "refresh_token".into()),
    ];
    if let Some(secret) = &settings.client_secret {
        fields.push(("client_secret", secret.clone()));
    }
    token_request(&fields).await
}
async fn token_request(fields: &[(&str, String)]) -> Result<Tokens> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()?;
    let response = client
        .post("https://oauth2.googleapis.com/token")
        .form(fields)
        .send()
        .await?;
    if !response.status().is_success() {
        return Err(fail(
            "Google authorization expired or failed. Reconnect your account; local notes are safe.",
        ));
    }
    Ok(response.json().await?)
}

pub fn credential(name: &str) -> Result<keyring::Entry> {
    keyring::Entry::new("org.newnotes.desktop", name)
        .map_err(|_| fail("Operating-system credential storage is unavailable"))
}
pub fn store_secret(name: &str, value: &str) -> Result<()> {
    credential(name)?
        .set_password(value)
        .map_err(|_| fail("Cannot save to the operating-system credential store"))
}
pub fn load_secret(name: &str) -> Result<Option<Zeroizing<String>>> {
    match credential(name)?.get_password() {
        Ok(value) => Ok(Some(Zeroizing::new(value))),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err(fail("Cannot read operating-system credentials")),
    }
}
pub fn forget_secret(name: &str) -> Result<()> {
    match credential(name)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err(fail("Cannot remove operating-system credential")),
    }
}
