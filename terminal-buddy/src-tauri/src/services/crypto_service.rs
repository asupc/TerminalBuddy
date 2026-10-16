use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
#[cfg(windows)]
use windows::Win32::Foundation::{LocalFree, HLOCAL};
#[cfg(windows)]
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
#[cfg(windows)]
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
#[cfg(windows)]
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
    #[cfg(not(feature = "desktop"))]
    { return server_crypto::encrypt(plaintext); }
    #[cfg(feature = "desktop")]
    {
    let encrypted = dpapi_encrypt(plaintext.as_bytes())?;
    Ok(BASE64_STANDARD.encode(encrypted))
    }
}

/// 落盘密钥字段的通用封装：桌面端 `dpapi:<base64>`，服务端 `aesgcm:v1:<base64>`。
/// 空明文落为空密文（`marker` + 空串），调用方用空表示"未设置"。
pub fn encrypt_secret_field(plaintext: &str) -> Result<String, String> {
    let marker = if cfg!(feature = "desktop") { "dpapi:" } else { "aesgcm:" };
    Ok(format!("{}{}", marker, encrypt_string(plaintext)?))
}

/// 解析 [`encrypt_secret_field`] 写入的密文；无 marker 的旧值原样返回明文。
pub fn decrypt_secret_field(value: &str) -> Result<String, String> {
    if let Some(encoded) = value
        .strip_prefix("dpapi:")
        .or_else(|| value.strip_prefix("aesgcm:"))
    {
        decrypt_string(encoded)
    } else {
        Ok(value.to_string())
    }
}

/// Decrypt a Base64-encoded DPAPI blob back to a string.
pub fn decrypt_string(encoded: &str) -> Result<String, String> {
    #[cfg(not(feature = "desktop"))]
    { return server_crypto::decrypt(encoded); }
    #[cfg(feature = "desktop")]
    {
    if encoded.is_empty() {
        return Ok(String::new());
    }
    let decrypted = dpapi_decrypt(&BASE64_STANDARD
        .decode(encoded)
        .map_err(|e| format!("Base64 decode failed: {}", e))?)?;
    String::from_utf8(decrypted).map_err(|e| format!("UTF-8 decode failed: {}", e))
    }
}

#[cfg(not(feature = "desktop"))]
mod server_crypto {
    use super::*;
    use aes_gcm::{Aes256Gcm, KeyInit, Nonce, aead::Aead};
    use rand::RngCore;
    use std::{io::{Read, Write}, sync::OnceLock};

    fn key() -> Result<[u8; 32], String> {
        static KEY: OnceLock<[u8; 32]> = OnceLock::new();
        static KEY_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _guard = KEY_LOCK.lock().map_err(|_| "密钥初始化锁不可用".to_string())?;
        if let Some(key) = KEY.get() { return Ok(*key); }
        let path = crate::services::PathService::require_data_dir()?.join("server.key");
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
        let mut bytes = [0u8; 32];
        match options.open(&path) {
            Ok(mut file) => {
                rand::thread_rng().fill_bytes(&mut bytes);
                file.write_all(&bytes).and_then(|_| file.sync_all()).map_err(|e| e.to_string())?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
                if file.metadata().map_err(|e| e.to_string())?.len() != 32 {
                    return Err("服务端加密密钥长度错误，请恢复 server.key 备份".to_string());
                }
                file.read_exact(&mut bytes).map_err(|e| e.to_string())?;
            }
            Err(e) => return Err(e.to_string()),
        }
        let _ = KEY.set(bytes);
        Ok(*KEY.get().expect("密钥已初始化"))
    }

    pub fn encrypt(text: &str) -> Result<String, String> {
        if text.is_empty() { return Ok(String::new()); }
        let cipher = Aes256Gcm::new_from_slice(&key()?).map_err(|e| e.to_string())?;
        let mut nonce = [0u8; 12];
        rand::thread_rng().fill_bytes(&mut nonce);
        let encrypted = cipher.encrypt(Nonce::from_slice(&nonce), text.as_bytes()).map_err(|e| e.to_string())?;
        let mut bytes = nonce.to_vec();
        bytes.extend(encrypted);
        Ok(format!("v1:{}", BASE64_STANDARD.encode(bytes)))
    }

    pub fn decrypt(text: &str) -> Result<String, String> {
        if text.is_empty() { return Ok(String::new()); }
        let encoded = text.strip_prefix("v1:").ok_or("Windows DPAPI 密码无法在服务端解密，请重新录入密码")?;
        let bytes = BASE64_STANDARD.decode(encoded).map_err(|e| e.to_string())?;
        if bytes.len() < 28 { return Err("密码密文长度错误".to_string()); }
        let cipher = Aes256Gcm::new_from_slice(&key()?).map_err(|e| e.to_string())?;
        let plaintext = cipher.decrypt(Nonce::from_slice(&bytes[..12]), &bytes[12..]).map_err(|_| "密码解密失败，请检查 server.key".to_string())?;
        String::from_utf8(plaintext).map_err(|e| e.to_string())
    }
}

#[cfg(all(test, windows, feature = "desktop"))]
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
