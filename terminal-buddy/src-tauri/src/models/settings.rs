use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum CloseBehavior {
    Exit,
    Tray,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default = "default_close_behavior")]
    pub close_behavior: CloseBehavior,
}

fn default_close_behavior() -> CloseBehavior {
    CloseBehavior::Exit
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            close_behavior: CloseBehavior::Exit,
        }
    }
}
