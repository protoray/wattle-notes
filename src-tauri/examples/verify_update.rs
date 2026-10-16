//! Release-time verification using the same signature library as Tauri's updater.
use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::{PublicKey, Signature};
use std::{env, error::Error, fs};

fn main() -> Result<(), Box<dyn Error>> {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.len() != 3 {
        return Err("Usage: verify_update TAURI_CONFIG ARCHIVE SIGNATURE".into());
    }
    let config: serde_json::Value = serde_json::from_slice(&fs::read(&args[0])?)?;
    let key = config["plugins"]["updater"]["pubkey"]
        .as_str()
        .ok_or("Missing updater public key")?;
    let key_text = String::from_utf8(STANDARD.decode(key)?)?;
    let signature_text = String::from_utf8(STANDARD.decode(fs::read_to_string(&args[2])?.trim())?)?;
    let public_key = PublicKey::decode(&key_text)?;
    let signature = Signature::decode(&signature_text)?;
    let mut bytes = fs::read(&args[1])?;
    public_key.verify(&bytes, &signature, true)?;
    let signed_version = signature
        .trusted_comment()
        .split('\t')
        .find_map(|field| field.strip_prefix("version:"));
    if signed_version != config["version"].as_str() {
        return Err("Signature version does not match the app version".into());
    }
    // The release gate must reject even a one-byte payload change.
    if bytes.is_empty() {
        return Err("Empty updater archive".into());
    }
    bytes[0] ^= 1;
    if public_key.verify(&bytes, &signature, true).is_ok() {
        return Err("Tampered updater payload incorrectly verified".into());
    }
    println!("Updater signature matches the embedded public key; tampered bytes rejected.");
    Ok(())
}
