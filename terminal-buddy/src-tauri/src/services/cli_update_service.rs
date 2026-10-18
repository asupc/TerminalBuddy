//! 容器 CLI 更新检测，参考 CC Switch 的 dist-tags 查询与预发布通道判断。
use std::{cmp::Ordering, time::Duration};

use reqwest::Client;
use semver::Version;
use serde::Serialize;
use serde_json::{Map, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CliUpdateState {
    Available,
    UpToDate,
    Ahead,
    Unknown,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliUpdate {
    pub latest_version: Option<String>,
    pub state: CliUpdateState,
    pub message: Option<String>,
}

fn parse_version(text: &str) -> Option<Version> {
    Version::parse(text.trim().strip_prefix('v').unwrap_or(text.trim())).ok()
}

fn is_development_build(version: &Version) -> bool {
    let build = version.build.as_str().to_ascii_lowercase();
    let parts: Vec<_> = build.split('.').collect();
    let git_describe = parts.len() >= 2
        && !parts[0].is_empty()
        && parts[0].bytes().all(|byte| byte.is_ascii_digit())
        && parts[1].strip_prefix('g').is_some_and(|hash| {
            hash.len() >= 4 && hash.bytes().all(|byte| byte.is_ascii_hexdigit())
        });
    git_describe || parts.iter().any(|part| matches!(*part, "canary" | "nightly" | "dev" | "dirty" | "snapshot"))
}

pub(crate) fn compare_versions(a: &str, b: &str) -> Option<Ordering> {
    let a = parse_version(a)?;
    let b = parse_version(b)?;
    // 开发构建的版本号可能落后，但实际代码更新，不能据此建议降级。
    if is_development_build(&a) || is_development_build(&b) {
        return None;
    }
    Some(a.cmp_precedence(&b))
}

fn select_latest(tags: &Map<String, Value>, current: Option<&str>, preview_tags: &[&str]) -> Result<String, String> {
    let latest = tags.get("latest").and_then(Value::as_str)
        .filter(|version| parse_version(version).is_some())
        .ok_or("版本源未返回有效的最新版本，请稍后重试")?;
    let mut selected = latest;
    // 与 CC Switch 一致：只有本地领先 latest 时才查看 next，稳定版用户不会被引导到预发布通道。
    if current.and_then(|version| compare_versions(version, latest)) == Some(Ordering::Greater) {
        for tag in preview_tags {
            if let Some(candidate) = tags.get(*tag).and_then(Value::as_str) {
                if compare_versions(candidate, selected) == Some(Ordering::Greater) {
                    selected = candidate;
                }
            }
        }
    }
    Ok(selected.to_string())
}

async fn fetch_dist_tags(client: &Client, url: &str) -> Result<Map<String, Value>, String> {
    let response = client.get(url).send().await
        .map_err(|_| "无法连接版本源，请检查容器网络后重试".to_string())?;
    if !response.status().is_success() {
        return Err(format!("版本查询失败（HTTP {}），请稍后重试", response.status().as_u16()));
    }
    response.json().await.map_err(|_| "版本源返回了无效数据，请稍后重试".to_string())
}

pub(crate) fn refresh_update_state(mut update: CliUpdate, current: Option<&str>) -> CliUpdate {
    if let Some(latest) = update.latest_version.as_deref() {
        update.state = match current.and_then(|version| compare_versions(latest, version)) {
            Some(Ordering::Greater) => CliUpdateState::Available,
            Some(Ordering::Equal) => CliUpdateState::UpToDate,
            Some(Ordering::Less) => CliUpdateState::Ahead,
            None => CliUpdateState::Unknown,
        };
    }
    update
}

fn update_from_tags(tags: Result<Map<String, Value>, String>, current: Option<&str>, preview_tags: &[&str]) -> CliUpdate {
    match tags.and_then(|tags| select_latest(&tags, current, preview_tags)) {
        Ok(latest_version) => refresh_update_state(CliUpdate {
            latest_version: Some(latest_version), state: CliUpdateState::Unknown, message: None,
        }, current),
        Err(message) => CliUpdate { latest_version: None, state: CliUpdateState::Failed, message: Some(message) },
    }
}

pub async fn check_update(package: &str, current: Option<&str>, preview_tags: &[&str]) -> CliUpdate {
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(10))
        .build();
    let tags = match client {
        Ok(client) => {
            // dist-tags 只有少量数据，不拉取包含全部历史版本的完整包元数据。
            let url = format!("https://registry.npmjs.org/-/package/{}/dist-tags", package.replace('/', "%2f"));
            fetch_dist_tags(&client, &url).await
        }
        Err(_) => Err("无法创建版本查询连接，请重试".to_string()),
    };
    update_from_tags(tags, current, preview_tags)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tags(value: Value) -> Map<String, Value> {
        value.as_object().unwrap().clone()
    }

    #[test]
    fn compares_numeric_versions_and_prereleases_without_false_downgrades() {
        for (latest, current, expected) in [
            ("2.1.10", "2.1.9", Some(Ordering::Greater)),
            ("0.116.0", "0.117.0-alpha.1", Some(Ordering::Less)),
            ("0.116.0", "0.116.0-alpha.10", Some(Ordering::Greater)),
            ("0.116.0-alpha.10", "0.116.0-alpha.2", Some(Ordering::Greater)),
            ("0.116.0-beta.1", "0.116.0-alpha.99", Some(Ordering::Greater)),
            ("v2.1.10+linux.1", "2.1.10+linux.2", Some(Ordering::Equal)),
            ("2.1.10", "2.1.9+238.gabc1234", None),
            ("2.1.10", "2.1.9+nightly.1", None),
            ("2.1.10", "2.1", None),
        ] {
            assert_eq!(compare_versions(latest, current), expected, "{latest} vs {current}");
        }
    }

    #[test]
    fn follows_claude_next_only_when_local_version_is_ahead_of_latest() {
        let versions = tags(json!({"latest": "2.1.10", "next": "2.1.12"}));
        for current in [None, Some("2.1.9"), Some("2.1.10")] {
            assert_eq!(select_latest(&versions, current, &["next"]).unwrap(), "2.1.10");
        }
        assert_eq!(select_latest(&versions, Some("2.1.11"), &["next"]).unwrap(), "2.1.12");
        assert_eq!(select_latest(&versions, Some("2.1.11"), &[]).unwrap(), "2.1.10");
        let broken = tags(json!({"latest": "2.1.10", "next": false}));
        assert_eq!(select_latest(&broken, Some("2.1.11"), &["next"]).unwrap(), "2.1.10");
    }

    #[test]
    fn reports_unavailable_or_invalid_versions_as_failures_instead_of_up_to_date() {
        for value in [json!({}), json!({"latest": false}), json!({"latest": "unknown"}), json!({"latest": "1.2.3 extra"})] {
            let result = update_from_tags(Ok(tags(value)), Some("1.0.0"), &[]);
            assert_eq!(result.state, CliUpdateState::Failed);
            assert!(result.latest_version.is_none());
            assert!(result.message.is_some());
        }
        let offline = update_from_tags(Err("网络不可用".into()), Some("1.0.0"), &[]);
        assert_eq!(offline.state, CliUpdateState::Failed);
        assert_eq!(offline.message.as_deref(), Some("网络不可用"));
    }

    #[test]
    fn distinguishes_new_equal_ahead_and_unknown_local_versions() {
        let versions = tags(json!({"latest": "0.116.0"}));
        for (current, expected) in [
            (Some("0.115.0"), CliUpdateState::Available),
            (Some("0.116.0"), CliUpdateState::UpToDate),
            (Some("0.117.0-alpha.1"), CliUpdateState::Ahead),
            (Some("0.116.0+dev.1"), CliUpdateState::Unknown),
            (None, CliUpdateState::Unknown),
        ] {
            let result = update_from_tags(Ok(versions.clone()), current, &[]);
            assert_eq!(result.state, expected);
            assert_eq!(result.latest_version.as_deref(), Some("0.116.0"));
        }
    }

    #[tokio::test]
    async fn handles_registry_http_and_json_errors() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for (status, body, expected_error) in [
            ("200 OK", r#"{"latest":"0.116.0"}"#, None),
            ("503 Service Unavailable", r#"{"latest":"0.116.0"}"#, Some("HTTP 503")),
            ("200 OK", "not-json", Some("无效数据")),
            ("200 OK", "[]", Some("无效数据")),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = [0; 2048];
                let _ = stream.read(&mut request).await.unwrap();
                let response = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                stream.write_all(response.as_bytes()).await.unwrap();
            });
            let client = Client::builder().no_proxy().timeout(Duration::from_secs(2)).build().unwrap();
            let result = fetch_dist_tags(&client, &format!("http://{address}/dist-tags")).await;
            if let Some(message) = expected_error {
                assert!(result.unwrap_err().contains(message));
            } else {
                assert_eq!(result.unwrap().get("latest").and_then(Value::as_str), Some("0.116.0"));
            }
            server.await.unwrap();
        }
    }
}
