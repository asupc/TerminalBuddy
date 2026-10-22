//! Docker 网页端的自定义 Claude 供应商。数据库保存加密配置，切换时投影到 settings.json。
use std::{collections::BTreeMap, fs, path::{Path, PathBuf}};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use super::{atomic_write_private, decrypt_string, encrypt_string, DatabaseService};
use super::claude_hook_settings::{claude_settings_write_lock, resolve_claude_config_dir};

#[derive(Debug)]
pub enum ProviderError {
    Invalid(String),
    NotFound,
    Conflict(String),
    Storage(String),
}
impl From<String> for ProviderError {
    fn from(error: String) -> Self { Self::Storage(error) }
}
type Result<T> = std::result::Result<T, ProviderError>;

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderInput {
    pub name: String,
    pub base_url: String,
    #[serde(default = "default_auth")]
    pub auth_type: String,
    /// 编辑时 null / 省略表示沿用已保存的密钥，绝不把掩码写入 Claude 配置。
    pub api_key: Option<String>,
    #[serde(default)] pub model: String,
    #[serde(default)] pub opus_model: String,
    #[serde(default)] pub sonnet_model: String,
    #[serde(default)] pub haiku_model: String,
    #[serde(default)] pub extra_env: BTreeMap<String, String>,
}
fn default_auth() -> String { "ANTHROPIC_AUTH_TOKEN".into() }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderView {
    id: String,
    #[serde(flatten)] config: ProviderInput,
    has_api_key: bool,
    updated_at: i64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderList {
    providers: Vec<ProviderView>,
    active_provider_id: Option<String>,
    applied: bool,
    can_import: bool,
}

const CORE_ENV: &[&str] = &[
    "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL",
];
const EXTRA_ENV: &[&str] = &[
    "API_TIMEOUT_MS", "MAX_THINKING_TOKENS", "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS",
    "DISABLE_NON_ESSENTIAL_MODEL_CALLS",
];
const TOP_KEYS: &[&str] = &["model", "apiKeyHelper", "apiKey"];
fn managed_env(key: &str) -> bool {
    key.starts_with("ANTHROPIC_") || EXTRA_ENV.contains(&key)
        || matches!(key, "CLAUDE_CODE_USE_BEDROCK" | "CLAUDE_CODE_USE_VERTEX" | "CLAUDE_CODE_USE_FOUNDRY" | "AWS_BEARER_TOKEN_BEDROCK")
}
fn allowed_extra(key: &str) -> bool {
    EXTRA_ENV.contains(&key) || (key.starts_with("ANTHROPIC_") && !CORE_ENV.contains(&key)
        && !["AUTH", "KEY", "TOKEN", "HEADER", "BASE_URL"].iter().any(|part| key.contains(part)))
}
fn invalid(message: &str) -> ProviderError { ProviderError::Invalid(message.into()) }
fn db_error(error: rusqlite::Error) -> ProviderError { ProviderError::Storage(format!("模型配置数据库操作失败: {error}")) }

impl ProviderInput {
    fn validate(mut self, previous: Option<&Self>) -> Result<Self> {
        self.name = self.name.trim().into();
        self.base_url = self.base_url.trim().trim_end_matches('/').into();
        if self.name.is_empty() || self.name.chars().count() > 80 || self.name.chars().any(char::is_control) {
            return Err(invalid("配置名称不能为空，且不能超过 80 个字符"));
        }
        let url = reqwest::Url::parse(&self.base_url).map_err(|_| invalid("请输入有效的 HTTP 或 HTTPS API 地址"))?;
        if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none()
            || !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some()
            || self.base_url.len() > 2048 || self.base_url.chars().any(char::is_control) {
            return Err(invalid("API 地址仅支持 HTTP/HTTPS，不能包含账号密码、查询参数或片段"));
        }
        if !matches!(self.auth_type.as_str(), "ANTHROPIC_AUTH_TOKEN" | "ANTHROPIC_API_KEY") {
            return Err(invalid("不支持的密钥认证方式"));
        }
        let key = self.api_key.take().or_else(|| previous.and_then(|value| value.api_key.clone()));
        let key = key.map(|value| value.trim().to_string()).filter(|value| !value.is_empty())
            .ok_or_else(|| invalid("请输入 API 密钥；编辑时可留空沿用已保存的密钥"))?;
        if key.len() > 8192 || key.chars().any(char::is_control) { return Err(invalid("API 密钥格式无效")); }
        self.api_key = Some(key);
        for model in [&mut self.model, &mut self.opus_model, &mut self.sonnet_model, &mut self.haiku_model] {
            *model = model.trim().into();
            if model.len() > 256 || model.chars().any(char::is_control) { return Err(invalid("模型名称不能包含控制字符或超过 256 字节")); }
        }
        if self.extra_env.len() > 40 { return Err(invalid("高级环境变量不能超过 40 项")); }
        for (key, value) in &self.extra_env {
            if key.len() > 128 || !key.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
                || !allowed_extra(key) {
                return Err(invalid("高级配置仅支持模型相关的 ANTHROPIC_*、API_TIMEOUT_MS 等环境变量；地址、密钥及默认模型请在表单中填写"));
            }
            if value.len() > 4096 || value.chars().any(char::is_control) { return Err(invalid("高级环境变量的值格式无效")); }
        }
        Ok(self)
    }
    fn env(&self) -> BTreeMap<String, Value> {
        let mut env: BTreeMap<_, _> = self.extra_env.iter().map(|(key,value)| (key.clone(), json!(value))).collect();
        env.insert("ANTHROPIC_BASE_URL".into(), json!(self.base_url));
        env.insert(self.auth_type.clone(), json!(self.api_key.as_deref().unwrap_or_default()));
        for (key,value) in [
            ("ANTHROPIC_MODEL", &self.model), ("ANTHROPIC_DEFAULT_OPUS_MODEL", &self.opus_model),
            ("ANTHROPIC_DEFAULT_SONNET_MODEL", &self.sonnet_model), ("ANTHROPIC_DEFAULT_HAIKU_MODEL", &self.haiku_model),
        ] { if !value.is_empty() { env.insert(key.into(), json!(value)); } }
        env
    }
}

#[derive(Default, Deserialize, Serialize)]
struct Projection {
    env: BTreeMap<String, Value>,
    top: BTreeMap<String, Value>,
}
impl Projection {
    fn capture(root: &Value) -> Self {
        Self {
            env: root.get("env").and_then(Value::as_object).into_iter().flatten()
                .filter(|(key,_)| managed_env(key)).map(|(k,v)| (k.clone(),v.clone())).collect(),
            top: TOP_KEYS.iter().filter_map(|key| root.get(*key).map(|v| (key.to_string(),v.clone()))).collect(),
        }
    }
    fn apply(&self, root: &Value) -> Result<Value> {
        let mut root = root.clone();
        let object = root.as_object_mut().ok_or_else(|| invalid("Claude 配置必须是 JSON 对象"))?;
        for key in TOP_KEYS { object.remove(*key); }
        for (key,value) in &self.top { object.insert(key.clone(),value.clone()); }
        let env = object.entry("env").or_insert_with(|| json!({})).as_object_mut()
            .ok_or_else(|| invalid("Claude 配置的 env 必须是 JSON 对象，请修复后重试"))?;
        env.retain(|key,_| !managed_env(key));
        for (key,value) in &self.env { env.insert(key.clone(),value.clone()); }
        Ok(root)
    }
}

fn read_settings(path: &Path) -> Result<(Option<Vec<u8>>, Value)> {
    let bytes = match fs::read(path) {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(ProviderError::Storage(format!("读取 Claude 设置失败: {error}"))),
    };
    let root = match &bytes {
        Some(bytes) => serde_json::from_slice::<Value>(bytes).map_err(|_| invalid("Claude settings.json 不是有效 JSON，请修复后重试；原文件未更改"))?,
        None => json!({}),
    };
    if !root.is_object() || root.get("env").is_some_and(|env| !env.is_object()) {
        return Err(invalid("Claude 设置及 env 必须是 JSON 对象；原文件未更改"));
    }
    Ok((bytes, root))
}
fn config_from_settings(root: &Value) -> Option<ProviderInput> {
    let env = root.get("env")?.as_object()?;
    let text = |key: &str| env.get(key).and_then(Value::as_str).unwrap_or_default().to_string();
    let auth_type = if !text("ANTHROPIC_AUTH_TOKEN").is_empty() { "ANTHROPIC_AUTH_TOKEN" } else { "ANTHROPIC_API_KEY" };
    ProviderInput {
        name: "当前容器配置".into(), base_url: text("ANTHROPIC_BASE_URL"),
        auth_type: auth_type.into(), api_key: Some(text(auth_type)),
        model: root.get("model").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| text("ANTHROPIC_MODEL")),
        opus_model: text("ANTHROPIC_DEFAULT_OPUS_MODEL"), sonnet_model: text("ANTHROPIC_DEFAULT_SONNET_MODEL"),
        haiku_model: text("ANTHROPIC_DEFAULT_HAIKU_MODEL"),
        extra_env: env.iter().filter(|(key,_)| allowed_extra(key)).filter_map(|(key,value)| value.as_str().map(|v| (key.clone(),v.into()))).collect(),
    }.validate(None).ok()
}

