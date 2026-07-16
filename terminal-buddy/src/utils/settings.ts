import { readClientData, writeClientData } from '../services/tauri';

export type ThemeMode = 'dark' | 'light' | 'system';

export type BreathingLightColorMode = 'tab' | 'custom';
export type LaunchWindowMode = 'windowed' | 'maximized';
export type TerminalLoadingMode = 'default' | 'vsCode';
export type UiStyle = 'default' | 'sidebar';

export interface AppSettings {
  uiStyle: UiStyle;
  restoreTabsOnStartup: boolean;
  configPanelAutoExpand: boolean;
  fileTreeAutoExpand: boolean;
  closeBehavior: 'exit' | 'tray';
  launchWindowMode: LaunchWindowMode;
  terminalLoadingMode: TerminalLoadingMode;
  enableTabNavigation: boolean;
  singleInstance: boolean;
  rightClickPaste: boolean;
  doubleClickRunBat: boolean;
  zhipuApiKey: string;
  qianfanCookie: string;
  deepseekApiKey: string;
  minimaxApiKey: string;
  arkCookie: string;
  webApiEnabled: boolean;
  webApiPort: number;
  webApiUsername: string;
  breathingLightColorMode: BreathingLightColorMode;
  breathingLightCustomColor: string;
  sshDownloadDir: string;
  serverMonitorInterval: number;
  webApiShareSessions: boolean;
  launchAtLogin: boolean;
  terminalFollowAppTheme: boolean;
  autoResumeClaudeSession: boolean;
  claudeHookConfigDir: string;
  claudeCodeNotifications: boolean;
  claudeDecisionNotifications: boolean;
  claudeDecisionNotificationDelaySeconds: number;
  claudeCompletionNotifications: boolean;
  claudeCompletionNotificationDelaySeconds: number;
  listSelectionStyle: 'default' | 'idea' | 'custom';
  listSelectionBg: string;
  listSelectionFg: string;
  listSelectionBorderColor: string;
  listSelectionBorderWidth: number;
}

const DEFAULT_SETTINGS: AppSettings = {
  uiStyle: 'default',
  restoreTabsOnStartup: true,
  configPanelAutoExpand: true,
  fileTreeAutoExpand: true,
  closeBehavior: 'exit',
  launchWindowMode: 'windowed',
  terminalLoadingMode: 'default',
  enableTabNavigation: true,
  singleInstance: true,
  rightClickPaste: false,
  doubleClickRunBat: false,
  zhipuApiKey: '',
  qianfanCookie: '',
  deepseekApiKey: '',
  minimaxApiKey: '',
  arkCookie: '',
  webApiEnabled: false,
  webApiPort: 9600,
  webApiUsername: 'admin',
  breathingLightColorMode: 'tab',
  breathingLightCustomColor: '#FFC107',
  sshDownloadDir: '',
  serverMonitorInterval: 3,
  webApiShareSessions: false,
  launchAtLogin: false,
  terminalFollowAppTheme: true,
  autoResumeClaudeSession: true,
  claudeHookConfigDir: '',
  claudeCodeNotifications: true,
  claudeDecisionNotifications: true,
  claudeDecisionNotificationDelaySeconds: 0,
  claudeCompletionNotifications: true,
  claudeCompletionNotificationDelaySeconds: 0,
  listSelectionStyle: 'idea',
  listSelectionBg: '#4d7db9',
  listSelectionFg: '#ffffff',
  listSelectionBorderColor: '#ffffff',
  listSelectionBorderWidth: 0,
};

let _cachedSettings: AppSettings | null = null;

export const getAppSettings = (): AppSettings => {
  if (_cachedSettings) return { ...DEFAULT_SETTINGS, ..._cachedSettings };
  return { ...DEFAULT_SETTINGS };
};

export const initAppSettings = async (): Promise<void> => {
  try {
    const raw = await readClientData('settings');
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AppSettings>;
      // 兼容旧版总开关：升级后保留用户此前关闭通知的选择。
      if (parsed.claudeCodeNotifications === false && parsed.claudeDecisionNotifications === undefined) {
        parsed.claudeDecisionNotifications = false;
        parsed.claudeCompletionNotifications = false;
      }
      _cachedSettings = parsed as AppSettings;
    }
  } catch {}
};

export const saveAppSettings = (settings: AppSettings) => {
  _cachedSettings = settings;
  writeClientData('settings', JSON.stringify(settings)).catch(() => {});
  window.dispatchEvent(new CustomEvent('app-settings-changed'));
};

let _cachedTheme: ThemeMode | null = null;

export const getStoredTheme = (): ThemeMode => {
  return _cachedTheme || 'dark';
};

export const saveTheme = (theme: ThemeMode) => {
  _cachedTheme = theme;
  // 后端 client_data_service.write 要求 content 为合法 JSON，裸字符串 'light'/'dark' 会被拒绝，
  // 故用 JSON.stringify 包成 "light"；读取时 initTheme 用 JSON.parse 还原。
  writeClientData('theme', JSON.stringify(theme)).catch(e => console.error('Failed to save theme:', e));
};

export const initTheme = async (): Promise<ThemeMode> => {
  try {
    const raw = await readClientData('theme');
    if (raw) _cachedTheme = JSON.parse(raw) as ThemeMode;
  } catch {}
  return _cachedTheme || 'dark';
};

// 读取当前生效的主题（dark/light）。system 模式下 applyTheme 已解析成具体值写入 data-theme。
export const getEffectiveThemeMode = (): 'dark' | 'light' => {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
};

export const applyTheme = (theme: ThemeMode) => {
  const root = document.documentElement;
  let effective: 'dark' | 'light';
  if (theme === 'system') {
    effective = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } else {
    effective = theme;
  }
  root.setAttribute('data-theme', effective);
  // 广播当前生效主题，供终端等组件跟随应用主题切换
  window.dispatchEvent(new CustomEvent('app-theme-changed', { detail: { mode: effective } }));
};

/**
 * 根据设置应用列表选中样式（连接导航 / 文件导航的 .tree-item.selected 背景与文字色）。
 * 内置样式随当前主题切换；自定义样式始终使用用户指定的配色。
 */
export const applyListSelectionStyle = (s: AppSettings) => {
  const root = document.documentElement;
  const isLight = getEffectiveThemeMode() === 'light';
  let bg = isLight ? 'rgba(0, 120, 212, 0.15)' : '#4d7db9';
  let fg = isLight ? '#005a9e' : '#ffffff';
  // 默认 / IDEA 样式：边框透明 + 0 宽度（即无边框）；自定义：读用户设置
  let borderColor = 'transparent';
  let borderWidth = '0px';
  if (s.listSelectionStyle === 'default') {
    bg = isLight ? '#e8e8e8' : '#37373d';
    fg = isLight ? '#333333' : '#ffffff';
  } else if (s.listSelectionStyle === 'custom') {
    bg = s.listSelectionBg || '#4d7db9';
    fg = s.listSelectionFg || '#ffffff';
    borderColor = s.listSelectionBorderColor || 'transparent';
    borderWidth = `${s.listSelectionBorderWidth || 0}px`;
  }
  root.style.setProperty('--list-active-bg', bg);
  root.style.setProperty('--list-active-fg', fg);
  root.style.setProperty('--list-active-border-color', borderColor);
  root.style.setProperty('--list-active-border-width', borderWidth);
};
