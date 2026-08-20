import { readClientData, writeClientData } from '../services/tauri';
import type { HotkeyActionId } from '../services/hotkeys';

export type ThemeSkin = 'dark' | 'light' | 'cartoon' | 'starry' | 'cyber' | 'sakura';
export type ThemeMode = ThemeSkin | 'system';
export type DecorativeThemeSkin = 'cartoon' | 'starry' | 'cyber' | 'sakura';

export const DECORATIVE_THEME_SKINS: ReadonlyArray<DecorativeThemeSkin> = [
  'cartoon',
  'starry',
  'cyber',
  'sakura',
];

export const isDecorativeThemeSkin = (value: ThemeSkin): value is DecorativeThemeSkin => (
  value === 'cartoon' || value === 'starry' || value === 'cyber' || value === 'sakura'
);

export const isThemeSkin = (value: unknown): value is ThemeSkin => (
  value === 'dark'
  || value === 'light'
  || value === 'cartoon'
  || value === 'starry'
  || value === 'cyber'
  || value === 'sakura'
);

const normalizeThemeMode = (value: unknown): ThemeMode => (
  value === 'system' || isThemeSkin(value) ? value : 'dark'
);

export interface ThemeChangeDetail {
  mode: 'dark' | 'light';
  skin: ThemeSkin;
}

export const APP_OPACITY_PREVIEW_EVENT = 'app-opacity-preview';
export const MAX_APP_OPACITY = 80;

export interface AppOpacityPreviewDetail {
  skin: DecorativeThemeSkin;
  opacity: number;
}

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
  hotkeys: Partial<Record<HotkeyActionId, string>>;
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
  terminalFontSizeOff: number;
  terminalFontSize2x1: number;
  terminalFontSize2x2: number;
  /** 整体界面表面不透明度百分比：0 为完全透明，最大值为 80。 */
  appOpacityBySkin: Record<DecorativeThemeSkin, number>;
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
  hotkeys: {},
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
  terminalFontSizeOff: 14,
  terminalFontSize2x1: 12,
  terminalFontSize2x2: 11,
  appOpacityBySkin: {
    cartoon: 0,
    starry: 0,
    cyber: 0,
    sakura: 0,
  },
};

let _cachedSettings: AppSettings | null = null;

export const getAppSettings = (): AppSettings => {
  if (_cachedSettings) return { ...DEFAULT_SETTINGS, ..._cachedSettings };
  return { ...DEFAULT_SETTINGS };
};

export const normalizeAppOpacity = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(MAX_APP_OPACITY, Math.max(0, Math.round(value)));
};

export const getAppOpacities = (
  settings: AppSettings,
): Record<DecorativeThemeSkin, number> => {
  const stored = settings.appOpacityBySkin;
  return {
    cartoon: normalizeAppOpacity(stored?.cartoon),
    starry: normalizeAppOpacity(stored?.starry),
    cyber: normalizeAppOpacity(stored?.cyber),
    sakura: normalizeAppOpacity(stored?.sakura),
  };
};

export const getAppOpacity = (
  settings: AppSettings,
  skin: ThemeSkin,
): number => (
  isDecorativeThemeSkin(skin) ? getAppOpacities(settings)[skin] : 0
);

const applyAppOpacityValue = (skin: ThemeSkin, opacity: number) => {
  const root = document.documentElement;
  if (!isDecorativeThemeSkin(skin)) {
    root.style.removeProperty('--skin-app-opacity');
    root.style.removeProperty('--skin-surface-blur');
    return;
  }
  const normalized = normalizeAppOpacity(opacity);
  root.style.setProperty('--skin-app-opacity', String(normalized / 100));
  root.style.setProperty('--skin-surface-blur', `${normalized / 10}px`);
};

export const applyAppOpacity = (settings: AppSettings, skin: ThemeSkin = getEffectiveThemeSkin()) => {
  applyAppOpacityValue(skin, getAppOpacity(settings, skin));
};

