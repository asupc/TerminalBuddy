//! Antigravity（agy）多账号数据模型：本地加密凭据存储与前端脱敏视图。
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityAccountRecord {
    pub id: String,
    pub alias: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub picture: String,
    #[serde(default)]
    pub subject: String,
    /// `token` | `oauth` | `local_import`
    #[serde(default)]
    pub auth_source: String,
    /// 经 `crypto_service::encrypt_secret_field` 加密后的完整 OAuth token JSON。
    pub encrypted_token_json: String,
    #[serde(default)]
    pub has_refresh_token: bool,
    #[serde(default)]
    pub token_hint: String,
    #[serde(default)]
    pub updated_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityAccountStoreFile {
    #[serde(default)]
    pub accounts: Vec<AntigravityAccountRecord>,
    #[serde(default)]
    pub active_account_id: Option<String>,
}

/// 返回给前端的脱敏账号视图：绝不包含明文 token。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityAccountView {
    pub id: String,
    pub alias: String,
    pub email: String,
    pub name: String,
    pub picture: String,
    pub auth_source: String,
    pub has_refresh_token: bool,
    pub token_hint: String,
    pub updated_at: String,
    pub is_default: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityAccountState {
    pub accounts: Vec<AntigravityAccountView>,
    pub active_account_id: Option<String>,
}

/// 手动录入授权 Token 或编辑账号别名的输入载荷。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityTokenInput {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub alias: Option<String>,
    /// 支持完整 `antigravity-oauth-token` JSON、Google `access_token`、`id_token` 或 `refresh_token`。
    #[serde(default)]
    pub token: Option<String>,
    #[serde(default)]
    pub client_id: Option<String>,
    #[serde(default)]
    pub client_secret: Option<String>,
}

/// 通过 `agy acp --login` 发起浏览器 OAuth 授权后返回给前端的会话信息。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityOAuthStartResult {
    pub login_id: String,
    pub auth_url: String,
}

/// 完成浏览器 OAuth 授权时的输入参数。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityOAuthCompleteInput {
    pub login_id: String,
    pub code: String,
    #[serde(default)]
    pub alias: Option<String>,
}
