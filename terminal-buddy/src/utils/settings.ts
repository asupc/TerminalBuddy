import { readClientData, writeClientData } from '../services/tauri';

export type ThemeMode = 'dark' | 'light' | 'system';

export type BreathingLightColorMode = 'tab' | 'custom';

export interface AppSettings {
  restoreTabsOnStartup: boolean;
  configPanelAutoExpand: boolean;
  fileTreeAutoExpand: boolean;
  closeBehavior: 'exit' | 'tray';
  enableTabNavigation: boolean;
  singleInstance: boolean;
  rightClickPaste: boolean;
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
}

const DEFAULT_SETTINGS: AppSettings = {
  restoreTabsOnStartup: true,
  configPanelAutoExpand: true,
  fileTreeAutoExpand: true,
  closeBehavior: 'exit',
  enableTabNavigation: true,
  singleInstance: true,
  rightClickPaste: false,
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
};

let _cachedSettings: AppSettings | null = null;

export const getAppSettings = (): AppSettings => {
  if (_cachedSettings) return { ...DEFAULT_SETTINGS, ..._cachedSettings };
  return { ...DEFAULT_SETTINGS };
};

export const initAppSettings = async (): Promise<void> => {
  try {
    const raw = await readClientData('settings');
    if (raw) _cachedSettings = JSON.parse(raw);
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
