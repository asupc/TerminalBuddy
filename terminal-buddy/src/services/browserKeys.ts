import { isAppHotkeyEvent } from './hotkeys';
import { matchesHotkey } from '../utils/settings';

// WebView2 会响应一批浏览器专属快捷键，其中刷新（F5 / Ctrl+R / Ctrl+Shift+R）会重建整个
// 前端页面，所有终端会话与未保存内容全部丢失。Rust 侧已关闭 AreBrowserAcceleratorKeysEnabled，
// 但微软文档说明该设置在「下一次导航后」生效，所以这里对当前页面再做一层拦截。
//
// 焦点在终端里时按键要原样交给 shell：Ctrl+R 是 PSReadLine 反向搜索、Ctrl+P/Ctrl+U 是历史与
// 删行、F5/F6/F7 是 mc/nano 之类全屏程序的常用键，且 xterm 自己会 preventDefault，本来也不会
// 触发刷新。刷新只发生在焦点落在界面其它位置（侧栏、标签栏、按钮、空白处）时。

// 终端内：只拦浏览器强制刷新，其余交给 shell
const SHELL_BLOCKED_COMBOS = ['Ctrl+Shift+R'];

// 终端外：功能键按 e.key 匹配（不看修饰键），Ctrl+F5 / Shift+F5 同样是刷新
const UI_BLOCKED_KEYS = ['F5', 'F6', 'F7'];
const UI_BLOCKED_COMBOS = [
  ...SHELL_BLOCKED_COMBOS,
  'Ctrl+R',          // 刷新
  'Ctrl+P',          // 打印
  'Ctrl+U',          // 查看源码
  'Ctrl+O',          // 打开文件
  'Alt+ArrowLeft',   // 后退：会离开应用页面
  'Alt+ArrowRight',  // 前进
];

// 仅在非编辑区拦截：编辑区（Monaco / input / textarea）里它们是保存、查找、替换等正常功能
const NON_EDITOR_BLOCKED_COMBOS = ['Ctrl+S', 'Ctrl+D', 'Ctrl+F', 'Ctrl+G', 'Ctrl+H', 'Ctrl+J'];

// DevTools 只在发布版拦，开发时保留 F12 / Ctrl+Shift+I 方便调试
const DEVTOOLS_KEYS = import.meta.env.DEV ? [] : ['F12'];
const DEVTOOLS_COMBOS = import.meta.env.DEV ? [] : ['Ctrl+Shift+I', 'Ctrl+Shift+J'];

const isEditable = (el: Element): boolean => {
  const html = el as HTMLElement;
  return html.isContentEditable === true
    || html.tagName === 'INPUT'
    || html.tagName === 'TEXTAREA'
    || html.tagName === 'SELECT'
    || el.closest('.monaco-editor') !== null;
};

// xterm 的输入面（含隐藏的 .xterm-helper-textarea）：按键要原样交给 shell
const isShellSurface = (el: Element): boolean => el.closest('.xterm') !== null;

// Ctrl + (+ - = 0)：WebView2 页面缩放，会把终端字体与布局一起放大且不会自动复位
const isZoomCombo = (e: KeyboardEvent): boolean =>
  e.ctrlKey && !e.altKey && ['+', '-', '=', '0'].includes(e.key);

const hits = (e: KeyboardEvent, combos: readonly string[]): boolean =>
  combos.some(combo => matchesHotkey(e, combo));

// 在 main.tsx 挂载时调用；返回清理函数。
export const installBrowserKeyGuard = (): (() => void) => {
  const handleKeyDown = (e: KeyboardEvent) => {
    const raw = e.target as Element | null;
    const el = raw && typeof raw.closest === 'function' ? raw : document.body;
    // 快捷键录制中：录制器要能收到任意按键，包括 F5
    if (el.closest('.hotkey-recorder.recording')) return;

    const inShell = isShellSurface(el);
    const blocked = isZoomCombo(e)
      || hits(e, inShell ? SHELL_BLOCKED_COMBOS : UI_BLOCKED_COMBOS)
      || (!inShell && (
        UI_BLOCKED_KEYS.includes(e.key)
        || DEVTOOLS_KEYS.includes(e.key)
        || hits(e, DEVTOOLS_COMBOS)
        || (!isEditable(el) && hits(e, NON_EDITOR_BLOCKED_COMBOS))
      ));
    if (!blocked) return;
    // 命中后才检查应用自身快捷键（用户可能把某个动作改绑到被拦的键上），
    // 顺带避免终端每次击键都扫一遍全部动作
    if (isAppHotkeyEvent(e)) return;

    e.preventDefault();
    e.stopPropagation();
  };

  // Ctrl+滚轮缩放（原生 IsZoomControlEnabled=false 已覆盖，这里兜底）
  const handleWheel = (e: WheelEvent) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
  };

  window.addEventListener('keydown', handleKeyDown, true);
  window.addEventListener('wheel', handleWheel, { capture: true, passive: false });

  return () => {
    window.removeEventListener('keydown', handleKeyDown, true);
    window.removeEventListener('wheel', handleWheel, { capture: true });
  };
};