struct StoredProvider { id: String, config: ProviderInput, updated_at: i64 }
fn load(connection: &Connection, id: &str) -> Result<StoredProvider> {
    let row = connection.query_row("SELECT encrypted_config, updated_at FROM claude_providers WHERE id = ?1", [id],
        |row| Ok((row.get::<_,String>(0)?, row.get::<_,i64>(1)?))).optional().map_err(db_error)?.ok_or(ProviderError::NotFound)?;
    let plaintext = decrypt_string(&row.0).map_err(|_| ProviderError::Storage("无法解密模型配置，请检查持久化的 server.key".into()))?;
    let config = serde_json::from_str(&plaintext).map_err(|_| ProviderError::Storage("模型配置数据损坏".into()))?;
    Ok(StoredProvider { id: id.into(), config, updated_at: row.1 })
}
fn active(connection: &Connection) -> Result<Option<String>> {
    connection.query_row("SELECT active_provider_id FROM claude_provider_state WHERE id = 1", [], |row| row.get(0)).map_err(db_error)
}
fn encrypted<T: Serialize>(value: &T) -> Result<String> {
    encrypt_string(&serde_json::to_string(value).map_err(|_| invalid("无法编码模型配置"))?).map_err(Into::into)
}
fn write_settings_and_commit(transaction: rusqlite::Transaction<'_>, path: &Path, before: Option<Vec<u8>>, after: &Value) -> Result<()> {
    let content = serde_json::to_vec_pretty(after).map_err(|_| invalid("无法编码 Claude 设置"))?;
    atomic_write_private(path, &content).map_err(|e| ProviderError::Storage(format!("写入 Claude 设置失败: {e}")))?;
    if let Err(error) = transaction.commit() {
        let restored = match before {
            Some(bytes) => atomic_write_private(path, &bytes),
            None => fs::remove_file(path),
        };
        if restored.is_err() { return Err(ProviderError::Storage("数据库提交与配置回退均失败，请重新应用模型配置".into())); }
        return Err(db_error(error));
    }
    Ok(())
}