export const previewAppOpacity = (skin: DecorativeThemeSkin, opacity: number) => {
  if (getEffectiveThemeSkin() === skin) applyAppOpacityValue(skin, opacity);
};

export const initAppSettings = async (): Promise<void> => {
  try {
    const raw = await readClientData('settings');
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AppSettings> & {
        terminalBackgroundOpacityBySkin?: Record<DecorativeThemeSkin, number>;
      };
      // 兼容短暂使用过的“仅终端透明度”字段，将用户已调数值迁移为整体界面透明度。
      if (!parsed.appOpacityBySkin && parsed.terminalBackgroundOpacityBySkin) {
        parsed.appOpacityBySkin = parsed.terminalBackgroundOpacityBySkin;
      }
      delete parsed.terminalBackgroundOpacityBySkin;
      // 迁移上一轮未发布的 autocompleteHotkey 到统一 hotkeys 映射
      const legacyHotkey = (parsed as Partial<AppSettings> & { autocompleteHotkey?: string }).autocompleteHotkey;
      if (legacyHotkey !== undefined && parsed.hotkeys === undefined) {
        parsed.hotkeys = { autocomplete: legacyHotkey };
      }
      delete (parsed as Partial<AppSettings> & { autocompleteHotkey?: string }).autocompleteHotkey;
      parsed.appOpacityBySkin = getAppOpacities({ ...DEFAULT_SETTINGS, ...parsed } as AppSettings);
      // 兼容旧版总开关：升级后保留用户此前关闭通知的选择。
      if (parsed.claudeCodeNotifications === false && parsed.claudeDecisionNotifications === undefined) {
        parsed.claudeDecisionNotifications = false;
        parsed.claudeCompletionNotifications = false;
      }
      _cachedSettings = parsed as AppSettings;
      applyAppOpacity(getAppSettings());
      window.dispatchEvent(new CustomEvent('app-settings-changed'));
    }
  } catch {}
};

export const saveAppSettings = (settings: AppSettings) => {
  const normalizedSettings: AppSettings = {
    ...settings,
    appOpacityBySkin: getAppOpacities(settings),
  };
  _cachedSettings = normalizedSettings;
  applyAppOpacity(normalizedSettings);
  writeClientData('settings', JSON.stringify(normalizedSettings)).catch(() => {});
  window.dispatchEvent(new CustomEvent('app-settings-changed'));
};

// --- 补全面板快捷键 ---

// 统一按键显示名：空格显示为 Space，单个字母大写，其余按键原样（如 /、F2）
const normalizeHotkeyKey = (key: string): string => {
  if (key === ' ') return 'Space';
  if (/^[a-z]$/.test(key)) return key.toUpperCase();
  return key;
};

// 将按键事件格式化为快捷键字符串（如 'Alt+/'）；裸修饰键或无修饰键组合返回 null
export const formatHotkey = (e: KeyboardEvent): string | null => {
  if (e.key === 'Control' || e.key === 'Alt' || e.key === 'Shift' || e.key === 'Meta') return null;
  if (!e.ctrlKey && !e.altKey && !e.shiftKey) return null;
  const parts = [
    e.ctrlKey ? 'Ctrl' : null,
    e.altKey ? 'Alt' : null,
    e.shiftKey ? 'Shift' : null,
    normalizeHotkeyKey(e.key),
  ].filter(Boolean) as string[];
  return parts.join('+');
};

// 判断按键事件是否命中已保存的快捷键字符串
export const matchesHotkey = (e: KeyboardEvent, hotkey: string): boolean => {
  if (!hotkey) return false;
  const parts = hotkey.split('+');
  const mods = parts.slice(0, -1);
  const key = parts[parts.length - 1];
  return normalizeHotkeyKey(e.key) === key
    && e.ctrlKey === mods.includes('Ctrl')
    && e.altKey === mods.includes('Alt')
    && e.shiftKey === mods.includes('Shift')
    && !e.metaKey;
};

