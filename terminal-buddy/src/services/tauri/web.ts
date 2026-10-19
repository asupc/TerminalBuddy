import { invoke } from '@tauri-apps/api/core';

// Web API Commands
export async function saveWebApiSettings(
  enabled: boolean,
  port: number,
  username: string,
  password: string,
  shareSessions: boolean
): Promise<void> {
  return invoke('save_web_api_settings', { enabled, port, username, password, shareSessions });
}

export async function getWebApiStatus(): Promise<{
  enabled: boolean;
  port: number;
  username: string;
  hasPassword: boolean;
  pageTitle: string;
}> {
  return invoke('get_web_api_status');
}

/** Docker 网页端修改管理员登录密码：需验证旧密码，新密码至少 8 个字符。 */
export async function changeWebAdminPassword(oldPassword: string, newPassword: string): Promise<void> {
  return invoke('change_web_admin_password', { oldPassword, newPassword });
}

/** 保存 Docker 网页主页标题（浏览器标签 + 登录页大标题），空字符串恢复默认。 */
export async function saveWebPageTitle(title: string): Promise<void> {
  return invoke('save_web_page_title', { title });
}

export async function restartWebServer(): Promise<string> {
  return invoke('restart_web_server');
}

export async function getWebServerAddress(): Promise<string> {
  return invoke('get_web_server_address');
}

export async function getWebQuickAccessUrl(): Promise<string> {
  return invoke('get_web_quick_access_url');
}

/**
 * 容器重启后恢复页签的一次性服务端租约：多个浏览器同时打开时只允许一个客户端
 * 重建 PTY / 执行 claude --resume。首个调用者返回 true。
 */
export async function claimWebSessionRestore(): Promise<boolean> {
  return invoke('claim_web_session_restore');
}

export async function releaseWebSessionRestore(): Promise<void> {
  return invoke('release_web_session_restore');
}
