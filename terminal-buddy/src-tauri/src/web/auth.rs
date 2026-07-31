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

pub fn generate_jwt(username: &str, secret: &str) -> Result<String, String> {
    let now = Utc::now();
    let claims = Claims {
        sub: username.to_string(),
        iat: now.timestamp() as usize,
        exp: (now + Duration::hours(24)).timestamp() as usize,
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

/// Generate a random 256-bit secret for JWT signing.
pub fn generate_jwt_secret() -> String {
    use rand::Rng;
    let bytes: [u8; 32] = rand::thread_rng().gen();
    hex::encode(bytes)
}
