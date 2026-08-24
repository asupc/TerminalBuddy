import { getCurrentWindow } from '@tauri-apps/api/window';
import { register, unregister } from '@tauri-apps/plugin-global-shortcut';
import { isTerminalWorking, useAppStore } from '../stores/appStore';
import { getAppSettings, matchesHotkey } from '../utils/settings';
import { closeTerminal } from './tauri';
import { showConfirm } from './dialog';

export type HotkeyActionId =
  | 'showWindow' | 'toggleConfigNav' | 'toggleFileNav'
  | 'openSettings' | 'newTerminal' | 'closeTab' | 'autocomplete';

export interface HotkeyActionMeta {
  id: HotkeyActionId;
  name: string;
  desc: string;
  defaultHotkey: string;
}

export const HOTKEY_ACTIONS: HotkeyActionMeta[] = [
  { id: 'showWindow', name: '呼出程序窗口', desc: '全局快捷键，应用在托盘或后台时按下可唤出窗口', defaultHotkey: 'Ctrl+Alt+T' },
  { id: 'toggleConfigNav', name: '配置导航开关', desc: '显示或隐藏左侧配置（连接）面板', defaultHotkey: 'Ctrl+Shift+C' },
  { id: 'toggleFileNav', name: '文件导航开关', desc: '显示或隐藏左侧文件面板', defaultHotkey: 'Ctrl+Shift+E' },
  { id: 'openSettings', name: '打开设置', desc: '打开设置弹窗', defaultHotkey: 'Ctrl+,' },
  { id: 'newTerminal', name: '新建终端', desc: '新建一个 PowerShell 终端', defaultHotkey: 'Ctrl+Shift+N' },
  { id: 'closeTab', name: '关闭当前标签', desc: '关闭当前激活的终端标签', defaultHotkey: 'Ctrl+W' },
  { id: 'autocomplete', name: '命令补全面板', desc: '在终端中唤起或关闭命令补全面板', defaultHotkey: 'Alt+/' },
];

export const DEFAULT_HOTKEYS: Record<HotkeyActionId, string> = Object.fromEntries(
  HOTKEY_ACTIONS.map(a => [a.id, a.defaultHotkey]),
) as Record<HotkeyActionId, string>;

// 读取动作当前生效的快捷键：设置值优先，未设置回落默认；空字符串视为禁用
export const getHotkey = (action: HotkeyActionId): string => {
  const stored = getAppSettings().hotkeys?.[action];
  return stored !== undefined ? stored : DEFAULT_HOTKEYS[action];
};

// 执行器注册表：store 可直接执行的简单动作在下方内联注册；
// 依赖组件上下文的动作（如 newTerminal）由 App 挂载时通过 registerHotkeyAction 注册
const actionExecutors: Partial<Record<HotkeyActionId, () => void>> = {};

export const registerHotkeyAction = (id: HotkeyActionId, fn: () => void): void => {
  actionExecutors[id] = fn;
};

// 内联执行器（store 动作,无需组件上下文）
registerHotkeyAction('toggleConfigNav', () => useAppStore.getState().toggleConfigPanel());
registerHotkeyAction('toggleFileNav', () => useAppStore.getState().toggleFileTree());
registerHotkeyAction('openSettings', () => useAppStore.getState().openSettingsDialog());
// 关闭当前标签：与 TabNav / TerminalTabBar 单标签关闭逻辑一致；
// 编辑器脏页签与活跃终端（正在执行任务）先弹窗确认，避免误按快捷键丢失未保存内容或杀掉正在执行任务的终端
registerHotkeyAction('closeTab', () => {
  const store = useAppStore.getState();
  // 特殊页签（git 历史等）展示时不关闭后台终端，与标签栏关闭按钮不可达一致
  if (store.activeSpecialTab) return;
  const sessionId = store.activeSessionId;
  if (!sessionId) return;
  const session = store.sessions.find(s => s.id === sessionId);
  if (session?.sessionType === 'editor') {
    if (session.isDirty) {
      void (async () => {
        const confirmed = await showConfirm(
          `文件「${session.profileName}」有未保存的更改，确定要关闭吗？`,
          { title: '未保存的更改' },
        );
        if (!confirmed) return;
        store.removeSession(sessionId);
      })();
      return;
    }
    store.removeSession(sessionId);
  } else if (session?.starting) {
    store.removeSession(sessionId);
  } else if (session) {
    if (isTerminalWorking(store.terminalActivities[sessionId])) {
      void (async () => {
        const confirmed = await showConfirm(
          `终端「${session.profileName}」正在执行任务，确定要关闭吗？`,
          { title: '终端正在执行任务' },
        );
        if (!confirmed) return;
        store.removeSession(sessionId);
        void closeTerminal(sessionId).catch(err => console.error(err));
      })();
      return;
    }
    store.removeSession(sessionId);
    void closeTerminal(sessionId).catch(err => console.error(err));
  }
});

