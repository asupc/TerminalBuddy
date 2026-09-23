use std::cmp::Ordering;

use crate::models::UpdateInfo;

/// 仓库根 version.json 的 Gitee Raw 地址。
/// 注意：Gitee 仓库默认分支是 master（无 main 分支），分支名改错会 404。
pub const MANIFEST_URL: &str = "https://gitee.com/updateme/terminal-buddy/raw/master/version.json";

/// 比较两个 semver 字符串（点分三段）。
///
/// - 支持可选 `v` 前缀（`v1.4.0` 等价 `1.4.0`）。
/// - 任一版本解析失败 → 返回 `Equal`（保守不提示）。
pub fn compare_versions(a: &str, b: &str) -> Ordering {
    let parse = |s: &str| -> Option<Vec<u32>> {
        let parts: Vec<&str> = s.trim_start_matches('v').split('.').collect();
        if parts.len() != 3 {
            return None;
        }
        parts.iter().map(|p| p.parse::<u32>().ok()).collect()
    };
    match (parse(a), parse(b)) {
        (Some(va), Some(vb)) => va.cmp(&vb),
        _ => Ordering::Equal,
    }
}

/// 拉取并解析远端 version.json；任何错误静默返回 None。
/// 调用方负责决定要不要提示用户（不在此比较版本）。
pub async fn fetch_update_info() -> Option<UpdateInfo> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .ok()?;
    let resp = client.get(MANIFEST_URL).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body: UpdateInfo = resp.json().await.ok()?;
    Some(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn equal() {
        assert_eq!(compare_versions("1.3.0", "1.3.0"), Ordering::Equal);
    }

    #[test]
    fn upgrade_major() {
        assert_eq!(compare_versions("2.0.0", "1.9.9"), Ordering::Greater);
    }

    #[test]
    fn upgrade_minor() {
        assert_eq!(compare_versions("1.4.0", "1.3.9"), Ordering::Greater);
    }

    #[test]
    fn downgrade() {
        assert_eq!(compare_versions("1.3.0", "1.4.0"), Ordering::Less);
    }

    #[test]
    fn with_v_prefix() {
        assert_eq!(compare_versions("v1.4.0", "1.3.0"), Ordering::Greater);
    }

    #[test]
    fn malformed() {
        assert_eq!(compare_versions("bad", "1.0.0"), Ordering::Equal);
        assert_eq!(compare_versions("1.0", "1.0.0"), Ordering::Equal);
    }
}
