use crate::{error::fail, paths::MAX_ATTACHMENT, Result};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use zeroize::Zeroizing;

pub struct VaultKey(pub Zeroizing<[u8; 32]>);
impl Clone for VaultKey {
    fn clone(&self) -> Self {
        Self(Zeroizing::new(*self.0))
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Identity {
    pub version: u32,
    pub vault_id: String,
    pub item_id: String,
    pub revision_id: String,
    pub purpose: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    magic: String,
    identity: Identity,
    nonce: String,
    ciphertext: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VaultConfig {
    pub version: u32,
    pub vault_id: String,
    pub salt: String,
    pub memory_kib: u32,
    pub iterations: u32,
    pub lanes: u32,
    pub passphrase_key: String,
    pub recovery_key: String,
}

pub fn random_key() -> VaultKey {
    let mut key = [0u8; 32];
    OsRng.fill_bytes(&mut key);
    VaultKey(Zeroizing::new(key))
}
fn decode(value: &str) -> Result<Vec<u8>> {
    B64.decode(value)
        .map_err(|_| fail("Invalid encrypted file encoding"))
}
fn cipher(key: &VaultKey) -> XChaCha20Poly1305 {
    XChaCha20Poly1305::new((&*key.0).into())
}
pub fn identity(vault: &str, item: &str, revision: &str, purpose: &str) -> Identity {
    Identity {
        version: 1,
        vault_id: vault.into(),
        item_id: item.into(),
        revision_id: revision.into(),
        purpose: purpose.into(),
    }
}

pub fn seal(key: &VaultKey, id: &Identity, plaintext: &[u8]) -> Result<Vec<u8>> {
    if plaintext.len() > 24 * 1024 * 1024 - 8192 {
        return Err(fail(
            "Encrypted metadata exceeds the supported payload limit; the local note was preserved",
        ));
    }
    let mut nonce = [0; 24];
    OsRng.fill_bytes(&mut nonce);
    let aad = serde_json::to_vec(id)?;
    let encrypted = cipher(key)
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad: &aad,
            },
        )
        .map_err(|_| fail("Encryption failed"))?;
    Ok(serde_json::to_vec(&Envelope {
        magic: "NEWNOTES1".into(),
        identity: id.clone(),
        nonce: B64.encode(nonce),
        ciphertext: B64.encode(encrypted),
    })?)
}

pub fn unseal(key: &VaultKey, expected: &Identity, encrypted: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    if encrypted.len() > 32 * 1024 * 1024 {
        return Err(fail("Encrypted metadata exceeds the size limit"));
    }
    let envelope: Envelope = serde_json::from_slice(encrypted)?;
    if envelope.magic != "NEWNOTES1"
        || envelope.identity != *expected
        || envelope.identity.version != 1
    {
        return Err(fail("Encrypted object identity or version does not match"));
    }
    let nonce = decode(&envelope.nonce)?;
    if nonce.len() != 24 {
        return Err(fail("Invalid encryption nonce"));
    }
    let aad = serde_json::to_vec(expected)?;
    let encrypted = decode(&envelope.ciphertext)?;
    cipher(key)
        .decrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &encrypted,
                aad: &aad,
            },
        )
        .map(Zeroizing::new)
        .map_err(|_| fail("Cannot decrypt: incorrect key or damaged encrypted data"))
}

fn derive(config: &VaultConfig, passphrase: &str) -> Result<VaultKey> {
    if config.version != 1
        || config.memory_kib != 65536
        || config.iterations != 3
        || config.lanes != 1
    {
        return Err(fail(
            "Unsupported vault format or unsafe password parameters",
        ));
    }
    let salt = decode(&config.salt)?;
    if salt.len() != 16 {
        return Err(fail("Invalid password salt"));
    }
    let parameters = Params::new(config.memory_kib, config.iterations, config.lanes, Some(32))
        .map_err(|_| fail("Invalid password parameters"))?;
    let mut key = Zeroizing::new([0u8; 32]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, parameters)
        .hash_password_into(passphrase.as_bytes(), &salt, &mut *key)
        .map_err(|_| fail("Password derivation failed"))?;
    Ok(VaultKey(key))
}

pub fn create_vault(passphrase: &str) -> Result<(VaultConfig, VaultKey, String)> {
    if passphrase.chars().count() < 12 {
        return Err(fail("Choose a passphrase of at least 12 characters"));
    }
    let mut salt = [0; 16];
    OsRng.fill_bytes(&mut salt);
    let master = random_key();
    let recovery = random_key();
    let mut config = VaultConfig {
        version: 1,
        vault_id: uuid::Uuid::new_v4().to_string(),
        salt: B64.encode(salt),
        memory_kib: 65536,
        iterations: 3,
        lanes: 1,
        passphrase_key: String::new(),
        recovery_key: String::new(),
    };
    let wrapping = derive(&config, passphrase)?;
    config.passphrase_key = B64.encode(seal(
        &wrapping,
        &identity(&config.vault_id, "vault-key", "setup", "passphrase"),
        &*master.0,
    )?);
    config.recovery_key = B64.encode(seal(
        &recovery,
        &identity(&config.vault_id, "vault-key", "setup", "recovery"),
        &*master.0,
    )?);
    Ok((config, master, format!("NN1-{}", hex::encode(*recovery.0))))
}

