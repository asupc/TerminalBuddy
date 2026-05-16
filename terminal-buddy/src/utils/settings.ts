export type ThemeMode = 'dark' | 'light' | 'system';

export interface AppSettings {
  restoreTabsOnStartup: boolean;
  configPanelAutoExpand: boolean;
  fileTreeAutoExpand: boolean;
  closeBehavior: 'exit' | 'tray';
  enableTabNavigation: boolean;
  singleInstance: boolean;
  rightClickPaste: boolean;
}

const THEME_STORAGE_KEY = 'terminalbuddy_theme';
const SETTINGS_STORAGE_KEY = 'terminalbuddy_settings';

const DEFAULT_SETTINGS: AppSettings = {
  restoreTabsOnStartup: true,
  configPanelAutoExpand: true,
  fileTreeAutoExpand: true,
  closeBehavior: 'exit',
  enableTabNavigation: true,
  singleInstance: true,
  rightClickPaste: false,
};

export const getAppSettings = (): AppSettings => {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {}
  return { ...DEFAULT_SETTINGS };
};

export const saveAppSettings = (settings: AppSettings) => {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
};

export const getStoredTheme = (): ThemeMode => {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return (stored as ThemeMode) || 'dark';
  } catch {
    return 'dark';
  }
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
