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
}> {
  return invoke('get_web_api_status');
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
