use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum::http::StatusCode;
use chrono::{Duration, Utc};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String, // username
    pub exp: usize,  // expiry
    pub iat: usize,  // issued at
}

/// Trait for state types that can provide a JWT secret.
pub trait HasJwtSecret {
    fn jwt_secret(&self) -> &str;
}

/// 登录有效期（天）：30 天。只要在有效期内，重启服务 / 重建容器都不会让已登录的会话失效，
/// 用户不会因为服务端重启而被反复要求重新登录。
pub const TOKEN_TTL_DAYS: i64 = 30;

/// 用给定密钥签发一个有效期为 TOKEN_TTL_DAYS 天的 JWT。
/// 密钥来自 load_or_create_jwt_secret（落盘持久化）。
pub fn generate_jwt(username: &str, secret: &str) -> Result<String, String> {
    let now = Utc::now();
    let claims = Claims {
        sub: username.to_string(),
        iat: now.timestamp() as usize,
        exp: (now + Duration::days(TOKEN_TTL_DAYS)).timestamp() as usize,
    };
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|e| format!("JWT 生成失败: {}", e))
}

pub fn verify_token(token: &str, secret: &str) -> Result<Claims, StatusCode> {
    decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &Validation::default(),
    )
    .map(|data| data.claims)
    .map_err(|_| StatusCode::UNAUTHORIZED)
}

fn extract_bearer_token(auth_header: Option<&str>) -> Result<&str, StatusCode> {
    let header = auth_header.ok_or(StatusCode::UNAUTHORIZED)?;
    header
        .strip_prefix("Bearer ")
        .ok_or(StatusCode::UNAUTHORIZED)
}

/// Axum extractor for JWT claims.
/// Requires the application state to implement `HasJwtSecret`.
pub struct ClaimsFromRequest(pub Claims);

impl<S> FromRequestParts<S> for ClaimsFromRequest
where
    S: HasJwtSecret + Send + Sync,
{
    type Rejection = StatusCode;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let auth_header = parts
            .headers
            .get("Authorization")
            .and_then(|v| v.to_str().ok());

        let token = extract_bearer_token(auth_header)?;
        let claims = verify_token(token, state.jwt_secret())?;
        Ok(ClaimsFromRequest(claims))
    }
}

/// 生成一个随机的 256 位密钥（仅用于首次创建 jwt.key）。
fn random_jwt_secret() -> String {
    use rand::Rng;
    let bytes: [u8; 32] = rand::thread_rng().gen();
    hex::encode(bytes)
}

/// 读取持久化的 JWT 签名密钥，不存在时创建（`<数据目录>/jwt.key`）。
///
/// 这是「重启服务 / 重建容器后仍保持登录」的关键：密钥落盘后，之前签发的
/// token 重启后依然能验签通过。此前的实现每次启动都随机生成密钥，导致服务
/// 一重启，所有已登录设备立刻被强制退出。
///
/// 密钥在进程内缓存，因此同一进程内反复重启 HTTP 服务也复用同一个值。
/// 密钥文件损坏时**不**静默换新密钥（那会踢掉所有设备），而是明确报错。
pub fn load_or_create_jwt_secret() -> Result<String, String> {
    use std::sync::{Mutex, OnceLock};

    static SECRET: OnceLock<String> = OnceLock::new();
    static LOCK: Mutex<()> = Mutex::new(());

    if let Some(secret) = SECRET.get() {
        return Ok(secret.clone());
    }
    let _guard = LOCK.lock().map_err(|_| "密钥初始化锁不可用".to_string())?;
    if let Some(secret) = SECRET.get() {
        return Ok(secret.clone());
    }

    let path = crate::services::PathService::require_data_dir()?.join("jwt.key");
    let secret = match std::fs::read_to_string(&path) {
        Ok(content) => {
            let trimmed = content.trim().to_string();
            // 只接受 64 位十六进制（32 字节）
            if trimmed.len() != 64 || !trimmed.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err(format!(
                    "JWT 密钥文件已损坏：{}。请恢复备份，或删除该文件后重新登录。",
                    path.display()
                ));
            }
            trimmed
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let fresh = random_jwt_secret();
            crate::services::atomic_write_private(&path, fresh.as_bytes())
                .map_err(|e| format!("写入 JWT 密钥文件失败: {}", e))?;
            fresh
        }
        Err(error) => return Err(format!("读取 JWT 密钥文件失败: {}", error)),
    };
    let _ = SECRET.set(secret.clone());
    Ok(secret)
}

#[cfg(not(feature = "desktop"))]
pub fn validate_admin_password(password: &str) -> Result<(), String> {
    if password.trim().is_empty() || password.chars().count() < 8 {
        return Err("管理员密码至少需要 8 个字符".to_string());
    }
    // bcrypt 只处理前 72 字节，拒绝过长输入，避免不同密码被当作同一个密码。
    if password.len() > 72 {
        return Err("管理员密码过长，请缩短后重试".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 登录有效期必须是 TOKEN_TTL_DAYS（30）天，而不是旧的 24 小时。
    /// 这是用户可见行为，回归时必须失败而不是悄悄缩短。
    #[test]
    fn token_expiry_matches_configured_ttl() {
        let secret = "test-secret";
        let token = generate_jwt("admin", secret).unwrap();
        let claims = verify_token(&token, secret).unwrap();

        assert_eq!(claims.sub, "admin");
        let lifetime_secs = claims.exp as i64 - claims.iat as i64;
        assert_eq!(
            lifetime_secs,
            TOKEN_TTL_DAYS * 24 * 60 * 60,
            "登录有效期应为 {} 天（{} 秒），实际 {} 秒",
            TOKEN_TTL_DAYS,
            TOKEN_TTL_DAYS * 24 * 60 * 60,
            lifetime_secs
        );
        assert!(
            TOKEN_TTL_DAYS >= 30,
            "有效期不得短于用户要求的 30 天"
        );
    }

    /// 换密钥必须验签失败（这是重启后依然有效的反面：密钥不一致才该失效）。
    #[test]
    fn verify_rejects_foreign_secret_and_malformed_token() {
        let token = generate_jwt("admin", "secret-a").unwrap();
        assert!(verify_token(&token, "secret-b").is_err());
        assert!(verify_token("not-a-jwt", "secret-a").is_err());
        assert!(verify_token("", "secret-a").is_err());
    }
}
