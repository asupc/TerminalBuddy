#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use terminal_buddy_lib::{is_claude_hook_client_process, run, run_claude_hook_client};

fn main() {
    if is_claude_hook_client_process() {
        run_claude_hook_client();
        return;
    }
    run();
}