// 判断按键事件是否命中任一应用内快捷键（不含 autocomplete 本地拦截与 showWindow 全局动作）
export const isAppHotkeyEvent = (e: KeyboardEvent): boolean => {
  if (e.type !== 'keydown') return false;
  for (const action of HOTKEY_ACTIONS) {
    if (action.id === 'autocomplete' || action.id === 'showWindow') continue;
    const hotkey = getHotkey(action.id);
    if (hotkey && matchesHotkey(e, hotkey)) return true;
  }
  return false;
};

// 当前已注册到系统的全局快捷键（空串 = 未注册）
let _registeredShowWindow: string | null = null;

// App 挂载后调用：注册 window/document keydown 分发 + 全局快捷键（呼出窗口）。
// 返回清理函数。F11 现有监听保持独立、不受影响；本分发器用独立的 _tbHotkeyHandled 去重。
export const initAppHotkeys = (): (() => void) => {
  const handleKeyDown = (e: KeyboardEvent) => {
    if ((e as any)._tbHotkeyHandled) return;
    // 录制中屏蔽：焦点在录制按钮上时不分发
    const target = document.activeElement as HTMLElement | null;
    if (target?.closest?.('.hotkey-recorder.recording')) return;
    for (const action of HOTKEY_ACTIONS) {
      if (action.id === 'autocomplete' || action.id === 'showWindow') continue;
      const hotkey = getHotkey(action.id);
      if (hotkey && matchesHotkey(e, hotkey)) {
        (e as any)._tbHotkeyHandled = true;
        e.preventDefault();
        actionExecutors[action.id]?.();
        return;
      }
    }
  };
  window.addEventListener('keydown', handleKeyDown);
  document.addEventListener('keydown', handleKeyDown);

  // 全局快捷键：设置变更时卸载旧键、注册新键；空字符串仅卸载
  const syncGlobalHotkey = () => {
    const hotkey = getHotkey('showWindow');
    if (hotkey === _registeredShowWindow) return;
    const previous = _registeredShowWindow;
    _registeredShowWindow = hotkey;
    if (previous) void unregister(previous).catch(() => {});
    if (!hotkey) return;
    register(hotkey, () => {
      const win = getCurrentWindow();
      void win.show();
      void win.unminimize();
      void win.setFocus();
    }).catch(err => {
      console.error('全局快捷键注册失败:', err);
      useAppStore.getState().showToast('全局快捷键注册失败,可能被其他程序占用', 'error');
    });
  };
  syncGlobalHotkey();
  window.addEventListener('app-settings-changed', syncGlobalHotkey);

  return () => {
    window.removeEventListener('keydown', handleKeyDown);
    document.removeEventListener('keydown', handleKeyDown);
    window.removeEventListener('app-settings-changed', syncGlobalHotkey);
    if (_registeredShowWindow) {
      void unregister(_registeredShowWindow).catch(() => {});
      _registeredShowWindow = null;
    }
  };
};
