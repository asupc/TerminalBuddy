use windows::Win32::Foundation::{HLOCAL, LocalFree};
use windows::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN,
};

/// Encrypt plaintext using Windows DPAPI (per-user scope).
/// Returns encrypted bytes, or error string on failure.
pub fn dpapi_encrypt(plaintext: &[u8]) -> Result<Vec<u8>, String> {
    if plaintext.is_empty() {
        return Ok(Vec::new());
    }

    let mut blob_in = CRYPT_INTEGER_BLOB {
        cbData: plaintext.len() as u32,
        pbData: plaintext.as_ptr() as *mut u8,
    };
    let mut blob_out = CRYPT_INTEGER_BLOB::default();

    unsafe {
        CryptProtectData(
            &mut blob_in,
            windows::core::PCWSTR::null(),
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut blob_out,
        )
        .map_err(|e| format!("DPAPI encrypt failed: {}", e))?;

        let result = std::slice::from_raw_parts(blob_out.pbData, blob_out.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(blob_out.pbData as *mut _)));
        Ok(result)
    }
}

/// Decrypt DPAPI-encrypted bytes back to plaintext.
/// Returns decrypted bytes, or error string on failure.
pub fn dpapi_decrypt(ciphertext: &[u8]) -> Result<Vec<u8>, String> {
    if ciphertext.is_empty() {
        return Ok(Vec::new());
    }

    let mut blob_in = CRYPT_INTEGER_BLOB {
        cbData: ciphertext.len() as u32,
        pbData: ciphertext.as_ptr() as *mut u8,
    };
    let mut blob_out = CRYPT_INTEGER_BLOB::default();

    unsafe {
        CryptUnprotectData(
            &mut blob_in,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut blob_out,
        )
        .map_err(|e| format!("DPAPI decrypt failed: {}", e))?;

        let result = std::slice::from_raw_parts(blob_out.pbData, blob_out.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(blob_out.pbData as *mut _)));
        Ok(result)
    }
}

/// Encrypt a string to a Base64-encoded DPAPI blob.
pub fn encrypt_string(plaintext: &str) -> Result<String, String> {
    let encrypted = dpapi_encrypt(plaintext.as_bytes())?;
    Ok(base64_encode(&encrypted))
}

/// Decrypt a Base64-encoded DPAPI blob back to a string.
pub fn decrypt_string(encoded: &str) -> Result<String, String> {
    if encoded.is_empty() {
        return Ok(String::new());
    }
    let decrypted = dpapi_decrypt(&base64_decode(encoded)?)?;
    String::from_utf8(decrypted).map_err(|e| format!("UTF-8 decode failed: {}", e))
}

/// Check if a string is a DPAPI-encrypted value (Base64 encoded, not empty).
pub fn is_encrypted(value: &str) -> bool {
    if value.is_empty() {
        return false;
    }
    // DPAPI encrypted values are Base64 encoded and typically longer than plaintext
    // Heuristic: try to decrypt and see if it succeeds
    base64_decode(value).is_ok()
}

// Minimal Base64 encode/decode (no external dependency)
const BASE64_CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64_encode(data: &[u8]) -> String {
    let mut result = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let triple = (b0 << 16) | (b1 << 8) | b2;
        result.push(BASE64_CHARS[((triple >> 18) & 0x3F) as usize] as char);
        result.push(BASE64_CHARS[((triple >> 12) & 0x3F) as usize] as char);
        if chunk.len() > 1 {
            result.push(BASE64_CHARS[((triple >> 6) & 0x3F) as usize] as char);
        } else {
            result.push('=');
        }
        if chunk.len() > 2 {
            result.push(BASE64_CHARS[(triple & 0x3F) as usize] as char);
        } else {
            result.push('=');
        }
    }
    result
}

fn base64_decode(encoded: &str) -> Result<Vec<u8>, String> {
    let encoded = encoded.trim_end_matches('=');
    if encoded.is_empty() {
        return Ok(Vec::new());
    }

    let mut lookup = [255u8; 256];
    for (i, &c) in BASE64_CHARS.iter().enumerate() {
        lookup[c as usize] = i as u8;
    }

    let mut result = Vec::with_capacity(encoded.len() * 3 / 4);
    let bytes = encoded.as_bytes();
    for chunk in bytes.chunks(4) {
        let mut buf = [0u8; 4];
        for (i, &b) in chunk.iter().enumerate() {
            buf[i] = lookup[b as usize];
            if buf[i] == 255 {
                return Err("Invalid Base64 character".to_string());
            }
        }
        let b0 = (buf[0] as u32) << 18;
        let b1 = (buf[1] as u32) << 12;
        let b2 = (buf.get(2).copied().unwrap_or(0) as u32) << 6;
        let b3 = buf.get(3).copied().unwrap_or(0) as u32;
        let triple = b0 | b1 | b2 | b3;
        result.push((triple >> 16) as u8);
        if chunk.len() > 2 {
            result.push((triple >> 8) as u8);
        }
        if chunk.len() > 3 {
            result.push(triple as u8);
        }
    }
    Ok(result)
}
