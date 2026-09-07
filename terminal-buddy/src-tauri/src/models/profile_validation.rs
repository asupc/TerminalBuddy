//! profile 连接字段的语法校验，以及写入交互式 cmd.exe 的参数 quoting。
//!
//! 终端的基础 PTY 固定是 `cmd.exe`，ssh / docker / kubectl 启动命令是以「文本行 +
//! 回车」写进这个交互式 shell 的（见 `commands/terminal.rs::schedule_delayed_input`），
//! 没法改成 argv 直启。因此配置值一旦含 `&`、`|`、换行等字符，就能改变命令结构、
//! 甚至追加第二条命令。防线分两层，两层都必须存在：
//!
//! 1. **字段级校验**：`validate_profile_connection_fields` 在保存 / 导入 profile 时
//!    执行，把非法值挡在磁盘之外；
//! 2. **构造期校验 + quoting**：`build_init_commands` 拼命令时再跑一遍，因为磁盘上
//!    可能存在旧版本写入、或用户手工编辑过的 profile JSON。
//!
//! 本模块只放纯函数，全部带单元测试。

use super::Profile;

/// 拒绝所有控制字符。
///
/// CR / LF 写入 PTY 等于「回车执行」，直接构成第二条命令；NUL 和其他控制字符会被
/// cmd.exe 与目标程序以不可预期的方式处理。
pub fn reject_control_chars(field_label: &str, value: &str) -> Result<(), String> {
    if let Some(bad) = value.chars().find(|c| c.is_control()) {
        return Err(format!(
            "「{}」不能包含控制字符（换行、回车、制表符、NUL 等）。检测到 U+{:04X}，请删除后重试。",
            field_label, bad as u32
        ));
    }
    Ok(())
}

/// 需要靠双引号隔离才能安全出现在 cmd.exe 命令行里的字符。
///
/// 引号区间内 cmd.exe 不再解释 `& | < > ^ ( )`，因此加引号即可；`"` 和 `%` 无法靠
/// 引号隔离，由 `quote_cmd_argument` 单独拒绝。
fn needs_cmd_quoting(c: char) -> bool {
    c.is_whitespace()
        || matches!(
            c,
            '&' | '|' | '<' | '>' | '^' | '(' | ')' | '!' | ';' | ',' | '=' | '\'' | '`'
        )
}

/// 把一个值安全地放进写给 cmd.exe 的命令行。**替代原先误导性的 `shell_escape`**。
///
/// 命令行会被解析两次，两层规则不同：
/// - cmd.exe 只按成对的 `"` 划分引号区间，区间内的元字符失效；
/// - `%VAR%` 即使在引号内也会被 cmd.exe 展开，无法靠引号隔离；
/// - 目标程序的 CRT 把 `\"` 当成转义引号，所以引号内结尾的反斜杠必须成对，
///   否则 `"C:\dir\"` 会被解析成 `C:\dir"`。
///
/// 所以：含 `"` 或 `%` 的值直接拒绝（无法安全表达）；其余含空格 / 元字符的值用 `"`
/// 包裹，并把结尾连续的反斜杠成对化。POSIX 风格的 `\"` 转义在 cmd.exe 下无效，
/// 本函数不使用。
pub fn quote_cmd_argument(field_label: &str, value: &str) -> Result<String, String> {
    reject_control_chars(field_label, value)?;
    if let Some(bad) = value.chars().find(|c| matches!(c, '"' | '%')) {
        return Err(format!(
            "「{}」不能包含字符 {:?}：它在 cmd.exe 命令行中无法被安全转义。请去掉后重试。",
            field_label, bad
        ));
    }
    if value.is_empty() {
        return Ok("\"\"".to_string());
    }
    if !value.chars().any(needs_cmd_quoting) {
        return Ok(value.to_string());
    }
    let trailing_backslashes = value.len() - value.trim_end_matches('\\').len();
    let mut quoted = String::with_capacity(value.len() + trailing_backslashes + 2);
    quoted.push('"');
    quoted.push_str(value);
    for _ in 0..trailing_backslashes {
        quoted.push('\\');
    }
    quoted.push('"');
    Ok(quoted)
}