pub fn unlock(config: &VaultConfig, secret: &str, recovery: bool) -> Result<VaultKey> {
    let (wrapping, envelope, purpose) = if recovery {
        let raw = Zeroizing::new(
            hex::decode(secret.trim().strip_prefix("NN1-").unwrap_or(secret.trim()))
                .map_err(|_| fail("Invalid recovery key"))?,
        );
        let value: [u8; 32] = raw
            .as_slice()
            .try_into()
            .map_err(|_| fail("Invalid recovery key length"))?;
        (
            VaultKey(Zeroizing::new(value)),
            &config.recovery_key,
            "recovery",
        )
    } else {
        (
            derive(config, secret)?,
            &config.passphrase_key,
            "passphrase",
        )
    };
    if config.version != 1 {
        return Err(fail("Unsupported vault format"));
    }
    let data = unseal(
        &wrapping,
        &identity(&config.vault_id, "vault-key", "setup", purpose),
        &decode(envelope)?,
    )?;
    let key: [u8; 32] = data
        .as_slice()
        .try_into()
        .map_err(|_| fail("Invalid vault key"))?;
    Ok(VaultKey(Zeroizing::new(key)))
}

// Bounded-memory framing. Each frame authenticates the object, index and final flag.
const CHUNK: usize = 64 * 1024;
pub fn seal_stream(
    key: &VaultKey,
    id: &Identity,
    mut input: impl Read,
    mut output: impl Write,
) -> Result<()> {
    let header = serde_json::to_vec(id)?;
    if header.len() > 4096 {
        return Err(fail("Attachment identity is too long"));
    }
    output.write_all(b"NNSTREAM1\n")?;
    output.write_all(&(header.len() as u32).to_le_bytes())?;
    output.write_all(&header)?;
    let mut current = Zeroizing::new(vec![0; CHUNK]);
    let mut next = Zeroizing::new(vec![0; CHUNK]);
    let mut used = read_chunk(&mut input, &mut current)?;
    let mut index = 0u64;
    let mut total = used as u64;
    loop {
        let following = read_chunk(&mut input, &mut next)?;
        total += following as u64;
        if total > MAX_ATTACHMENT {
            return Err(fail("Attachments are limited to 100 MiB"));
        }
        let final_flag = u8::from(following == 0);
        let mut aad = header.clone();
        aad.extend_from_slice(&index.to_le_bytes());
        aad.push(final_flag);
        let mut nonce = [0; 24];
        OsRng.fill_bytes(&mut nonce);
        let encrypted = cipher(key)
            .encrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: &current[..used],
                    aad: &aad,
                },
            )
            .map_err(|_| fail("Attachment encryption failed"))?;
        output.write_all(&[final_flag])?;
        output.write_all(&(encrypted.len() as u32).to_le_bytes())?;
        output.write_all(&nonce)?;
        output.write_all(&encrypted)?;
        if final_flag == 1 {
            break;
        }
        std::mem::swap(&mut current, &mut next);
        used = following;
        index += 1;
    }
    Ok(())
}
fn read_chunk(input: &mut impl Read, buffer: &mut [u8]) -> Result<usize> {
    let mut size = 0;
    while size < buffer.len() {
        let n = input.read(&mut buffer[size..])?;
        if n == 0 {
            break;
        }
        size += n;
    }
    Ok(size)
}
pub fn unseal_stream(
    key: &VaultKey,
    expected: &Identity,
    mut input: impl Read,
    mut output: impl Write,
) -> Result<()> {
    let mut magic = [0; 10];
    input.read_exact(&mut magic)?;
    if &magic != b"NNSTREAM1\n" {
        return Err(fail("Unsupported attachment format"));
    }
    let mut size = [0; 4];
    input.read_exact(&mut size)?;
    let length = u32::from_le_bytes(size) as usize;
    if length > 4096 {
        return Err(fail("Attachment header exceeds its limit"));
    }
    let mut header = vec![0; length];
    input.read_exact(&mut header)?;
    if serde_json::from_slice::<Identity>(&header)? != *expected || expected.version != 1 {
        return Err(fail("Attachment identity does not match"));
    }
    let mut index = 0u64;
    let mut total = 0u64;
    loop {
        let mut flag = [0];
        input.read_exact(&mut flag)?;
        if flag[0] > 1 {
            return Err(fail("Invalid attachment frame"));
        }
        input.read_exact(&mut size)?;
        let length = u32::from_le_bytes(size) as usize;
        if !(16..=CHUNK + 16).contains(&length) {
            return Err(fail("Attachment frame exceeds its limit"));
        }
        let mut nonce = [0; 24];
        input.read_exact(&mut nonce)?;
        let mut encrypted = vec![0; length];
        input.read_exact(&mut encrypted)?;
        let mut aad = header.clone();
        aad.extend_from_slice(&index.to_le_bytes());
        aad.push(flag[0]);
        let plaintext = Zeroizing::new(
            cipher(key)
                .decrypt(
                    XNonce::from_slice(&nonce),
                    Payload {
                        msg: &encrypted,
                        aad: &aad,
                    },
                )
                .map_err(|_| fail("Attachment is damaged or uses an incorrect key"))?,
        );
        total += plaintext.len() as u64;
        if total > MAX_ATTACHMENT {
            return Err(fail("Attachment exceeds 100 MiB"));
        }
        output.write_all(&plaintext)?;
        if flag[0] == 1 {
            let mut trailing = [0];
            if input.read(&mut trailing)? != 0 {
                return Err(fail("Unexpected data after attachment end"));
            }
            break;
        }
        index += 1;
    }
    Ok(())
}
