import { invoke } from '@tauri-apps/api/core';

export interface BotChannelConfig {
  id: string;
  name: string;
  platform: 'feishu' | 'weixin' | 'dingtalk' | 'qq' | 'bridge';
  enabled: boolean;
  targetId: string;
  receiveIdType: string;
  webhookUrl: string;
  appId: string;
  secret: string;
  callbackToken: string;
  allowedUserIds: string[];
  hasSecret: boolean;
  hasCallbackToken: boolean;
}

export interface BotSettings {
  enabled: boolean;
  sendDecisionNotifications: boolean;
  sendCompletionNotifications: boolean;
  decisionTtlMinutes: number;
  appendEnter: boolean;
  channels: BotChannelConfig[];
}

export interface BotDeliveryReport {
  channelId: string;
  channelName: string;
  success: boolean;
  messageId?: string;
  error?: string;
}

export interface BotNotificationRequest {
  eventId: string;
  decisionId?: string;
  terminalId: string;
  terminalName: string;
  kind: 'confirmation' | 'question' | 'completed';
  title: string;
  summary: string;
  decisionTitle?: string;
  decisionQuestion?: string;
  decisionOptions?: BotDecisionOption[];
  decisionMultiSelect?: boolean;
  decisionSubmitMoveCount?: number;
  customOptionDownCount?: number;
}

export interface BotLongConnectionStatus {
  channelId: string;
  state: 'connecting' | 'connected' | 'disconnected' | 'error';
  error?: string;
}

export interface BotDecisionOption {
  label: string;
  description?: string;
  moveCount: number;
  recommended: boolean;
  selected?: boolean;
}

export interface ScanBeginResult {
  platform: 'feishu' | 'weixin' | 'dingtalk';
  qrUrl: string;
  handle: string;
  interval: number;
  expireIn: number;
}

export interface ScanCredentials {
  appId: string;
  appSecret: string;
  targetId?: string;
  baseUrl?: string;
}

export interface ScanPollResult {
  status: 'waiting' | 'success' | 'expired' | 'failed';
  credentials?: ScanCredentials;
  error?: string;
}

export async function getBotSettings(): Promise<BotSettings> {
  return invoke('get_bot_settings');
}

export async function getBotLongConnectionStatus(): Promise<BotLongConnectionStatus[]> {
  return invoke('get_bot_long_connection_status');
}

export async function getBotCallbackBaseUrl(): Promise<string> {
  return invoke('get_bot_callback_base_url');
}

export async function saveBotSettings(settings: BotSettings): Promise<BotSettings> {
  const saved = await invoke<BotSettings>('save_bot_settings', { settings });
  window.dispatchEvent(new CustomEvent('bot-settings-changed', { detail: saved }));
  return saved;
}

export async function sendBotNotification(request: BotNotificationRequest): Promise<BotDeliveryReport[]> {
  return invoke('send_bot_notification', { request });
}

export async function testBotChannel(channelId: string): Promise<BotDeliveryReport> {
  return invoke('test_bot_channel', { channelId });
}

export async function verifyBotChannel(channel: BotChannelConfig): Promise<BotDeliveryReport> {
  return invoke('verify_bot_channel', { channel });
}

export async function testBotDecisionChannel(channelId: string): Promise<BotDeliveryReport> {
  return invoke('test_bot_decision_channel', { channelId });
}

export async function botScanBegin(platform: 'feishu' | 'weixin' | 'dingtalk'): Promise<ScanBeginResult> {
  return invoke('bot_scan_begin', { platform });
}

export async function botScanPoll(begin: ScanBeginResult): Promise<ScanPollResult> {
  return invoke('bot_scan_poll', { begin });
}