/// 拒绝以 `-` 开头的值。
///
/// 这类值会被目标程序当成选项而不是位置参数，例如 ssh 的 `-oProxyCommand=...`
/// 可以直接执行任意本地命令；docker / kubectl 也有等价的危险选项。
fn reject_option_like(field_label: &str, value: &str) -> Result<(), String> {
    if value.starts_with('-') {
        return Err(format!(
            "「{}」不能以「-」开头：它会被当成命令选项而不是参数值。",
            field_label
        ));
    }
    Ok(())
}

/// 逐字符白名单校验。`extra` 是除字母、数字之外额外允许的字符。
fn validate_charset(field_label: &str, value: &str, extra: &[char], hint: &str) -> Result<(), String> {
    reject_control_chars(field_label, value)?;
    if let Some(bad) = value
        .chars()
        .find(|c| !c.is_ascii_alphanumeric() && !extra.contains(c))
    {
        return Err(format!(
            "「{}」包含不允许的字符 {:?}。{}",
            field_label, bad, hint
        ));
    }
    Ok(())
}

/// SSH 主机：域名、IPv4，或用方括号包裹的 IPv6。
pub fn validate_ssh_host(value: &str) -> Result<(), String> {
    let field_label = "SSH 主机";
    reject_control_chars(field_label, value)?;
    reject_option_like(field_label, value)?;
    let inner = match value.strip_prefix('[') {
        Some(rest) => rest.strip_suffix(']').ok_or_else(|| {
            "「SSH 主机」以「[」开头时必须以「]」结尾（IPv6 写法，如 [2001:db8::1]）。".to_string()
        })?,
        None => value,
    };
    if inner.is_empty() {
        return Err("「SSH 主机」不能为空。".to_string());
    }
    let extra: &[char] = if value.starts_with('[') {
        &['.', '-', '_', ':']
    } else {
        &['.', '-', '_']
    };
    validate_charset(
        field_label,
        inner,
        extra,
        "只允许字母、数字、「.」「-」「_」；IPv6 请写成 [2001:db8::1] 形式。",
    )
}

/// SSH 用户名：不含 `@`（会改变 `user@host` 结构）和空格。
pub fn validate_ssh_user(value: &str) -> Result<(), String> {
    let field_label = "SSH 用户名";
    reject_control_chars(field_label, value)?;
    reject_option_like(field_label, value)?;
    validate_charset(
        field_label,
        value,
        &['.', '-', '_', '$', '\\'],
        "只允许字母、数字、「.」「-」「_」「$」「\\」；不能包含「@」或空格。",
    )
}

/// Kubernetes 资源名：RFC 1123 label —— 小写字母 / 数字 / `-`，首尾必须是字母数字，
/// 最长 63 字符。namespace、pod、container 都用这一套规则。
pub fn validate_k8s_name(field_label: &str, value: &str) -> Result<(), String> {
    reject_control_chars(field_label, value)?;
    if value.len() > 63 {
        return Err(format!(
            "「{}」不能超过 63 个字符（Kubernetes 名称长度上限）。",
            field_label
        ));
    }
    validate_charset(
        field_label,
        value,
        &['-'],
        "Kubernetes 名称只允许小写字母、数字和「-」。",
    )?;
    if value.chars().any(|c| c.is_ascii_uppercase()) {
        return Err(format!(
            "「{}」不能包含大写字母：Kubernetes 名称必须全小写。",
            field_label
        ));
    }
    let first_last_ok = |c: Option<char>| c.is_some_and(|c| c.is_ascii_alphanumeric());
    if !first_last_ok(value.chars().next()) || !first_last_ok(value.chars().last()) {
        return Err(format!(
            "「{}」必须以字母或数字开头和结尾，不能以「-」开头或结尾。",
            field_label
        ));
    }
    Ok(())
}

