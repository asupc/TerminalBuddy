use serde::{Deserialize, Serialize};

fn default_true() -> bool {
    true
}

fn default_decision_ttl_minutes() -> u32 {
    30
}

fn default_receive_id_type() -> String {
    "chat_id".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BotChannelConfig {
    pub id: String,
    pub name: String,
    pub platform: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub target_id: String,
    #[serde(default = "default_receive_id_type")]
    pub receive_id_type: String,
    #[serde(default)]
    pub webhook_url: String,
    #[serde(default)]
    pub app_id: String,
    #[serde(default, skip_serializing)]
    pub secret: String,
    #[serde(default, skip_serializing)]
    pub callback_token: String,
    #[serde(default)]
    pub allowed_user_ids: Vec<String>,
    #[serde(default)]
    pub has_secret: bool,
    #[serde(default)]
    pub has_callback_token: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BotSettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_true")]
    pub send_decision_notifications: bool,
    #[serde(default = "default_true")]
    pub send_completion_notifications: bool,
    #[serde(default = "default_decision_ttl_minutes")]
    pub decision_ttl_minutes: u32,
    #[serde(default = "default_true")]
    pub append_enter: bool,
    #[serde(default)]
    pub channels: Vec<BotChannelConfig>,
}

impl Default for BotSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            send_decision_notifications: true,
            send_completion_notifications: true,
            decision_ttl_minutes: 30,
            append_enter: true,
            channels: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BotDeliveryReport {
    pub channel_id: String,
    pub channel_name: String,
    pub success: bool,
    pub message_id: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BotLongConnectionStatus {
    pub channel_id: String,
    pub state: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BotDecisionOption {
    pub label: String,
    pub description: Option<String>,
    pub move_count: i16,
    pub recommended: bool,
    #[serde(default)]
    pub selected: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BotNotificationRequest {
    pub event_id: String,
    pub decision_id: Option<String>,
    pub terminal_id: String,
    pub terminal_name: String,
    pub kind: String,
    pub title: String,
    pub summary: String,
    pub decision_title: Option<String>,
    pub decision_question: Option<String>,
    pub decision_options: Option<Vec<BotDecisionOption>>,
    #[serde(default)]
    pub decision_multi_select: bool,
    pub decision_submit_move_count: Option<i16>,
    pub custom_option_down_count: Option<u16>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionBinding {
    pub decision_id: String,
    pub terminal_id: String,
    pub terminal_name: String,
    pub channel_id: String,
    pub target_id: String,
    pub external_message_id: String,
    #[serde(default)]
    pub custom_option_down_count: Option<u16>,
    #[serde(default)]
    pub option_move_counts: Vec<i16>,
    #[serde(default)]
    pub option_labels: Vec<String>,
    #[serde(default)]
    pub initial_selected_move_counts: Vec<i16>,
    #[serde(default)]
    pub recommended_move_count: Option<i16>,
    #[serde(default)]
    pub multi_select: bool,
    #[serde(default)]
    pub submit_move_count: Option<i16>,
    #[serde(default)]
    pub created_at: i64,
    pub status: String,
    pub expires_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeInboundMessage {
    pub sender_id: String,
    pub conversation_id: String,
    pub message_id: String,
    pub reply_to_message_id: Option<String>,
    pub text: String,
}
