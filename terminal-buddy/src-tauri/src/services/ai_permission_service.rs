//! 将服务端 Agent 基础命令中的权限选项应用到原生 AI 会话。
//! 只提取权限参数，不执行基础命令中的 shell 片段，也不覆盖所选模型和结构化 I/O。
use super::SettingsService;
use serde_json::{json, Value};

type Result<T> = std::result::Result<T, String>;
const DEFAULT_CLAUDE_COMMAND: &str = "claude --dangerously-skip-permissions";
const DEFAULT_CODEX_COMMAND: &str = "codex --dangerously-bypass-approvals-and-sandbox";

#[derive(Default)]
pub(crate) struct NativePermissions {
    pub claude_args: Vec<String>,
    pub codex_args: Vec<String>,
    approval_policy: Option<&'static str>,
    sandbox: Option<&'static str>,
}

impl NativePermissions {
    /// 新建与恢复线程均覆盖权限，避免继续沿用旧会话里的审批策略。
    pub fn apply_thread(&self, params: &mut Value) {
        if let Some(policy) = self.approval_policy { params["approvalPolicy"] = json!(policy); }
        if let Some(sandbox) = self.sandbox { params["sandbox"] = json!(sandbox); }
    }
    pub fn apply_turn(&self, params: &mut Value) {
        if let Some(policy) = self.approval_policy { params["approvalPolicy"] = json!(policy); }
        // 沙箱在 thread/start / thread/resume 设置；沿用线程有效配置，
        // 不手工重建 workspaceWrite，避免丢掉服务端已有的目录/网络访问设置。
    }
    // app-server 的字段名使用 camelCase，但权限枚举与 CLI 配置均使用连字符格式。
    fn approval(&mut self, value: &str) -> Result<()> {
        let policy = match value {
            "never" => "never",
            "on-request" | "onRequest" => "on-request",
            "untrusted" | "unlessTrusted" => "untrusted",
            "on-failure" | "onFailure" => "on-failure",
            _ => return Err("Codex 审批参数无效，请检查 Agent 基础启动命令".into()),
        };
        self.approval_policy = Some(policy);
        self.codex_args.extend(["-c".into(), format!("approval_policy=\"{policy}\"")]);
        Ok(())
    }
    fn sandbox(&mut self, value: &str) -> Result<()> {
        let mode = match value {
            "read-only" | "readOnly" => "read-only",
            "workspace-write" | "workspaceWrite" => "workspace-write",
            "danger-full-access" | "dangerFullAccess" => "danger-full-access",
            _ => return Err("Codex 沙箱参数无效，请检查 Agent 基础启动命令".into()),
        };
        self.sandbox = Some(mode);
        self.codex_args.extend(["-c".into(), format!("sandbox_mode=\"{mode}\"")]);
        Ok(())
    }
    fn config(&mut self, value: &str) -> Result<()> {
        let Some((key, value)) = value.split_once('=') else { return Ok(()); };
        match key.trim() {
            "approval_policy" => self.approval(value.trim().trim_matches(['\'', '"'])),
            "sandbox_mode" => self.sandbox(value.trim().trim_matches(['\'', '"'])),
            key if key.starts_with("sandbox_workspace_write.") => {
                self.codex_args.extend(["-c".into(), format!("{key}={value}")]);
                Ok(())
            }
            _ => Ok(()),
        }
    }
}