/// Docker 容器名或 ID：`[a-zA-Z0-9][a-zA-Z0-9_.-]*`（与 Docker 自身的命名规则一致）。
pub fn validate_docker_container(value: &str) -> Result<(), String> {
    let field_label = "Docker 容器";
    reject_control_chars(field_label, value)?;
    validate_charset(
        field_label,
        value,
        &['_', '.', '-'],
        "Docker 容器名只允许字母、数字、「_」「.」「-」。",
    )?;
    if !value.chars().next().is_some_and(|c| c.is_ascii_alphanumeric()) {
        return Err("「Docker 容器」必须以字母或数字开头。".to_string());
    }
    Ok(())
}

/// SSH 私钥路径：Windows 路径可以带空格和中文，因此不做字符白名单，只挡掉
/// `quote_cmd_argument` 无法安全表达的字符，以及会被当成选项的前导 `-`。
pub fn validate_ssh_key_path(value: &str) -> Result<(), String> {
    let field_label = "SSH 私钥路径";
    reject_option_like(field_label, value)?;
    quote_cmd_argument(field_label, value)?;
    Ok(())
}

/// 取出「已填写」的字段值。未填写（`None` 或纯空白）的字段跳过校验，否则新建的空白
/// profile 无法保存。
///
/// 返回的是原始值而不是 `trim()` 结果：构造命令时用的也是原始值，两处必须一致，
/// 否则会出现「校验时合法、构造时变形」。`build_init_commands` 也用这个函数判断
/// 字段是否填写，保证两层的「空」定义完全一致。
pub fn filled_field(field: &Option<String>) -> Option<&str> {
    field.as_deref().filter(|value| !value.trim().is_empty())
}

