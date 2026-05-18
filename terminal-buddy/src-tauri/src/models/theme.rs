use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomTheme {
    pub id: String,
    pub name: String,
    pub background: String,
    pub foreground: String,
    pub cursor: String,
    pub black: String,
    pub red: String,
    pub green: String,
    pub yellow: String,
    pub blue: String,
    pub magenta: String,
    pub cyan: String,
    pub white: String,
}

impl CustomTheme {
    pub fn new(name: &str) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.to_string(),
            background: String::from("#1e1e1e"),
            foreground: String::from("#cccccc"),
            cursor: String::from("#ffffff"),
            black: String::from("#000000"),
            red: String::from("#cd3131"),
            green: String::from("#0dbc79"),
            yellow: String::from("#e5e510"),
            blue: String::from("#2472c8"),
            magenta: String::from("#bc3fbc"),
            cyan: String::from("#11a8cd"),
            white: String::from("#e5e5e5"),
        }
    }
}