struct Store { connection: Connection, settings_path: PathBuf }
impl Store {
    fn list(&self) -> Result<ProviderList> {
        let (_, root) = read_settings(&self.settings_path)?;
        let active_provider_id = active(&self.connection)?;
        let mut statement = self.connection.prepare("SELECT id FROM claude_providers ORDER BY created_at, id").map_err(db_error)?;
        let ids = statement.query_map([], |row| row.get::<_,String>(0)).map_err(db_error)?
            .collect::<std::result::Result<Vec<_>,_>>().map_err(db_error)?;
        let mut applied = false;
        let mut providers = Vec::new();
        for id in ids {
            let mut row = load(&self.connection, &id)?;
            if active_provider_id.as_deref() == Some(&id) {
                let projection = Projection { env: row.config.env(), top: BTreeMap::new() };
                applied = projection.apply(&root)? == root;
            }
            let has_api_key = row.config.api_key.take().is_some_and(|key| !key.is_empty());
            providers.push(ProviderView { id: row.id, config: row.config, has_api_key, updated_at: row.updated_at });
        }
        Ok(ProviderList { providers, active_provider_id, applied, can_import: config_from_settings(&root).is_some() })
    }
    fn save(&mut self, id: Option<&str>, input: ProviderInput, activate: bool) -> Result<()> {
        let transaction = self.connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_error)?;
        let previous = id.map(|id| load(&transaction,id)).transpose()?;
        let config = input.validate(previous.as_ref().map(|row| &row.config))?;
        let id = id.map(str::to_string).unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let now = chrono::Utc::now().timestamp_millis();
        let timestamp = previous.as_ref().map_or(now, |row| now.max(row.updated_at + 1));
        let ciphertext = encrypted(&config)?;
        transaction.execute(
            "INSERT INTO claude_providers (id,name,encrypted_config,created_at,updated_at) VALUES (?1,?2,?3,?4,?4)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name, encrypted_config=excluded.encrypted_config, updated_at=excluded.updated_at",
            params![id,config.name,ciphertext,timestamp]).map_err(db_error)?;
        let apply = activate || active(&transaction)?.as_deref() == Some(&id);
        if apply {
            let (before,root) = read_settings(&self.settings_path)?;
            let baseline = encrypted(&Projection::capture(&root))?;
            transaction.execute("UPDATE claude_provider_state SET active_provider_id=?1, encrypted_baseline=COALESCE(encrypted_baseline,?2) WHERE id=1", params![id,baseline]).map_err(db_error)?;
            let after = Projection { env: config.env(), top: BTreeMap::new() }.apply(&root)?;
            write_settings_and_commit(transaction,&self.settings_path,before,&after)
        } else { transaction.commit().map_err(db_error) }
    }
    fn activate(&mut self, id: &str) -> Result<()> {
        let transaction = self.connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_error)?;
        let row = load(&transaction,id)?;
        let (before,root) = read_settings(&self.settings_path)?;
        let baseline = encrypted(&Projection::capture(&root))?;
        transaction.execute("UPDATE claude_provider_state SET active_provider_id=?1, encrypted_baseline=COALESCE(encrypted_baseline,?2) WHERE id=1",params![id,baseline]).map_err(db_error)?;
        let after = Projection { env: row.config.env(), top: BTreeMap::new() }.apply(&root)?;
        write_settings_and_commit(transaction,&self.settings_path,before,&after)
    }
    fn deactivate(&mut self) -> Result<()> {
        let transaction = self.connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_error)?;
        let baseline: Option<String> = transaction.query_row("SELECT encrypted_baseline FROM claude_provider_state WHERE id=1",[],|row|row.get(0)).map_err(db_error)?;
        let Some(baseline) = baseline else { return Ok(()); };
        let baseline = decrypt_string(&baseline).map_err(|_| ProviderError::Storage("无法解密原始 Claude 配置，请检查 server.key".into()))?;
        let projection: Projection = serde_json::from_str(&baseline).map_err(|_| ProviderError::Storage("原始配置备份损坏".into()))?;
        let (before,root) = read_settings(&self.settings_path)?;
        let after = projection.apply(&root)?;
        transaction.execute("UPDATE claude_provider_state SET active_provider_id=NULL,encrypted_baseline=NULL WHERE id=1",[]).map_err(db_error)?;
        write_settings_and_commit(transaction,&self.settings_path,before,&after)
    }
    fn remove(&mut self, id: &str) -> Result<()> {
        let transaction = self.connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db_error)?;
        if active(&transaction)?.as_deref() == Some(id) {
            return Err(ProviderError::Conflict("请先切换到其他配置，或恢复原配置，再删除当前启用的条目".into()));
        }
        if transaction.execute("DELETE FROM claude_providers WHERE id=?1",[id]).map_err(db_error)? == 0 { return Err(ProviderError::NotFound); }
        transaction.commit().map_err(db_error)
    }
}

