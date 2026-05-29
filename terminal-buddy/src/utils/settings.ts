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
  webApiEnabled: boolean;
  webApiPort: number;
  webApiUsername: string;
  breathingLightColorMode: BreathingLightColorMode;
  breathingLightCustomColor: string;
  sshDownloadDir: string;
  serverMonitorInterval: number;
  webApiShareSessions: boolean;
  launchAtLogin: boolean;
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
  webApiEnabled: false,
  webApiPort: 9600,
  webApiUsername: 'admin',
  breathingLightColorMode: 'tab',
  breathingLightCustomColor: '#FFC107',
  sshDownloadDir: '',
  serverMonitorInterval: 3,
  webApiShareSessions: false,
  launchAtLogin: false,
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

export const initTheme = async (): Promise<ThemeMode> => {
  try {
    const raw = await readClientData('theme');
    if (raw) _cachedTheme = raw as ThemeMode;
  } catch {}
  return _cachedTheme || 'dark';
};

export const applyTheme = (theme: ThemeMode) => {
  const root = document.documentElement;
  if (theme === 'system') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    root.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
  } else {
    root.setAttribute('data-theme', theme);
  }
};
