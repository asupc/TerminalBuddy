//! 定时任务：任务定义、运行记录、输入校验与视图模型。
//!
//! 调度语义见 `docs/specs/scheduled-tasks.md`：Cron 在任务时区下求值，
//! 「仅一次」保存的是任务时区下的本地墙钟时间，避免容器 UTC 与浏览器时区不一致。
use crate::commands::profile::Project;
use crate::models::ai_chat::AiCatalog;
use crate::models::Profile;
use chrono::{Duration, NaiveDateTime, TimeZone, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use std::str::FromStr;

pub const MAX_TASKS: usize = 200;
pub const MAX_PROMPT_CHARS: usize = 8_000;
pub const MAX_TIMEOUT_MINUTES: u32 = 240;
pub const MAX_AUTO_CLOSE_MINUTES: u32 = 1_440;
/// 每个任务最多保留的运行记录条数。
pub const MAX_RUNS_PER_TASK: usize = 100;

fn default_true() -> bool {
    true
}

fn default_timeout_minutes() -> u32 {
    30
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduledTask {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    /// IANA 时区，例如 `Asia/Shanghai`。
    pub timezone: String,
    pub schedule: TaskSchedule,
    pub target: TaskTarget,
    #[serde(default = "default_true")]
    pub notify: bool,
    #[serde(default = "default_timeout_minutes")]
    pub timeout_minutes: u32,
    pub created_at: i64,
    pub updated_at: i64,
    /// 调度锚点：上一次「已被调度消费」的计划时刻（不是实际开始时刻）。
    /// 用它计算下一次，保证重启后不会重复触发。
    #[serde(default)]
    pub last_scheduled_at: Option<i64>,
    #[serde(default)]
    pub last_run_at: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum TaskSchedule {
    /// 标准 5 段 Cron：分 时 日 月 周。
    Cron { expression: String },
    /// 仅一次；runAt 是任务时区下的本地墙钟时间，例如 `2026-11-20T09:00`。
    Once { run_at: String },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum TaskTarget {
    /// 启动项目下已配置的终端。
    ProjectProfile {
        project_name: String,
        profile_id: String,
        /// 启动后多少分钟自动关闭；0 = 不自动关闭。
        #[serde(default)]
        auto_close_minutes: u32,
    },
    /// 用指定 Agent + 供应商 + 模型执行一段任务描述。
    AgentPrompt {
        project_name: String,
        /// `claude` | `codex` | `antigravity`
        agent: String,
        /// Antigravity CLI 使用 Google 账号登录，固定为 None。
        #[serde(default)]
        provider_id: Option<String>,
        #[serde(default)]
        model: Option<String>,
        prompt: String,
    },
}

impl TaskSchedule {
    pub fn is_once(&self) -> bool {
        matches!(self, TaskSchedule::Once { .. })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledRun {
    pub id: String,
    pub task_id: String,
    /// 任务名快照：任务改名 / 删除后历史仍可读。
    pub task_name: String,
    /// scheduled | manual
    pub trigger: String,
    /// running | waitingApproval | completed | failed | timeout | stopped | started | skipped
    pub status: String,
    pub started_at: i64,
    #[serde(default)]
    pub finished_at: Option<i64>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub terminal_id: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub provider_name: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub input_tokens: Option<u64>,
    #[serde(default)]
    pub output_tokens: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduledTaskInput {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub enabled: bool,
    pub timezone: String,
    pub schedule: TaskSchedule,
    pub target: TaskTarget,
    #[serde(default)]
    pub notify: Option<bool>,
    #[serde(default)]
    pub timeout_minutes: Option<u32>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTaskView {
    #[serde(flatten)]
    pub task: ScheduledTask,
    pub next_run_at: Option<i64>,
    pub running_run_id: Option<String>,
    pub last_run: Option<ScheduledRun>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTaskOptions {
    pub projects: Vec<Project>,
    pub profiles: Vec<Profile>,
    pub catalog: AiCatalog,
}

/// 标准 crontab 的星期是 0/7 = 周日、1 = 周一，而 `cron` crate 内部是
/// 1 = 周日 .. 7 = 周六。用户输入统一按标准 crontab 语义解释，这里做一次映射，
/// 支持数字、英文缩写、列表、范围和步长。
fn standard_day(token: &str) -> Option<u32> {
    if let Ok(value) = token.parse::<u32>() {
        return (value <= 7).then_some(value);
    }
    match token.to_ascii_lowercase().as_str() {
        "sun" | "sunday" => Some(0),
        "mon" | "monday" => Some(1),
        "tue" | "tues" | "tuesday" => Some(2),
        "wed" | "wednesday" => Some(3),
        "thu" | "thurs" | "thursday" => Some(4),
        "fri" | "friday" => Some(5),
        "sat" | "saturday" => Some(6),
        _ => None,
    }
}

fn crate_day(day: u32) -> u32 {
    match day {
        0 | 7 => 1,
        value => value + 1,
    }
}

fn expand_day_segment(segment: &str) -> Option<Vec<u32>> {
    if segment == "*" || segment == "?" {
        return Some((0..=6).collect());
    }
    if let Some((start, end)) = segment.split_once('-') {
        let (start, end) = (standard_day(start)?, standard_day(end)?);
        return Some(if start <= end {
            (start..=end).collect()
        } else {
            (start..=6).chain(0..=end).collect()
        });
    }
    Some(vec![standard_day(segment)?])
}

fn translate_day_of_week(field: &str) -> Option<String> {
    let trimmed = field.trim();
    if trimmed == "*" || trimmed == "?" {
        return Some("*".to_string());
    }
    let mut days = Vec::new();
    for part in trimmed.split(',') {
        let (segment, step) = match part.split_once('/') {
            Some((segment, step)) => (segment, step.parse::<usize>().ok()?),
            None => (part, 1),
        };
        let step = step.max(1);
        let values = expand_day_segment(segment)?;
        days.extend(values.into_iter().step_by(step).map(crate_day));
    }
    days.sort_unstable();
    days.dedup();
    Some(if days.len() == 7 {
        "*".to_string()
    } else {
        days.into_iter().map(|day| day.to_string()).collect::<Vec<_>>().join(",")
    })
}

/// 把用户习惯的 5 段 Cron（分 时 日 月 周）补成 `cron` crate 需要的 6 段
/// （秒 分 时 日 月 周），并统一星期编号。已经带秒 / 年份的表达式同样处理。
pub(crate) fn normalize_cron(expression: &str) -> Result<String, String> {
    let mut fields: Vec<String> = expression.split_whitespace().map(str::to_string).collect();
    let day_index = match fields.len() {
        5 => 4,
        6 | 7 => 5,
        _ => return Err("Cron 表达式无效，请检查 5 段格式（分 时 日 月 周）".into()),
    };
    // 无法识别（如带 L / # 的扩展写法）时保留原值，交给 cron crate 报错。
    fields[day_index] = translate_day_of_week(&fields[day_index])
        .unwrap_or_else(|| fields[day_index].clone());
    if fields.len() == 5 {
        fields.insert(0, "0".to_string());
    }
    Ok(fields.join(" "))
}

pub(crate) fn parse_cron_schedule(expression: &str) -> Result<cron::Schedule, String> {
    let normalized = normalize_cron(expression)?;
    cron::Schedule::from_str(&normalized).map_err(|_| "Cron 表达式无效".into())
}

/// 解析 IANA 时区；错误文案直接面向界面。
pub(crate) fn parse_timezone(name: &str) -> Result<Tz, String> {
    Tz::from_str(name.trim()).map_err(|_| format!("时区「{}」无效，请选择 IANA 时区", name))
}

/// 「仅一次」的本地墙钟时间。兼容前端 `datetime-local` 可能带秒的写法。
pub(crate) fn parse_once_local(run_at: &str) -> Option<NaiveDateTime> {
    let value = run_at.trim();
    for format in ["%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"] {
        if let Ok(parsed) = NaiveDateTime::parse_from_str(value, format) {
            return Some(parsed);
        }
    }
    chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .ok()
        .and_then(|date| date.and_hms_opt(0, 0, 0))
}

/// 把「仅一次」换算成 UTC；夏令时跳变导致本地时间不存在时返回 None。
pub(crate) fn once_as_utc(run_at: &str, tz: Tz) -> Option<chrono::DateTime<Utc>> {
    let naive = parse_once_local(run_at)?;
    tz.from_local_datetime(&naive)
        .earliest()
        .map(|local| local.with_timezone(&Utc))
}

fn validate_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    let length = name.chars().count();
    if length == 0 {
        return Err("任务名称不能为空".into());
    }
    if length > 40 {
        return Err("任务名称不能超过 40 个字符".into());
    }
    if name.chars().any(char::is_control) {
        return Err("任务名称不能包含控制字符".into());
    }
    Ok(name.to_string())
}

fn normalize_group(group: &str) -> &str {
    if group.trim().is_empty() {
        "默认"
    } else {
        group
    }
}

fn validate_target(target: &TaskTarget, projects: &[Project], profiles: &[Profile]) -> Result<(), String> {
    let project_name = match target {
        TaskTarget::ProjectProfile { project_name, .. } => project_name,
        TaskTarget::AgentPrompt { project_name, .. } => project_name,
    };
    if !projects.iter().any(|project| project.name == *project_name) {
        return Err(format!("项目「{}」不存在，请重新选择", project_name));
    }
    match target {
        TaskTarget::ProjectProfile { project_name, profile_id, auto_close_minutes } => {
            if *auto_close_minutes > MAX_AUTO_CLOSE_MINUTES {
                return Err(format!("自动关闭时间不能超过 {} 分钟", MAX_AUTO_CLOSE_MINUTES));
            }
            let profile = profiles
                .iter()
                .find(|profile| profile.id == *profile_id)
                .ok_or_else(|| "所选终端配置不存在，请重新选择".to_string())?;
            if normalize_group(&profile.group) != project_name {
                return Err(format!(
                    "终端配置「{}」不属于项目「{}」，请重新选择",
                    profile.name, project_name
                ));
            }
        }
        TaskTarget::AgentPrompt { agent, provider_id, model, prompt, .. } => {
            if !matches!(agent.as_str(), "claude" | "codex" | "antigravity") {
                return Err("请选择 Claude、Codex 或 Antigravity".into());
            }
            // Antigravity CLI 固定使用 Google 账号登录，不经过供应商目录。
            if agent != "antigravity" {
                crate::services::ai_catalog_service::selection(
                    agent,
                    provider_id.as_deref(),
                    model.as_deref(),
                )?;
            }
            let prompt_length = prompt.chars().count();
            if prompt.trim().is_empty() {
                return Err("任务描述不能为空".into());
            }
            if prompt_length > MAX_PROMPT_CHARS {
                return Err(format!("任务描述不能超过 {} 个字符", MAX_PROMPT_CHARS));
            }
        }
    }
    Ok(())
}

/// 保存前统一校验并归一化字段。任务数量上限由存储层按当前列表检查。
pub fn validate_input(
    mut input: ScheduledTaskInput,
    projects: &[Project],
    profiles: &[Profile],
) -> Result<ScheduledTask, String> {
    let name = validate_name(&input.name)?;
    // Antigravity 不使用供应商 / 模型配置，保存时统一归一化为 None，
    // 避免旧草稿或客户端残留字段让运行器去目录里查不存在的供应商。
    if let TaskTarget::AgentPrompt { agent, provider_id, model, .. } = &mut input.target {
        if agent == "antigravity" {
            *provider_id = None;
            *model = None;
        }
    }
    let tz = parse_timezone(&input.timezone)?;
    let now = Utc::now();
    match &input.schedule {
        TaskSchedule::Cron { expression } => {
            let schedule = parse_cron_schedule(expression)?;
            if schedule.after(&now.with_timezone(&tz)).next().is_none() {
                return Err("Cron 表达式在未来没有可执行时间，请检查".into());
            }
        }
        TaskSchedule::Once { run_at } => {
            let local = parse_once_local(run_at)
                .ok_or_else(|| "执行时间格式无效，请重新选择".to_string())?;
            let utc = tz
                .from_local_datetime(&local)
                .earliest()
                .map(|value| value.with_timezone(&Utc))
                .ok_or_else(|| "该时间在所选时区不存在（夏令时跳变），请换一个时间".to_string())?;
            if utc < now - Duration::minutes(1) {
                return Err("执行时间不能早于当前时间".into());
            }
        }
    }
    let timeout_minutes = input.timeout_minutes.unwrap_or_else(default_timeout_minutes);
    if timeout_minutes == 0 || timeout_minutes > MAX_TIMEOUT_MINUTES {
        return Err(format!("超时时间需在 1–{} 分钟之间", MAX_TIMEOUT_MINUTES));
    }
    // Agent 任务的超时才生效；项目配置任务保留默认值不影响校验。
    validate_target(&input.target, projects, profiles)?;

    Ok(ScheduledTask {
        id: input.id.unwrap_or_default(),
        name,
        enabled: input.enabled,
        timezone: input.timezone.trim().to_string(),
        schedule: input.schedule,
        target: input.target,
        notify: input.notify.unwrap_or(true),
        timeout_minutes,
        created_at: now.timestamp_millis(),
        updated_at: now.timestamp_millis(),
        last_scheduled_at: None,
        last_run_at: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::profile::{EnabledAgents, Project};
    use crate::models::Profile;

    fn profile(id: &str, name: &str, group: &str) -> Profile {
        Profile {
            id: id.into(),
            name: name.into(),
            group: group.into(),
            terminal_type: "cmd".into(),
            startup_path: String::new(),
            startup_commands: Vec::new(),
            environment_variables: Default::default(),
            color_theme: "dark-default".into(),
            tab_color: None,
            window_size: None,
            ssh_host: None,
            ssh_port: None,
            ssh_user: None,
            ssh_auth_type: None,
            ssh_key_path: None,
            ssh_password: None,
            docker_container_id: None,
            docker_container_name: None,
            k8s_namespace: None,
            k8s_pod_name: None,
            k8s_container_name: None,
            mstsc_host: None,
            mstsc_port: None,
            mstsc_user: None,
            mstsc_password: None,
            mstsc_resolution: None,
            created_at: String::new(),
            last_used_at: None,
            pinned: false,
        }
    }

    fn projects() -> Vec<Project> {
        vec![Project {
            name: "TerminalBuddy".into(),
            path: "D:/terminal-buddy".into(),
            startup_command: String::new(),
            enabled_agents: EnabledAgents::default(),
        }]
    }

    fn input(target: TaskTarget, schedule: TaskSchedule) -> ScheduledTaskInput {
        ScheduledTaskInput {
            id: None,
            name: "测试任务".into(),
            enabled: true,
            timezone: "Asia/Shanghai".into(),
            schedule,
            target,
            notify: None,
            timeout_minutes: None,
        }
    }

    #[test]
    fn invalid_cron_and_timezone_are_rejected() {
        let target = TaskTarget::ProjectProfile {
            project_name: "TerminalBuddy".into(),
            profile_id: "p1".into(),
            auto_close_minutes: 0,
        };
        let profiles = vec![profile("p1", "开发环境", "TerminalBuddy")];
        let bad_cron = input(target.clone(), TaskSchedule::Cron { expression: "not a cron".into() });
        assert!(validate_input(bad_cron, &projects(), &profiles).is_err());

        let mut bad_zone = input(target.clone(), TaskSchedule::Cron { expression: "0 9 * * *".into() });
        bad_zone.timezone = "Mars/Olympus".into();
        assert!(validate_input(bad_zone, &projects(), &profiles).is_err());

        let missing = input(
            TaskTarget::ProjectProfile {
                project_name: "不存在的项目".into(),
                profile_id: "p1".into(),
                auto_close_minutes: 0,
            },
            TaskSchedule::Cron { expression: "0 9 * * *".into() },
        );
        assert!(validate_input(missing, &projects(), &profiles).is_err());
    }

    #[test]
    fn save_rejects_unknown_project_profile_provider() {
        let projects = projects();
        let profiles = vec![profile("p1", "开发环境", "OtherProject")];
        let wrong_group = input(
            TaskTarget::ProjectProfile {
                project_name: "TerminalBuddy".into(),
                profile_id: "p1".into(),
                auto_close_minutes: 0,
            },
            TaskSchedule::Cron { expression: "0 9 * * *".into() },
        );
        assert!(validate_input(wrong_group, &projects, &profiles).is_err());

        let missing_profile = input(
            TaskTarget::ProjectProfile {
                project_name: "TerminalBuddy".into(),
                profile_id: "missing".into(),
                auto_close_minutes: 0,
            },
            TaskSchedule::Cron { expression: "0 9 * * *".into() },
        );
        assert!(validate_input(missing_profile, &projects, &profiles).is_err());

        let missing_provider = input(
            TaskTarget::AgentPrompt {
                project_name: "TerminalBuddy".into(),
                agent: "claude".into(),
                provider_id: Some("llm:definitely-missing".into()),
                model: Some("deepseek-chat".into()),
                prompt: "汇总今天的提交".into(),
            },
            TaskSchedule::Cron { expression: "0 9 * * *".into() },
        );
        assert!(validate_input(missing_provider, &projects, &profiles).is_err());
    }

    #[test]
    fn task_json_uses_camel_case_fields_and_kinds() {
        let target = TaskTarget::AgentPrompt {
            project_name: "TerminalBuddy".into(),
            agent: "claude".into(),
            provider_id: Some("llm:abc".into()),
            model: Some("deepseek-chat".into()),
            prompt: "汇总提交".into(),
        };
        let value = serde_json::to_value(&target).unwrap();
        assert_eq!(value["kind"], "agentPrompt");
        assert_eq!(value["projectName"], "TerminalBuddy");
        assert_eq!(value["providerId"], "llm:abc");
        assert!(value.get("project_name").is_none());

        let schedule = serde_json::to_value(TaskSchedule::Once { run_at: "2026-11-20T09:00".into() }).unwrap();
        assert_eq!(schedule["kind"], "once");
        assert_eq!(schedule["runAt"], "2026-11-20T09:00");

        // 前端提交的输入按同一组 camelCase 键反序列化。
        let input: ScheduledTaskInput = serde_json::from_value(serde_json::json!({
            "name": "测试任务",
            "enabled": true,
            "timezone": "Asia/Shanghai",
            "schedule": { "kind": "cron", "expression": "0 9 * * *" },
            "target": {
                "kind": "projectProfile",
                "projectName": "TerminalBuddy",
                "profileId": "p1",
                "autoCloseMinutes": 30
            }
        }))
        .unwrap();
        assert_eq!(input.name, "测试任务");
    }

    #[test]
    fn antigravity_target_ignores_provider_and_model() {
        let target = TaskTarget::AgentPrompt {
            project_name: "TerminalBuddy".into(),
            agent: "antigravity".into(),
            provider_id: Some("llm:stale".into()),
            model: Some("gemini-3-pro".into()),
            prompt: "汇总今天的提交".into(),
        };
        let task = validate_input(
            input(target, TaskSchedule::Cron { expression: "0 9 * * *".into() }),
            &projects(),
            &[],
        )
        .unwrap();
        match task.target {
            TaskTarget::AgentPrompt { agent, provider_id, model, .. } => {
                assert_eq!(agent, "antigravity");
                assert_eq!(provider_id, None);
                assert_eq!(model, None);
            }
            _ => panic!("应为 Agent 任务"),
        }
    }

    #[test]
    fn name_prompt_and_timeout_are_bounded() {
        let projects = projects();
        let profiles = vec![profile("p1", "开发环境", "TerminalBuddy")];
        let target = TaskTarget::AgentPrompt {
            project_name: "TerminalBuddy".into(),
            agent: "claude".into(),
            provider_id: None,
            model: None,
            prompt: "  ".into(),
        };
        let empty_prompt = input(target, TaskSchedule::Cron { expression: "0 9 * * *".into() });
        assert!(validate_input(empty_prompt, &projects, &profiles).is_err());

        let mut too_long = input(
            TaskTarget::ProjectProfile {
                project_name: "TerminalBuddy".into(),
                profile_id: "p1".into(),
                auto_close_minutes: 0,
            },
            TaskSchedule::Cron { expression: "0 9 * * *".into() },
        );
        too_long.name = "x".repeat(41);
        assert!(validate_input(too_long, &projects, &profiles).is_err());

        let mut bad_timeout = input(
            TaskTarget::ProjectProfile {
                project_name: "TerminalBuddy".into(),
                profile_id: "p1".into(),
                auto_close_minutes: 0,
            },
            TaskSchedule::Cron { expression: "0 9 * * *".into() },
        );
        bad_timeout.timeout_minutes = Some(MAX_TIMEOUT_MINUTES + 1);
        assert!(validate_input(bad_timeout, &projects, &profiles).is_err());
    }
}
