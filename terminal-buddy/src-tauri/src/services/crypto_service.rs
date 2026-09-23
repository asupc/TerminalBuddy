use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use windows::Win32::Foundation::{LocalFree, HLOCAL};
use windows::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
};

/// Encrypt plaintext using Windows DPAPI (per-user scope).
/// Returns encrypted bytes, or error string on failure.
///
/// Safety：`CRYPT_INTEGER_BLOB.pbData` 在 Win32 契约中是**只读输入**
/// （CryptProtectData / CryptUnprotectData 不会写这块缓冲），所以把
/// `&[u8]` 的指针转成 `*mut u8` 传进去是安全的；输出缓冲的指针由 API
/// 分配、用 `LocalFree` 释放。
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
///
/// Safety 注释同 [`dpapi_encrypt`]。
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
    Ok(BASE64_STANDARD.encode(encrypted))
}

/// Decrypt a Base64-encoded DPAPI blob back to a string.
pub fn decrypt_string(encoded: &str) -> Result<String, String> {
    if encoded.is_empty() {
        return Ok(String::new());
    }
    let decrypted = dpapi_decrypt(&BASE64_STANDARD
        .decode(encoded)
        .map_err(|e| format!("Base64 decode failed: {}", e))?)?;
    String::from_utf8(decrypted).map_err(|e| format!("UTF-8 decode failed: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 标准 Base64、padding、空值行为明确。
    #[test]
    fn base64_round_trip_and_empty_values() {
        // 空字符串：encrypt 返回空密文（无 Base64 内容），decrypt 空串得到空串
        assert_eq!(encrypt_string("").unwrap(), "");
        assert_eq!(decrypt_string("").unwrap(), "");
        // 可打印 ASCII / 中文 / 含换行制表符的内容都能往返
        for plaintext in ["hello world", "中文密码！@#", "line\nbreak\ttab"] {
            let encoded = encrypt_string(plaintext).unwrap();
            assert_eq!(decrypt_string(&encoded).unwrap(), plaintext);
        }
    }

    /// 长度 1（非法 4k 余 1）、错误 padding、非法字符全部返回 Err（严格解码器）。
    #[test]
    fn strict_base64_rejects_malformed_input() {
        assert!(decrypt_string("a").is_err(), "len%4==1 必须被拒绝");
        assert!(decrypt_string("abc=d").is_err(), "中间 padding 必须被拒绝");
        assert!(decrypt_string("ab&&").is_err(), "非法字符必须被拒绝");
        assert!(decrypt_string("!!!!").is_err(), "全非法字符必须被拒绝");
    }

    /// DPAPI 加密/解密正常往返（per-user scope，本用户进程内可解）。
    #[test]
    fn dpapi_round_trip() {
        let plaintext = b"dpapi-round-trip-secret";
        let encrypted = dpapi_encrypt(plaintext).unwrap();
        assert_ne!(encrypted, plaintext.to_vec());
        assert_eq!(dpapi_decrypt(&encrypted).unwrap(), plaintext.to_vec());
        assert_eq!(dpapi_encrypt(b"").unwrap(), Vec::<u8>::new());
        assert_eq!(dpapi_decrypt(b"").unwrap(), Vec::<u8>::new());
    }
}