let _cachedTheme: ThemeMode | null = null;

export const getStoredTheme = (): ThemeMode => {
  return _cachedTheme || 'dark';
};

export const saveTheme = (theme: ThemeMode) => {
  _cachedTheme = theme;
  // 后端 client_data_service.write 要求 content 为合法 JSON，裸主题字符串会被拒绝，
  // 故用 JSON.stringify 包成 "light"；读取时 initTheme 用 JSON.parse 还原。
  writeClientData('theme', JSON.stringify(theme)).catch(e => console.error('Failed to save theme:', e));
};

export const initTheme = async (): Promise<ThemeMode> => {
  try {
    const raw = await readClientData('theme');
    if (raw) _cachedTheme = normalizeThemeMode(JSON.parse(raw));
  } catch {}
  return _cachedTheme || 'dark';
};

// 读取当前生效的明暗主题，供终端对比度修正等既有逻辑复用。
export const getEffectiveThemeMode = (): 'dark' | 'light' => {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
};

export const getEffectiveThemeSkin = (): ThemeSkin => {
  const skin = document.documentElement.getAttribute('data-skin');
  return isThemeSkin(skin) ? skin : getEffectiveThemeMode();
};

export const applyTheme = (theme: ThemeMode) => {
  const root = document.documentElement;
  let skin: ThemeSkin;
  if (theme === 'system') {
    skin = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } else {
    skin = theme;
  }

  const mode = skin === 'dark' || skin === 'starry' || skin === 'cyber' ? 'dark' : 'light';
  root.setAttribute('data-theme', mode);
  if (skin !== 'dark' && skin !== 'light') root.setAttribute('data-skin', skin);
  else root.removeAttribute('data-skin');
  applyAppOpacity(getAppSettings(), skin);

  // 广播当前生效主题，供终端等组件跟随应用主题切换
  window.dispatchEvent(new CustomEvent<ThemeChangeDetail>('app-theme-changed', { detail: { mode, skin } }));
};

/**
 * 根据设置应用列表选中样式（连接导航 / 文件导航的 .tree-item.selected 背景与文字色）。
 * 内置样式随当前主题切换；自定义样式始终使用用户指定的配色。
 */
export const applyListSelectionStyle = (s: AppSettings) => {
  const root = document.documentElement;
  const skin = getEffectiveThemeSkin();
  const skinPalette: Record<ThemeSkin, { ideaBg: string; ideaFg: string; defaultBg: string; defaultFg: string }> = {
    dark: { ideaBg: '#4d7db9', ideaFg: '#ffffff', defaultBg: '#37373d', defaultFg: '#ffffff' },
    light: { ideaBg: 'rgba(0, 120, 212, 0.15)', ideaFg: '#005a9e', defaultBg: '#e8e8e8', defaultFg: '#333333' },
    cartoon: { ideaBg: 'rgba(239, 111, 155, 0.18)', ideaFg: '#9f3f62', defaultBg: '#fff0f5', defaultFg: '#8b4a64' },
    starry: { ideaBg: 'rgba(192, 138, 255, 0.24)', ideaFg: '#fff9ff', defaultBg: '#373477', defaultFg: '#fff9ff' },
    cyber: { ideaBg: 'rgba(255, 45, 186, 0.2)', ideaFg: '#f8e9ff', defaultBg: '#321332', defaultFg: '#f8e9ff' },
    sakura: { ideaBg: 'rgba(228, 85, 104, 0.18)', ideaFg: '#873742', defaultBg: '#f9dfd3', defaultFg: '#74383e' },
  };
  const palette = skinPalette[skin];
  let bg = palette.ideaBg;
  let fg = palette.ideaFg;
  // 默认 / IDEA 样式：边框透明 + 0 宽度（即无边框）；自定义：读用户设置
  let borderColor = 'transparent';
  let borderWidth = '0px';
  if (s.listSelectionStyle === 'default') {
    bg = palette.defaultBg;
    fg = palette.defaultFg;
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