pub enum ProviderAction { List, Create(ProviderInput), Update(String, ProviderInput), Activate(String), Delete(String), ImportCurrent, Deactivate }
pub fn execute(action: ProviderAction) -> Result<ProviderList> {
    let _guard = claude_settings_write_lock().lock().map_err(|_| ProviderError::Storage("Claude 配置写入锁不可用".into()))?;
    // 与实际 CLI 使用的目录一致，不接收浏览器提供的任意路径。
    let config_dir = resolve_claude_config_dir(None)?;
    if !config_dir.is_absolute() { return Err(invalid("CLAUDE_CONFIG_DIR 必须为绝对路径")); }
    let mut store = Store { connection: DatabaseService::open()?, settings_path: config_dir.join("settings.json") };
    match action {
        ProviderAction::List => {},
        ProviderAction::Create(input) => store.save(None,input,false)?,
        ProviderAction::Update(id,input) => store.save(Some(&id),input,false)?,
        ProviderAction::Activate(id) => store.activate(&id)?,
        ProviderAction::Delete(id) => store.remove(&id)?,
        ProviderAction::Deactivate => store.deactivate()?,
        ProviderAction::ImportCurrent => {
            let (_,root) = read_settings(&store.settings_path)?;
            let input = config_from_settings(&root).ok_or_else(|| invalid("当前容器没有可导入的第三方 API 地址和密钥"))?;
            // 导入仅保存副本，不改当前文件或中断已启用的条目。
            store.save(None,input,false)?;
        }
    }
    store.list()
}

