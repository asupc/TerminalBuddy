// 窗口控制始终属于本机外壳，远程工作区也不能把它转发到服务器。
import { invoke } from '@tauri-apps/api/core';

// Window Commands (bypass ACL bug)
export async function windowMinimize(): Promise<void> {
  return invoke('window_minimize');
}

export async function windowToggleMaximize(): Promise<void> {
  return invoke('window_toggle_maximize');
}

export async function windowClose(): Promise<void> {
  return invoke('window_close');
}

export async function windowExitApp(): Promise<void> {
  return invoke('window_exit_app');
}