/// 保存 / 导入 profile 时的统一入口：校验所有会进入命令行的连接字段。
///
/// 不按 `terminal_type` 分支——切换过类型的 profile 会残留其他类型的字段，这些字段
/// 将来可能重新生效，因此只要填写了就必须合法。
pub fn validate_profile_connection_fields(profile: &Profile) -> Result<(), String> {
    if let Some(value) = filled_field(&profile.ssh_host) {
        validate_ssh_host(value)?;
    }
    if let Some(value) = filled_field(&profile.ssh_user) {
        validate_ssh_user(value)?;
    }
    if let Some(value) = filled_field(&profile.ssh_key_path) {
        validate_ssh_key_path(value)?;
    }
    if let Some(value) = filled_field(&profile.docker_container_name) {
        validate_docker_container(value)?;
    }
    if let Some(value) = filled_field(&profile.docker_container_id) {
        validate_docker_container(value)?;
    }
    if let Some(value) = filled_field(&profile.k8s_namespace) {
        validate_k8s_name("Kubernetes 命名空间", value)?;
    }
    if let Some(value) = filled_field(&profile.k8s_pod_name) {
        validate_k8s_name("Kubernetes Pod", value)?;
    }
    if let Some(value) = filled_field(&profile.k8s_container_name) {
        validate_k8s_name("Kubernetes 容器", value)?;
    }
    // 远程桌面走 argv 直启（`commands/mstsc.rs`），不存在注入面，但控制字符同样会让
    // 参数失效，所以一并挡掉。
    for (field_label, value) in [
        ("远程桌面主机", &profile.mstsc_host),
        ("远程桌面用户名", &profile.mstsc_user),
        ("远程桌面分辨率", &profile.mstsc_resolution),
    ] {
        if let Some(value) = filled_field(value) {
            reject_control_chars(field_label, value)?;
        }
    }
    for command in &profile.startup_commands {
        reject_control_chars("启动命令", command)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 合法的普通值不加引号，原样通过；空值必须显式变成 `""`，否则参数会消失。
    #[test]
    fn quotes_only_when_needed() {
        assert_eq!(quote_cmd_argument("字段", "id_rsa"), Ok("id_rsa".into()));
        assert_eq!(
            quote_cmd_argument("字段", "C:\\Users\\dev\\.ssh\\id_rsa"),
            Ok("C:\\Users\\dev\\.ssh\\id_rsa".into())
        );
        assert_eq!(quote_cmd_argument("字段", ""), Ok("\"\"".into()));
    }

    /// 验收标准：含空格和中文的合法 key path 必须能正常工作。
    #[test]
    fn quotes_paths_with_spaces_and_chinese() {
        assert_eq!(
            quote_cmd_argument("字段", "C:\\my keys\\id_ed25519"),
            Ok("\"C:\\my keys\\id_ed25519\"".into())
        );
        assert_eq!(
            quote_cmd_argument("字段", "D:\\密钥 目录\\张三.pem"),
            Ok("\"D:\\密钥 目录\\张三.pem\"".into())
        );
    }

    /// 引号内结尾的反斜杠必须成对，否则目标程序的 CRT 会把 `\"` 当成转义引号，
    /// 把后面的内容一起吞进同一个参数。
    #[test]
    fn doubles_trailing_backslashes_inside_quotes() {
        assert_eq!(
            quote_cmd_argument("字段", "C:\\my dir\\"),
            Ok("\"C:\\my dir\\\\\"".into())
        );
        assert_eq!(
            quote_cmd_argument("字段", "C:\\my dir\\\\"),
            Ok("\"C:\\my dir\\\\\\\\\"".into())
        );
        // 不需要加引号时不动结尾反斜杠：没有引号就不存在 `\"` 歧义。
        assert_eq!(
            quote_cmd_argument("字段", "C:\\dir\\"),
            Ok("C:\\dir\\".into())
        );
    }

    /// `"` 和 `%` 无法靠 cmd.exe 引号隔离，只能拒绝。
    #[test]
    fn rejects_unquotable_characters() {
        for value in ["a\"b", "%USERPROFILE%\\id_rsa", "50%", "\""] {
            assert!(
                quote_cmd_argument("字段", value).is_err(),
                "「{}」应当被拒绝",
                value
            );
        }
    }

    /// 验收标准：`\r` / `\n` 不能形成额外命令；`&` `|` 等元字符必须被引号中和。
    #[test]
    fn rejects_control_chars_and_neutralizes_metachars() {
        for value in ["a\rb", "a\nb", "a\0b", "a\tb", "\r\ncalc"] {
            assert!(
                quote_cmd_argument("字段", value).is_err(),
                "「{}」应当被拒绝",
                value.escape_debug()
            );
        }
        // 元字符本身允许出现在路径里，但必须落进引号区间才不会改变命令结构。
        for value in ["a&calc", "a|calc", "a>out", "a<in", "a^b", "a(b)"] {
            let quoted = quote_cmd_argument("字段", value).expect("应当通过并加引号");
            assert_eq!(quoted, format!("\"{}\"", value), "原值：{}", value);
        }
    }

    #[test]
    fn reject_control_chars_reports_code_point() {
        let err = reject_control_chars("SSH 主机", "a\rb").unwrap_err();
        assert!(err.contains("控制字符"), "实际错误：{}", err);
        assert!(err.contains("U+000D"), "实际错误：{}", err);
        assert!(reject_control_chars("SSH 主机", "example.com").is_ok());
    }

    #[test]
    fn accepts_valid_ssh_hosts() {
        for value in [
            "example.com",
            "192.168.1.10",
            "my-host_1",
            "[2001:db8::1]",
            "[::1]",
        ] {
            assert_eq!(validate_ssh_host(value), Ok(()), "「{}」应当被接受", value);
        }
    }

    /// `-oProxyCommand=...` 是 ssh 上真实可用的本地命令执行入口，必须在 host / user
    /// 两个位置都挡住。
    #[test]
    fn rejects_malicious_ssh_hosts() {
        for value in [
            "-oProxyCommand=calc",
            "a&calc",
            "a|calc",
            "host;calc",
            "a b",
            "a\rb",
            "%COMPUTERNAME%",
            "a\"b",
            "[2001:db8::1",
            "[]",
            "2001:db8::1",
        ] {
            assert!(
                validate_ssh_host(value).is_err(),
                "「{}」应当被拒绝",
                value.escape_debug()
            );
        }
    }

    /// 用户名里的 `@` 会改变 `user@host` 的结构，等于换了一台目标主机。
    #[test]
    fn validates_ssh_user() {
        for value in ["root", "dev.user", "DOMAIN\\admin", "svc$", "user-1"] {
            assert_eq!(validate_ssh_user(value), Ok(()), "「{}」应当被接受", value);
        }
        for value in ["a@b", "a b", "-l", "a|calc", "a\nb", "%USERNAME%"] {
            assert!(
                validate_ssh_user(value).is_err(),
                "「{}」应当被拒绝",
                value.escape_debug()
            );
        }
    }

    #[test]
    fn validates_k8s_names() {
        for value in ["default", "my-pod-1", "a", "kube-system"] {
            assert_eq!(
                validate_k8s_name("Kubernetes Pod", value),
                Ok(()),
                "「{}」应当被接受",
                value
            );
        }
        for value in ["Default", "-pod", "pod-", "my_pod", "a b", "pod;calc", "a\rb"] {
            assert!(
                validate_k8s_name("Kubernetes Pod", value).is_err(),
                "「{}」应当被拒绝",
                value.escape_debug()
            );
        }
        assert!(validate_k8s_name("Kubernetes Pod", &"a".repeat(64)).is_err());
        assert!(validate_k8s_name("Kubernetes Pod", &"a".repeat(63)).is_ok());
    }

    #[test]
    fn validates_docker_container() {
        for value in ["my_container", "a.b-c", "0abc123def", "web"] {
            assert_eq!(
                validate_docker_container(value),
                Ok(()),
                "「{}」应当被接受",
                value
            );
        }
        for value in ["_x", "-x", ".x", "a/b", "a b", "a&calc", "a\nb", "%X%"] {
            assert!(
                validate_docker_container(value).is_err(),
                "「{}」应当被拒绝",
                value.escape_debug()
            );
        }
    }

    #[test]
    fn validates_ssh_key_path() {
        for value in [
            "C:\\Users\\dev\\.ssh\\id_rsa",
            "C:\\my keys\\id_ed25519",
            "D:\\密钥 目录\\张三.pem",
            "..\\keys\\id_rsa",
        ] {
            assert_eq!(
                validate_ssh_key_path(value),
                Ok(()),
                "「{}」应当被接受",
                value
            );
        }
        for value in [
            "%USERPROFILE%\\.ssh\\id_rsa",
            "a\"b",
            "-i",
            "C:\\keys\\id_rsa\r\ncalc",
        ] {
            assert!(
                validate_ssh_key_path(value).is_err(),
                "「{}」应当被拒绝",
                value.escape_debug()
            );
        }
    }

    /// 新建的空白 profile：所有连接字段都是 `None`，必须能通过校验。
    fn blank_profile() -> Profile {
        Profile {
            id: "p1".into(),
            name: "测试连接".into(),
            group: "默认".into(),
            terminal_type: "ssh".into(),
            startup_path: String::new(),
            startup_commands: Vec::new(),
            environment_variables: std::collections::HashMap::new(),
            color_theme: "default".into(),
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
            created_at: "2026-09-06T00:00:00Z".into(),
            last_used_at: None,
            pinned: false,
        }
    }

    #[test]
    fn accepts_blank_and_valid_profiles() {
        assert_eq!(validate_profile_connection_fields(&blank_profile()), Ok(()));

        let mut profile = blank_profile();
        profile.ssh_host = Some("example.com".into());
        profile.ssh_user = Some("root".into());
        profile.ssh_key_path = Some("D:\\密钥 目录\\id_rsa".into());
        // 空串等同未填写，不参与校验。
        profile.k8s_namespace = Some(String::new());
        profile.docker_container_name = Some("   ".into());
        assert_eq!(validate_profile_connection_fields(&profile), Ok(()));
    }

    /// 验收标准：含 `\r`、`\n`、`"`、`&`、`|`、`%VAR%` 的恶意字段不能落盘。
    #[test]
    fn rejects_injection_payloads_in_every_field() {
        let payloads = [
            "example.com\rcalc",
            "example.com\ncalc",
            "example.com&calc",
            "example.com|calc",
            "example.com\"calc",
            "%COMPUTERNAME%",
        ];
        for payload in payloads {
            let mut profile = blank_profile();
            profile.ssh_host = Some(payload.into());
            assert!(
                validate_profile_connection_fields(&profile).is_err(),
                "ssh_host = 「{}」应当被拒绝",
                payload.escape_debug()
            );

            let mut profile = blank_profile();
            profile.ssh_user = Some(payload.into());
            assert!(
                validate_profile_connection_fields(&profile).is_err(),
                "ssh_user = 「{}」应当被拒绝",
                payload.escape_debug()
            );

            let mut profile = blank_profile();
            profile.docker_container_name = Some(payload.into());
            assert!(
                validate_profile_connection_fields(&profile).is_err(),
                "docker_container_name = 「{}」应当被拒绝",
                payload.escape_debug()
            );

            let mut profile = blank_profile();
            profile.k8s_pod_name = Some(payload.into());
            assert!(
                validate_profile_connection_fields(&profile).is_err(),
                "k8s_pod_name = 「{}」应当被拒绝",
                payload.escape_debug()
            );
        }
    }

    /// 启动命令按「文本 + 回车」写入 PTY，命令内部再夹一个回车就等于多执行一条命令。
    #[test]
    fn rejects_control_chars_in_startup_commands() {
        let mut profile = blank_profile();
        profile.startup_commands = vec!["git status".into(), "npm run dev\rcalc".into()];
        assert!(validate_profile_connection_fields(&profile).is_err());

        let mut profile = blank_profile();
        profile.startup_commands = vec!["git status".into(), "echo a & echo b".into()];
        assert_eq!(validate_profile_connection_fields(&profile), Ok(()));
    }

    /// 远程桌面走 argv，元字符无害，但控制字符会让参数失效。
    #[test]
    fn rejects_control_chars_in_mstsc_fields() {
        let mut profile = blank_profile();
        profile.mstsc_host = Some("10.0.0.5".into());
        profile.mstsc_user = Some("DOMAIN\\admin".into());
        profile.mstsc_resolution = Some("1920x1080".into());
        assert_eq!(validate_profile_connection_fields(&profile), Ok(()));

        profile.mstsc_host = Some("10.0.0.5\r".into());
        assert!(validate_profile_connection_fields(&profile).is_err());
    }

    /// 首尾空白不会被静默 trim 掉，而是按非法字符拒绝：校验值必须和构造命令时用的值一致。
    #[test]
    fn rejects_padded_values_instead_of_trimming() {
        let mut profile = blank_profile();
        profile.ssh_host = Some(" example.com ".into());
        assert!(validate_profile_connection_fields(&profile).is_err());
    }

    /// 错误信息必须是可执行的中文提示，并指出具体字段。
    #[test]
    fn errors_are_actionable_chinese_text() {
        let err = validate_ssh_host("-oProxyCommand=calc").unwrap_err();
        assert!(err.contains("SSH 主机"), "实际错误：{}", err);
        assert!(err.contains("命令选项"), "实际错误：{}", err);

        let err = validate_k8s_name("Kubernetes Pod", "My-Pod").unwrap_err();
        assert!(err.contains("Kubernetes Pod"), "实际错误：{}", err);
        assert!(err.contains("全小写"), "实际错误：{}", err);

        let err = quote_cmd_argument("SSH 私钥路径", "%USERPROFILE%\\id_rsa").unwrap_err();
        assert!(err.contains("SSH 私钥路径"), "实际错误：{}", err);
        assert!(err.contains("无法被安全转义"), "实际错误：{}", err);
    }
}