pub(crate) fn for_agent(agent: &str) -> Result<NativePermissions> {
    let settings = SettingsService::get_settings();
    let (configured, fallback) = if agent == "claude" {
        (settings.agent_commands.claude, DEFAULT_CLAUDE_COMMAND)
    } else { (settings.agent_commands.codex, DEFAULT_CODEX_COMMAND) };
    let command = if configured.trim().is_empty() { fallback } else { configured.trim() };
    let tokens = shell_words::split(command).map_err(|_| "Agent 基础启动命令的引号不匹配，请修正后重试")?;
    let mut permissions = NativePermissions::default();
    let mut index = 0;
    while index < tokens.len() {
        let token = &tokens[index];
        if matches!(token.as_str(), "--" | "&&" | "||" | ";" | "|") { break; }
        let (flag, inline) = token.split_once('=').map_or((token.as_str(), None), |(flag, value)| (flag, Some(value)));
        if agent == "claude" {
            match flag {
                "--dangerously-skip-permissions" | "--allow-dangerously-skip-permissions" => permissions.claude_args.push(token.clone()),
                "--permission-mode" => {
                    permissions.claude_args.push(flag.into());
                    permissions.claude_args.push(option_value(&tokens, &mut index, inline, flag)?);
                }
                "--allowedTools" | "--allowed-tools" | "--disallowedTools" | "--disallowed-tools" | "--tools" => {
                    permissions.claude_args.push(flag.into());
                    permissions.claude_args.push(option_value(&tokens, &mut index, inline, flag)?);
                    if inline.is_none() {
                        while tokens.get(index + 1).is_some_and(|value| !value.starts_with('-') && !matches!(value.as_str(), "&&" | "||" | ";" | "|")) {
                            index += 1; permissions.claude_args.push(tokens[index].clone());
                        }
                    }
                }
                _ => {}
            }
        } else {
            match flag {
                "--dangerously-bypass-approvals-and-sandbox" | "--yolo" => {
                    if inline.is_some() { return Err("Codex 免确认开关不接受附加值，请检查 Agent 基础启动命令".into()); }
                    permissions.approval("never")?; permissions.sandbox("danger-full-access")?;
                }
                "--full-auto" => { permissions.approval("on-request")?; permissions.sandbox("workspace-write")?; }
                "--ask-for-approval" | "-a" => permissions.approval(&option_value(&tokens, &mut index, inline, flag)?)?,
                "--sandbox" | "-s" => permissions.sandbox(&option_value(&tokens, &mut index, inline, flag)?)?,
                "--config" | "-c" => permissions.config(&option_value(&tokens, &mut index, inline, flag)?)?,
                flag if flag.starts_with("-c") && !flag.starts_with("--") => permissions.config(&token[2..])?,
                flag if flag.starts_with("-a") && !flag.starts_with("--") => permissions.approval(&token[2..])?,
                flag if flag.starts_with("-s") && !flag.starts_with("--") => permissions.sandbox(&token[2..])?,
                _ => {}
            }
        }
        index += 1;
    }
    Ok(permissions)
}

fn option_value(tokens: &[String], index: &mut usize, inline: Option<&str>, flag: &str) -> Result<String> {
    if let Some(value) = inline { return Ok(value.into()); }
    *index += 1;
    let value = tokens.get(*index).ok_or_else(|| format!("Agent 基础启动命令中的 {flag} 缺少参数"))?;
    if value.starts_with('-') { return Err(format!("Agent 基础启动命令中的 {flag} 缺少参数")); }
    Ok(value.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sandbox_modes_use_protocol_values() {
        for (input, expected) in [
            ("read-only", "read-only"),
            ("readOnly", "read-only"),
            ("workspace-write", "workspace-write"),
            ("workspaceWrite", "workspace-write"),
            ("danger-full-access", "danger-full-access"),
            ("dangerFullAccess", "danger-full-access"),
        ] {
            let mut permissions = NativePermissions::default();
            permissions.sandbox(input).unwrap();
            for mut params in [json!({"cwd": "."}), json!({"threadId": "existing-thread"})] {
                let mut expected_params = params.clone();
                expected_params["sandbox"] = json!(expected);
                permissions.apply_thread(&mut params);
                assert_eq!(params, expected_params, "沙箱输入：{input}");
            }
            assert_eq!(permissions.codex_args, vec!["-c".to_string(), format!("sandbox_mode=\"{expected}\"")]);
        }
    }

    #[test]
    fn approval_policies_use_protocol_values() {
        for (input, expected) in [
            ("never", "never"),
            ("on-request", "on-request"),
            ("onRequest", "on-request"),
            ("untrusted", "untrusted"),
            ("unlessTrusted", "untrusted"),
            ("on-failure", "on-failure"),
            ("onFailure", "on-failure"),
        ] {
            let mut permissions = NativePermissions::default();
            permissions.approval(input).unwrap();
            let mut thread = json!({});
            permissions.apply_thread(&mut thread);
            assert_eq!(thread, json!({"approvalPolicy": expected}), "线程审批输入：{input}");
            let mut turn = json!({"threadId": "existing-thread"});
            permissions.apply_turn(&mut turn);
            assert_eq!(turn, json!({"threadId": "existing-thread", "approvalPolicy": expected}), "消息审批输入：{input}");
            assert_eq!(permissions.codex_args, vec!["-c".to_string(), format!("approval_policy=\"{expected}\"")]);
        }
    }

    #[test]
    fn config_overrides_normalize_permissions_and_preserve_turn_sandbox() {
        let mut permissions = NativePermissions::default();
        permissions.config(r#"approval_policy="onRequest""#).unwrap();
        permissions.config("sandbox_mode='dangerFullAccess'").unwrap();
        let mut thread = json!({"cwd": "."});
        permissions.apply_thread(&mut thread);
        assert_eq!(thread, json!({"cwd": ".", "approvalPolicy": "on-request", "sandbox": "danger-full-access"}));

        let mut turn = json!({"threadId": "existing-thread"});
        permissions.apply_turn(&mut turn);
        assert_eq!(turn, json!({"threadId": "existing-thread", "approvalPolicy": "on-request"}));
        assert_eq!(permissions.codex_args, vec![
            "-c", r#"approval_policy="on-request""#,
            "-c", r#"sandbox_mode="danger-full-access""#,
        ]);
    }
}
