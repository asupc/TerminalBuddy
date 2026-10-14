import { invoke } from './core';
import { listen } from './connection';

const browserWindow = {
  label: 'browser',
  show: async () => { window.focus(); },
  hide: async () => { throw new Error('浏览器无法隐藏当前窗口'); },
  setFocus: async () => { window.focus(); },
  unminimize: async () => { window.focus(); },
  isFocused: async () => document.hasFocus(),
  isVisible: async () => document.visibilityState === 'visible',
  isMinimized: async () => document.visibilityState === 'hidden',
  isMaximized: async () => Boolean(document.fullscreenElement),
  isFullscreen: async () => Boolean(document.fullscreenElement),
  setFullscreen: async (enabled: boolean) => {
    if (enabled && !document.fullscreenElement) await document.documentElement.requestFullscreen();
    if (!enabled && document.fullscreenElement) await document.exitFullscreen();
  },
  maximize: () => invoke<void>('window_toggle_maximize'),
  unmaximize: () => document.exitFullscreen(),
  minimize: () => invoke<void>('window_minimize'),
  close: () => invoke<void>('window_close'),
  setTitle: async (title: string) => { document.title = title; },
  setAlwaysOnTop: async () => {},
  startDragging: async () => {},
  onCloseRequested: async () => () => {},
  listen,
};
export function getCurrentWindow() { return browserWindow; }