fn native_error(error: ProviderError) -> String {
    match error {
        ProviderError::Invalid(message) | ProviderError::Conflict(message) | ProviderError::Storage(message) => message,
        ProviderError::NotFound => "Claude 供应商已被删除，请刷新后重新选择".into(),
    }
}
fn configured_models(config: &ProviderInput) -> Vec<String> {
    let mut models = Vec::new();
    for model in [&config.model, &config.opus_model, &config.sonnet_model, &config.haiku_model] {
        if !model.is_empty() && !models.contains(model) { models.push(model.clone()); }
    }
    models
}
pub(crate) fn native_launch_targets() -> std::result::Result<Vec<crate::models::ai_chat::AiProviderOption>, String> {
    use crate::models::ai_chat::{AiProviderOption, AiModelOption};
    let list = execute(ProviderAction::List).map_err(native_error)?;
    Ok(list.providers.into_iter().map(|provider| {
        let models = configured_models(&provider.config);
        AiProviderOption {
            id: format!("claude:{}", provider.id), agent: "claude".into(), name: provider.config.name,
            is_default: list.active_provider_id.as_deref() == Some(provider.id.as_str()),
            models: if models.is_empty() { vec![AiModelOption { id: String::new(), label: "供应商默认模型".into(), effort: String::new() }] }
                else { models.into_iter().map(|id| AiModelOption { label: id.clone(), id, effort: String::new() }).collect() },
        }
    }).collect())
}
pub(crate) fn native_session_settings(id: &str, model: &str) -> std::result::Result<Value, String> {
    let _guard = claude_settings_write_lock().lock().map_err(|_| "Claude 配置锁不可用")?;
    let connection = DatabaseService::open()?;
    let row = load(&connection, id).map_err(native_error)?;
    if row.config.api_key.as_deref().unwrap_or_default().is_empty() { return Err("所选 Claude 供应商没有配置密钥".into()); }
    let models = configured_models(&row.config);
    if !model.is_empty() && !models.iter().any(|id| id == model) { return Err("模型已从供应商配置中移除，请刷新后重新选择".into()); }
    let mut env = row.config.env();
    if !model.is_empty() {
        for key in ["ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_FABLE_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL"] {
            env.insert(key.into(), json!(model));
        }
    }
    let mut settings = json!({"env":env});
    if !model.is_empty() { settings["model"] = json!(model); }
    Ok(settings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::PathService;
    fn input(name: &str) -> ProviderInput {
        ProviderInput { name:name.into(),base_url:"https://example.com/anthropic".into(),auth_type:default_auth(),
            api_key:Some(format!("test-secret-{name}")),model:"custom-model[1m]".into(),..Default::default() }
    }
    #[test]
    fn switching_replaces_credentials_and_models_but_preserves_user_settings() {
        let root = json!({"env":{"ANTHROPIC_API_KEY":"old","ANTHROPIC_SMALL_FAST_MODEL":"old-fast","CLAUDE_CODE_USE_BEDROCK":"1","UNRELATED":"keep"},
            "model":"old-model","apiKeyHelper":"old-helper","hooks":{"Stop":[]},"permissions":{"allow":["Read"]},"theme":"dark"});
        let after = Projection {env:input("a").env(),top:BTreeMap::new()}.apply(&root).unwrap();
        assert!(after.pointer("/env/ANTHROPIC_API_KEY").is_none());
        assert!(after.pointer("/env/ANTHROPIC_SMALL_FAST_MODEL").is_none());
        assert!(after.pointer("/env/CLAUDE_CODE_USE_BEDROCK").is_none());
        assert!(after.get("model").is_none());
        assert!(after.get("apiKeyHelper").is_none());
        assert_eq!(after["env"]["UNRELATED"],"keep");
        assert_eq!(after["hooks"],root["hooks"]);
        assert_eq!(after["permissions"],root["permissions"]);
        assert_eq!(after["env"]["ANTHROPIC_MODEL"],"custom-model[1m]");
        assert_eq!(Projection::capture(&root).apply(&after).unwrap(),root);
    }
    #[test]
    fn rejects_invalid_endpoints_and_reserved_extra_credentials() {
        for url in ["file:///tmp/config","https://key@example.com","https://example.com?key=secret","not-a-url"] {
            let mut value=input("a");value.base_url=url.into();assert!(value.validate(None).is_err());
        }
        let mut value=input("a");value.extra_env.insert("ANTHROPIC_AUTH_TOKEN".into(),"secret".into());
        assert!(value.validate(None).is_err());
        assert!(Projection::default().apply(&json!({"env":[]})).is_err());
    }
    #[test]
    fn sqlite_crud_secrets_switching_restore_and_failed_writes() {
        let directory=std::env::temp_dir().join(format!("claude-provider-test-{}",uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        PathService::set_test_data_dir(Some(directory.clone()));
        let path=directory.join("claude/settings.json");
        let original=json!({"env":{"ANTHROPIC_API_KEY":"original-secret","ANTHROPIC_BASE_URL":"https://original.example"},"hooks":{"Stop":[]},"model":"original"});
        atomic_write_private(&path,&serde_json::to_vec(&original).unwrap()).unwrap();
        let mut store=Store{connection:DatabaseService::open().unwrap(),settings_path:path.clone()};
        store.save(None,input("a"),false).unwrap();
        let first=store.list().unwrap().providers.remove(0);
        let json=serde_json::to_string(&first).unwrap();
        assert!(!json.contains("test-secret")); assert!(first.has_api_key);
        let raw:String=store.connection.query_row("SELECT encrypted_config FROM claude_providers",[],|row|row.get(0)).unwrap();
        assert!(!raw.contains("test-secret"));
        store.activate(&first.id).unwrap();
        assert!(store.list().unwrap().applied);
        assert!(matches!(store.remove(&first.id),Err(ProviderError::Conflict(_))));
        let mut edit=input("a edited");edit.api_key=None;edit.auth_type="ANTHROPIC_API_KEY".into();edit.opus_model="opus-custom".into();
        store.save(Some(&first.id),edit,false).unwrap();
        let (_,live)=read_settings(&path).unwrap();
        assert_eq!(live["env"]["ANTHROPIC_API_KEY"],"test-secret-a");
        assert!(live["env"].get("ANTHROPIC_AUTH_TOKEN").is_none());
        store.save(None,input("b"),false).unwrap();
        let second=store.list().unwrap().providers.into_iter().find(|p|p.config.name=="b").unwrap();
        store.activate(&second.id).unwrap();
        assert!(read_settings(&path).unwrap().1["env"].get("ANTHROPIC_DEFAULT_OPUS_MODEL").is_none());
        drop(store);
        let mut store=Store{connection:DatabaseService::open().unwrap(),settings_path:path.clone()};
        assert_eq!(store.list().unwrap().active_provider_id.as_deref(),Some(second.id.as_str()));
        assert_eq!(store.list().unwrap().providers.len(),2);
        fs::write(&path,b"{broken").unwrap();
        assert!(store.activate(&first.id).is_err());
        assert!(store.save(Some(&second.id),input("failed-edit"),false).is_err());
        assert_eq!(load(&store.connection,&second.id).unwrap().config.name,"b");
        assert_eq!(active(&store.connection).unwrap().as_deref(),Some(second.id.as_str()));
        assert_eq!(fs::read(&path).unwrap(),b"{broken");
        atomic_write_private(&path,&serde_json::to_vec(&live).unwrap()).unwrap();
        assert!(!store.list().unwrap().applied);
        store.deactivate().unwrap();
        assert_eq!(read_settings(&path).unwrap().1,original);
        store.remove(&first.id).unwrap();store.remove(&second.id).unwrap();
        assert!(store.list().unwrap().providers.is_empty());
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777,0o600);
        }
        PathService::set_test_data_dir(None);
        drop(store);fs::remove_dir_all(directory).unwrap();
    }
}
