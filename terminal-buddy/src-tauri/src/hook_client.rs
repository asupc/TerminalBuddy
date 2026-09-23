use std::io::{Read, Write};
use std::time::Duration;

use crate::services::CLAUDE_HOOK_CLIENT_ARG;

const MAX_HOOK_BODY_BYTES: u64 = 1024 * 1024;

pub fn is_claude_hook_client_process() -> bool {
    std::env::args().nth(1).as_deref() == Some(CLAUDE_HOOK_CLIENT_ARG)
}

fn parse_hook_port(value: Option<&str>) -> Option<u16> {
    value?.trim().parse::<u16>().ok().filter(|port| *port > 0)
}

pub fn run_claude_hook_client() {
    let Some(terminal_id) = std::env::var("TERMINAL_BUDDY_TERMINAL_ID")
        .ok()
        .filter(|value| !value.is_empty())
    else {
        return;
    };
    let Some(token) = std::env::var("TERMINAL_BUDDY_HOOK_TOKEN")
        .ok()
        .filter(|value| !value.is_empty())
    else {
        return;
    };
    let port_value = std::env::var("TERMINAL_BUDDY_HOOK_PORT").ok();
    let Some(port) = parse_hook_port(port_value.as_deref()) else {
        return;
    };
    let hook_url = format!("http://127.0.0.1:{}/api/claude/hooks", port);

    let mut body = Vec::new();
    if std::io::stdin()
        .take(MAX_HOOK_BODY_BYTES + 1)
        .read_to_end(&mut body)
        .is_err()
        || body.len() as u64 > MAX_HOOK_BODY_BYTES
    {
        return;
    }

    let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    else {
        return;
    };
    let response_body = runtime.block_on(async move {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(2))
            .timeout(Duration::from_secs(90_000))
            .build()
            .ok()?;
        let response = client
            .post(hook_url)
            .header("Authorization", format!("Bearer {}", token))
            .header("X-TerminalBuddy-Terminal-Id", terminal_id)
            .header("Content-Type", "application/json")
            .body(body)
            .send()
            .await
            .ok()?;
        if !response.status().is_success() {
            return None;
        }
        response.bytes().await.ok().map(|bytes| bytes.to_vec())
    });

    if let Some(body) = response_body.filter(|body| !body.is_empty()) {
        let mut stdout = std::io::stdout().lock();
        let _ = stdout.write_all(&body);
        let _ = stdout.flush();
    }
}

#[cfg(test)]
mod tests {
    use super::parse_hook_port;

    #[test]
    fn hook_port_requires_an_explicit_nonzero_u16() {
        assert_eq!(parse_hook_port(Some("19601")), Some(19601));
        assert_eq!(parse_hook_port(Some(" 19601 ")), Some(19601));
        assert_eq!(parse_hook_port(None), None);
        assert_eq!(parse_hook_port(Some("")), None);
        assert_eq!(parse_hook_port(Some("0")), None);
        assert_eq!(parse_hook_port(Some("65536")), None);
        assert_eq!(parse_hook_port(Some("invalid")), None);
    }
}
