use serde::{Deserialize, Serialize};

/// 远端 version.json 解析后的结果（驼峰字段供前端使用）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub release_date: String,
    pub changelog_md: String,
    pub download_url: String,
    pub mandatory: bool,
}
