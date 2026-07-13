import { FC, useEffect, useRef, useState, useCallback, useLayoutEffect } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import { resizeTerminal, openPath, readClipboardFilePaths, readClipboardImageAsFile, onTerminalOutput, drainTerminalOutput, getWindowsBuildNumber } from '../services/tauri';
import { ServerMonitor } from './ServerMonitor';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { getAppSettings } from '../utils/settings';
import { bootLog } from '../utils/bootLog';
import { useAppStore } from '../stores/appStore';
import { getTerminalSuggestions, type SuggestionItem } from '../data/commandTemplates';
import { normalizeAnsiForLightBackground, type TerminalColors } from '../utils/terminalTheme';
import { TERMINAL_RESIZE_EVENT, type TerminalResizeDetail } from '../utils/terminalResizeEvent';
import { disposeClaudeTerminalNotification, handleClaudeTaskCompleted, handleClaudeTerminalOutput, hasRunningClaudeTask, markClaudeTaskPromptHidden, markClaudeTerminalInteraction } from '../services/claudeNotification';
import '@xterm/xterm/css/xterm.css';
import './TerminalInstance.css';

// 终端基础字号。分屏模式下按比例缩小:2x1 → 0.9、2x2 → 0.8、单屏 → 1.0。
const BASE_FONT_SIZE = 14;
const FLOATING_MENU_MARGIN = 8;
const RIGHT_CLICK_PASTE_DEDUPE_MS = 750;
const RIGHT_CLICK_NATIVE_PASTE_SUPPRESS_MS = 1200;
// 分屏按格子缩小字号；直接定义目标字号而非浮点缩放系数，避免 14×0.9=12.6→13
// 这种非主流字号（等宽字形度量/ClearType 与 14px 差异大，视觉上像换了字体）。
const SPLIT_FONT_SIZE: Record<'off' | '2x1' | '2x2', number> = {
  off: BASE_FONT_SIZE,
  '2x1': 12,
  '2x2': 11,
};

interface TerminalInstanceProps {
  terminalId: string;
  onOutput: (sessionId: string, data: string) => void;
  colorTheme?: TerminalColors;
  isActive?: boolean;
  readOnly?: boolean;
  splitMode?: 'off' | '2x1' | '2x2';
}

type XtermCompositionHelper = {
  updateCompositionElements?: (dontRecurse?: boolean) => void;
  _compositionView?: HTMLElement;
  _textarea?: HTMLTextAreaElement;
};

type XtermCore = {
  _compositionHelper?: XtermCompositionHelper;
  _renderService?: {
    dimensions?: {
      css?: {
        cell?: {
          width: number;
          height: number;
        };
      };
    };
  };
  _syncTextArea?: () => void;
};

type TerminalContextMenuState = {
  x: number;
  y: number;
  anchorX: number;
  anchorY: number;
  visible: boolean;
};

type AutocompleteState = {
  items: SuggestionItem[];
  index: number;
  selectionExplicit: boolean;
  input: string;
  inlineCompletion: string;
  inlineX: number;
  inlineY: number;
  inlineHeight: number;
  x: number;
  y: number;
  anchorX: number;
  anchorBelowY: number;
  anchorAboveY: number;
};

type RightClickPasteState = {
  inFlight: boolean;
  suppressNativePasteUntil: number;
  lastText: string;
  lastTextAt: number;
};

function fitFloatingElementToViewport(
  anchorX: number,
  preferredTopY: number,
  fallbackBottomY: number,
  floatingWidth: number,
  floatingHeight: number
): { x: number; y: number } {
  let x = anchorX;
  let y = preferredTopY;

  if (x + floatingWidth + FLOATING_MENU_MARGIN > window.innerWidth) {
    x = window.innerWidth - floatingWidth - FLOATING_MENU_MARGIN;
  }

  if (preferredTopY + floatingHeight + FLOATING_MENU_MARGIN > window.innerHeight) {
    y = fallbackBottomY - floatingHeight;
  }

  const maxX = Math.max(FLOATING_MENU_MARGIN, window.innerWidth - floatingWidth - FLOATING_MENU_MARGIN);
  const maxY = Math.max(FLOATING_MENU_MARGIN, window.innerHeight - floatingHeight - FLOATING_MENU_MARGIN);

  return {
    x: Math.min(Math.max(FLOATING_MENU_MARGIN, x), maxX),
    y: Math.min(Math.max(FLOATING_MENU_MARGIN, y), maxY),
  };
}

type ImeAnchor = {
  left: string;
  top: string;
  width: string;
  height: string;
  lineHeight: string;
  fontFamily: string;
  fontSize: string;
};

type ImeAnchorCell = {
  x: number;
  y: number;
  widthCells: number;
  inputTopY: number;
  inputBottomY: number;
  cols: number;
  rows: number;
};

function isHorizontalRuleLine(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 20) return false;

  // Claude Code uses plain horizontal separators; Codex CLI/ratatui-style UIs
  // often use box-drawing borders with corners. Both represent a TUI input
  // chrome where the native xterm cursor should not blink over app-rendered text.
  return /^[─━═-]+$/u.test(trimmed) ||
    /^[╭╰┌└├┬┴┼╮╯┐┘┤│┃║\s─━═-]+$/u.test(trimmed);
}

function isTuiInputPromptLine(text: string): boolean {
  return /^\s*(?:[│┃║]\s*)?[>›❯▌]\s?/u.test(text);
}

function hasCodexTuiMarker(text: string): boolean {
  return /\bCodex\b|codex-cli|OpenAI Codex/u.test(text) ||
    /\b(?:approval|sandbox|workdir|tokens?|context|model)\b/u.test(text) &&
      /\b(?:gpt|GPT|codex|Codex|thread|session)\b/u.test(text);
}

function hasTuiInputChrome(terminal: Terminal): boolean {
  const buffer = terminal.buffer.active;
  let horizontalRuleCount = 0;
  let promptLineCount = 0;
  let codexMarker = false;

  for (let y = 0; y < terminal.rows; y++) {
    const line = buffer.getLine(buffer.viewportY + y);
    const text = line?.translateToString(true) ?? '';
    if (/Version:.*Claude Code|MCP:|bypass permissions|for agents|ctx:|Opus|effort/u.test(text)) {
      return true;
    }
    if (hasCodexTuiMarker(text)) codexMarker = true;
    if (isTuiInputPromptLine(text)) promptLineCount++;
    if (isHorizontalRuleLine(text)) horizontalRuleCount++;
  }

  return horizontalRuleCount >= 2 ||
    (codexMarker && (horizontalRuleCount >= 1 || promptLineCount > 0 || buffer === terminal.buffer.alternate));
}

function getLastNonBlankCell(line: ReturnType<Terminal['buffer']['active']['getLine']>, cols: number): number {
  if (!line) return 0;

  for (let x = cols - 1; x >= 0; x--) {
    const cell = line.getCell(x);
    const chars = cell?.getChars();
    if (cell && chars && chars.trim().length > 0) {
      return x + Math.max(cell.getWidth(), 1);
    }
  }

  return 0;
}

function getInputAtCursor(terminal: Terminal): string | null {
  const buffer = terminal.buffer.active;
  const absY = buffer.baseY + buffer.cursorY;
  const line = buffer.getLine(absY);
  if (!line) return null;

  const text = line.translateToString(true, 0, buffer.cursorX);
  const promptIdx = text.lastIndexOf('>');
  return (promptIdx >= 0 ? text.substring(promptIdx + 1) : text).trimStart();
}

function getAutocompleteCompletion(command: string, input: string): string {
  if (!input || command.length <= input.length) return '';
  if (!command.toLowerCase().startsWith(input.toLowerCase())) return '';
  return command.substring(input.length);
}

function getCommandSuggestions(input: string): SuggestionItem[] {
  return getTerminalSuggestions(input).slice(0, 8);
}

const SUGGESTION_KIND_LABEL: Record<NonNullable<SuggestionItem['kind']>, string> = {
  command: '命令',
  subcommand: '子命令',
  option: '参数',
  argument: '值',
  template: '模板',
};

function findBottomPromptAnchor(terminal: Terminal): ImeAnchorCell | null {
  const buffer = terminal.buffer.active;
  const horizontalRules: number[] = [];

  for (let y = 0; y < terminal.rows; y++) {
    const line = buffer.getLine(buffer.viewportY + y);
    const text = line?.translateToString(true) ?? '';
    if (isHorizontalRuleLine(text)) {
      horizontalRules.push(y);
    }
  }

  for (let y = terminal.rows - 1; y >= 0; y--) {
    const line = buffer.getLine(buffer.viewportY + y);
    if (!line) continue;

    const text = line.translateToString(false);
    const promptMatch = text.match(/^\s*(?:[│┃║]\s*)?[>›❯]\s?/u);
    if (!promptMatch) continue;

    const promptEnd = promptMatch[0].length;
    let anchorY = y;
    let inputBottomY = y;

    for (let nextY = y + 1; nextY < terminal.rows; nextY++) {
      const nextLine = buffer.getLine(buffer.viewportY + nextY);
      const nextText = nextLine?.translateToString(true) ?? '';
      if (isHorizontalRuleLine(nextText)) {
        inputBottomY = nextY;
        if (nextY > y + 1) {
          anchorY = nextY - 1;
        }
        break;
      }
    }

    const anchorLine = buffer.getLine(buffer.viewportY + anchorY);
    const contentEnd = getLastNonBlankCell(anchorLine, terminal.cols);
    return {
      x: Math.min(anchorY === y ? Math.max(promptEnd, contentEnd) : contentEnd, terminal.cols - 1),
      y: anchorY,
      widthCells: 1,
      inputTopY: y,
      inputBottomY,
      cols: terminal.cols,
      rows: terminal.rows,
    };
  }

  if (horizontalRules.length >= 2) {
    const [topRule, bottomRule] = horizontalRules;
    const inputTopY = Math.min(topRule + 1, terminal.rows - 1);
    const inputBottomY = Math.max(inputTopY, bottomRule - 1);
    return {
      x: 0,
      y: inputTopY,
      widthCells: 1,
      inputTopY,
      inputBottomY,
      cols: terminal.cols,
      rows: terminal.rows,
    };
  }

  return null;
}

function installStableImeAnchor(terminal: Terminal, shouldUsePromptAnchor: () => boolean): (() => void) | undefined {
  const core = (terminal as any)._core as XtermCore | undefined;
  const compositionHelper = core?._compositionHelper as XtermCompositionHelper | undefined;
  const textarea = terminal.textarea ?? compositionHelper?._textarea;
  const compositionView = compositionHelper?._compositionView;
  const originalUpdate = compositionHelper?.updateCompositionElements?.bind(compositionHelper);
  const originalSyncTextArea = core?._syncTextArea?.bind(core);

  if (!compositionHelper || !textarea || !compositionView || !originalUpdate) {
    return undefined;
  }

  let anchor: ImeAnchor | null = null;
  let lastPromptAnchor: ImeAnchorCell | null = null;
  let recurseTimer: number | null = null;
  let syncRaf: number | null = null;

  const pxNumber = (value: string): number => {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };

  const isTextareaInInputArea = (promptAnchor: ImeAnchorCell, cellHeight: number): boolean => {
    const top = pxNumber(textarea.style.top);
    const row = Math.round(top / cellHeight);
    return row >= promptAnchor.inputTopY && row <= promptAnchor.inputBottomY;
  };

  const syncTextareaToPromptAnchor = (force = false): boolean => {
    const cell = core?._renderService?.dimensions?.css?.cell;
    const foundPromptAnchor = findBottomPromptAnchor(terminal);
    if (foundPromptAnchor) {
      lastPromptAnchor = foundPromptAnchor;
    }
    const promptAnchor =
      foundPromptAnchor ??
      (lastPromptAnchor?.cols === terminal.cols && lastPromptAnchor.rows === terminal.rows
        ? lastPromptAnchor
        : null);
    if (!cell?.width || !cell?.height || !promptAnchor) {
      return false;
    }

    if (!force && isTextareaInInputArea(promptAnchor, cell.height)) {
      return true;
    }

    const height = `${cell.height}px`;
    textarea.style.left = `${Math.round(promptAnchor.x * cell.width)}px`;
    textarea.style.top = `${Math.round(promptAnchor.y * cell.height)}px`;
    textarea.style.width = `${Math.max(promptAnchor.widthCells * cell.width, 1)}px`;
    textarea.style.height = height;
    textarea.style.lineHeight = height;
    textarea.style.zIndex = '-5';
    return true;
  };

  if (core && originalSyncTextArea) {
    core._syncTextArea = () => {
      originalSyncTextArea();
      if (shouldUsePromptAnchor()) {
        syncTextareaToPromptAnchor();
      }
    };
  }

  const syncTextareaAnchor = () => {
    originalSyncTextArea?.();
    if (!shouldUsePromptAnchor() || !syncTextareaToPromptAnchor()) {
      return;
    }
  };
  (terminal as any)._tbSyncImeAnchor = syncTextareaAnchor;

  const syncBeforeImeReadsTextarea = () => {
    syncTextareaAnchor();
  };

  const startFocusedSync = () => {
    if (syncRaf !== null) return;
    const tick = () => {
      syncTextareaAnchor();
      syncRaf = window.requestAnimationFrame(tick);
    };
    syncRaf = window.requestAnimationFrame(tick);
  };

  const stopFocusedSync = () => {
    if (syncRaf === null) return;
    window.cancelAnimationFrame(syncRaf);
    syncRaf = null;
  };

  const readCursorAnchor = (): ImeAnchor => {
    const cell = core?._renderService?.dimensions?.css?.cell;
    const fallbackHeight = cell?.height ? `${cell.height}px` : '1px';
    originalSyncTextArea?.();
    if (shouldUsePromptAnchor()) {
      syncTextareaToPromptAnchor(true);
    }

    if (cell?.width && cell?.height) {
      const buffer = terminal.buffer.active;
      const cursorX = Math.min(buffer.cursorX, terminal.cols - 1);
      return {
        left: textarea.style.left || `${Math.round(cursorX * cell.width)}px`,
        top: textarea.style.top || `${Math.round(buffer.cursorY * cell.height)}px`,
        width: textarea.style.width || `${cell.width}px`,
        height: textarea.style.height || fallbackHeight,
        lineHeight: textarea.style.lineHeight || fallbackHeight,
        fontFamily: String(terminal.options.fontFamily ?? ''),
        fontSize: `${terminal.options.fontSize ?? 14}px`,
      };
    }

    return {
      left: textarea.style.left || '0px',
      top: textarea.style.top || '0px',
      width: textarea.style.width || '1px',
      height: textarea.style.height || fallbackHeight,
      lineHeight: textarea.style.lineHeight || textarea.style.height || fallbackHeight,
      fontFamily: String(terminal.options.fontFamily ?? ''),
      fontSize: `${terminal.options.fontSize ?? 14}px`,
    };
  };

  const applyAnchor = () => {
    if (!anchor) return;

    compositionView.style.left = anchor.left;
    compositionView.style.top = anchor.top;
    compositionView.style.height = anchor.height;
    compositionView.style.lineHeight = anchor.lineHeight;
    compositionView.style.fontFamily = anchor.fontFamily;
    compositionView.style.fontSize = anchor.fontSize;

    const bounds = compositionView.getBoundingClientRect();
    const width = Math.max(bounds.width, pxNumber(anchor.width), 1);
    const height = Math.max(bounds.height, pxNumber(anchor.height), 1);
    textarea.style.left = anchor.left;
    textarea.style.top = anchor.top;
    textarea.style.width = `${width}px`;
    textarea.style.height = `${height}px`;
    textarea.style.lineHeight = `${height}px`;
  };

  const captureAnchor = () => {
    anchor = readCursorAnchor();
    applyAnchor();
  };

  const releaseAnchor = () => {
    anchor = null;
    if (recurseTimer !== null) {
      window.clearTimeout(recurseTimer);
      recurseTimer = null;
    }
  };

  compositionHelper.updateCompositionElements = (dontRecurse?: boolean) => {
    if (!anchor) {
      originalUpdate(dontRecurse);
      return;
    }

    applyAnchor();
    if (!dontRecurse) {
      if (recurseTimer !== null) window.clearTimeout(recurseTimer);
      recurseTimer = window.setTimeout(() => {
        recurseTimer = null;
        compositionHelper.updateCompositionElements?.(true);
      }, 0);
    }
  };

  textarea.addEventListener('keydown', syncBeforeImeReadsTextarea, true);
  textarea.addEventListener('beforeinput', syncBeforeImeReadsTextarea, true);
  textarea.addEventListener('focus', startFocusedSync);
  textarea.addEventListener('blur', stopFocusedSync);
  textarea.addEventListener('compositionstart', captureAnchor, true);
  textarea.addEventListener('compositionend', releaseAnchor);
  const cursorMoveDisposable = terminal.onCursorMove(syncTextareaAnchor);
  const writeParsedDisposable = terminal.onWriteParsed(syncTextareaAnchor);
  const renderDisposable = terminal.onRender(syncTextareaAnchor);
  syncTextareaAnchor();
  if (textarea.ownerDocument.activeElement === textarea) {
    startFocusedSync();
  }

  return () => {
    releaseAnchor();
    stopFocusedSync();
    cursorMoveDisposable.dispose();
    writeParsedDisposable.dispose();
    renderDisposable.dispose();
    textarea.removeEventListener('keydown', syncBeforeImeReadsTextarea, true);
    textarea.removeEventListener('beforeinput', syncBeforeImeReadsTextarea, true);
    textarea.removeEventListener('focus', startFocusedSync);
    textarea.removeEventListener('blur', stopFocusedSync);
    textarea.removeEventListener('compositionstart', captureAnchor, true);
    textarea.removeEventListener('compositionend', releaseAnchor);
    if (core && originalSyncTextArea) {
      core._syncTextArea = originalSyncTextArea;
    }
    delete (terminal as any)._tbSyncImeAnchor;
    compositionHelper.updateCompositionElements = originalUpdate;
  };
}

/**
 * 解析 cd 命令的目标路径。
 * 支持: cd path, cd .., cd ~, cd /, 以及无参数的 cd（回到 home）。
 * 返回绝对路径或 null（无法解析时）。
 */
function resolveCdTarget(cwd: string, arg: string | undefined): string | null {
  if (!arg || arg === '~') {
    // 浏览器环境无法访问 process.env，使用常见默认值
    return 'C:\\Users';
  }
  // 绝对路径
  if (/^[A-Za-z]:\\/.test(arg) || arg.startsWith('/')) {
    return arg.replace(/\//g, '\\');
  }
  // 从当前目录开始拼接并规范化
  let parts = cwd.replace(/\\$/, '').split('\\');
  for (const seg of arg.replace(/\//g, '\\').split('\\')) {
    if (seg === '..') {
      if (parts.length > 1) parts.pop();
    } else if (seg && seg !== '.') {
      parts.push(seg);
    }
  }
  return parts.join('\\') || parts[0] + '\\';
}

/** 从终端缓冲区提取当前行命令，检测 cd 并更新 sessionDirectory */
function detectAndTrackCd(terminal: Terminal, terminalId: string) {
  const buffer = terminal.buffer.active;
  const line = buffer.getLine(buffer.baseY + buffer.cursorY);
  if (!line) return;
  const text = line.translateToString(true, 0, buffer.cursorX);
  // 从提示符后面提取命令
  const promptIdx = text.lastIndexOf('>');
  const input = promptIdx >= 0 ? text.substring(promptIdx + 1).trimStart() : text.trimStart();
  if (!input) return;
  const parts = input.split(/\s+/);
  if (parts[0] === 'cd') {
    const cwd = useAppStore.getState().sessionDirectories[terminalId] || '';
    const target = resolveCdTarget(cwd, parts[1]);
    if (target) {
      useAppStore.getState().setSessionDirectory(terminalId, target);
    }
  }
}

export const TerminalInstance: FC<TerminalInstanceProps> = ({
  terminalId,
  onOutput,
  colorTheme,
  isActive,
  readOnly,
  splitMode = 'off',
}) => {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const onOutputRef = useRef(onOutput);
  onOutputRef.current = onOutput;
  // 让 initTerminal 在首次创建 xterm 时读到最新分屏模式,避免初次即处于分屏时字号漏改。
  const splitModeRef = useRef(splitMode);
  splitModeRef.current = splitMode;
  const [contextMenu, setContextMenu] = useState<TerminalContextMenuState>({
    x: 0,
    y: 0,
    anchorX: 0,
    anchorY: 0,
    visible: false,
  });
  const [searchVisible, setSearchVisible] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const [autocomplete, setAutocomplete] = useState<AutocompleteState | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [internalDragOver, setInternalDragOver] = useState(false);
  const isSsh = useAppStore(s => s.sessions.find(sess => sess.id === terminalId)?.terminalType === 'ssh');
  const windowMode = useAppStore(s => s.windowMode);
  const [scrollInfo, setScrollInfo] = useState({ top: 0, height: 0, visible: false });
  const scrollThumbRef = useRef<HTMLDivElement>(null);
  const scrollViewportRef = useRef<HTMLElement | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const autocompletePopupRef = useRef<HTMLDivElement>(null);
  const autocompleteRef = useRef<typeof autocomplete>(null);
  const colorThemeRef = useRef(colorTheme);
  const rightClickPasteRef = useRef<RightClickPasteState>({
    inFlight: false,
    suppressNativePasteUntil: 0,
    lastText: '',
    lastTextAt: 0,
  });
  const updateAutocomplete = useCallback((val: typeof autocomplete) => {
    autocompleteRef.current = val;
    setAutocomplete(val);
  }, []);
  colorThemeRef.current = colorTheme;

  const sendPastedText = useCallback((text: string): boolean => {
    if (!text) return false;
    if (text.includes('\n') || text.includes('\r')) {
      const sanitized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      onOutputRef.current(terminalId, `\x1b[200~${sanitized}\x1b[201~`);
    } else {
      onOutputRef.current(terminalId, text);
    }
    return true;
  }, [terminalId]);

  const adjustTerminalContextMenuPosition = useCallback(() => {
    if (!contextMenu.visible) return;
    const menu = contextMenuRef.current;
    if (!menu) return;

    const { width: menuWidth, height: menuHeight } = menu.getBoundingClientRect();
    const next = fitFloatingElementToViewport(
      contextMenu.anchorX,
      contextMenu.anchorY,
      contextMenu.anchorY,
      menuWidth,
      menuHeight
    );

    if (next.x !== contextMenu.x || next.y !== contextMenu.y) {
      setContextMenu(prev => prev.visible ? { ...prev, ...next } : prev);
    }
  }, [contextMenu]);

  const adjustAutocompletePosition = useCallback(() => {
    if (!autocomplete) return;
    const popup = autocompletePopupRef.current;
    if (!popup) return;

    const { width: popupWidth, height: popupHeight } = popup.getBoundingClientRect();
    const next = fitFloatingElementToViewport(
      autocomplete.anchorX,
      autocomplete.anchorBelowY,
      autocomplete.anchorAboveY,
      popupWidth,
      popupHeight
    );

    if (next.x !== autocomplete.x || next.y !== autocomplete.y) {
      updateAutocomplete({ ...autocomplete, ...next });
    }
  }, [autocomplete, updateAutocomplete]);

  useLayoutEffect(() => {
    adjustTerminalContextMenuPosition();
  }, [adjustTerminalContextMenuPosition]);

  useLayoutEffect(() => {
    adjustAutocompletePosition();
  }, [adjustAutocompletePosition]);

  useEffect(() => {
    if (!contextMenu.visible) return;
    window.addEventListener('resize', adjustTerminalContextMenuPosition);
    return () => window.removeEventListener('resize', adjustTerminalContextMenuPosition);
  }, [contextMenu.visible, adjustTerminalContextMenuPosition]);

  useEffect(() => {
    if (!autocomplete) return;
    window.addEventListener('resize', adjustAutocompletePosition);
    return () => window.removeEventListener('resize', adjustAutocompletePosition);
  }, [autocomplete, adjustAutocompletePosition]);

  const applyXtermTheme = useCallback((term: Terminal) => {
    const currentTheme = colorThemeRef.current;
    const bg = currentTheme?.background || '#1e1e1e';
    const fg = currentTheme?.foreground || '#cccccc';
    const lightOptimized = !!currentTheme?.lightOptimized;
    const { lightOptimized: _lightOptimized, ...xtermTheme } = currentTheme || { background: bg, foreground: fg };
    term.options.theme = xtermTheme;
    term.options.minimumContrastRatio = lightOptimized ? 4.5 : 1;
  }, []);

  // Resize-related refs (learned from VS Code's terminal implementation)
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastDimensionsRef = useRef<{ cols: number; rows: number } | null>(null);
  const lastPtyDimensionsRef = useRef<{ cols: number; rows: number } | null>(null);
  const [termBg, setTermBg] = useState(colorTheme?.background || '#1e1e1e');
  const lightOptimizedRef = useRef(!!colorTheme?.lightOptimized);
  const inAltBufferRef = useRef(false);
  const lastTuiRedrawLayoutVersionRef = useRef<number | null>(null);

  // Output tracking refs (learned from VS Code's terminalInstance.ts)
  // These track write/parse state to ensure cursor position stays in sync
  const latestWriteDataRef = useRef(0);
  const latestParseDataRef = useRef(0);

  // Sync terminal theme (xterm canvas + outer div) when colorTheme prop changes.
  // xterm 在 options.theme 变化后自动重绘（canvas/webgl 渲染器均支持），
  // 因此切换应用主题时运行中的终端也能实时换色，而非只有外层 div 背景变化。
  // 注意 resolveTerminalColors 返回的引用稳定（cache），不会因无关渲染误触发。
  useEffect(() => {
    const bg = colorTheme?.background || '#1e1e1e';
    const lightOptimized = !!colorTheme?.lightOptimized;
    lightOptimizedRef.current = lightOptimized;
    setTermBg(bg);
    const term = xtermRef.current;
    if (term) {
      applyXtermTheme(term);
    }
  }, [colorTheme, applyXtermTheme]);

  useEffect(() => {
    if (!terminalRef.current) return;
    let disposed = false;

    const cleanupFns: (() => void)[] = [];
    const outputBuffer: string[] = [];
    const pendingChunks: string[] = [];
    let pendingRaf: number | null = null;
    // 上一帧末尾未闭合的 CSI 序列（ESC[ 后缺终结符）。PTY 输出边界任意，一个 SGR
    // 序列可能被切到两个 RAF 帧：切断后两侧都不匹配 normalize 的 CSI 正则，深色
    // 背景 SGR 会原样写进 xterm，白板模式下就闪一块深色（xterm 自己能跨 write 解析，
    // 所以"一会儿自愈"）。这里把帧尾半截 CSI 暂存，下一帧拼到开头再整体 normalize。
    let csiTail = '';
    let workingDebounce: ReturnType<typeof setTimeout> | null = null;
    let workingFallback: ReturnType<typeof setTimeout> | null = null;
    let autocompleteTimer: ReturnType<typeof setTimeout> | null = null;

    const checkBufferForPrompt = () => {
      if (disposed || !xtermRef.current) return false;
      const buf = xtermRef.current!.buffer.active;
      const absY = buf.baseY + buf.cursorY;
      for (let offset = 0; offset <= 2; offset++) {
        const line = buf.getLine(absY - offset);
        if (line) {
          const text = line.translateToString(true);
          if (/(?:PS )?([A-Za-z]:\\[^\s>]*)>/.test(text)) {
            return true;
          }
        }
      }
      return false;
    };

    const checkBufferForClaudeInput = () => {
      if (disposed || !xtermRef.current) return false;
      const terminal = xtermRef.current;
      const buf = terminal.buffer.active;
      const lines: string[] = [];
      // 始终检查实时屏幕底部，不跟随用户向上滚动后的 viewport。
      const firstRow = Math.max(0, buf.baseY);
      const lastRow = Math.min(buf.length - 1, firstRow + terminal.rows - 1);
      for (let row = firstRow; row <= lastRow; row++) {
        const line = buf.getLine(row);
        if (line) lines.push(line.translateToString(true));
      }
      return lines.some(line => /^\s*[❯›]\s*(?:$|Try\s+["“])/i.test(line)) &&
        !lines.some(line => /esc to interrupt|Permission required|Enter to select/i.test(line));
    };

    const hasBusyClaudeSubagent = () => {
      if (disposed || !xtermRef.current) return false;
      const terminal = xtermRef.current;
      const buf = terminal.buffer.active;
      const firstRow = Math.max(0, buf.baseY);
      const lastRow = Math.min(buf.length - 1, firstRow + terminal.rows - 1);
      for (let row = firstRow; row <= lastRow; row++) {
        const line = buf.getLine(row)?.translateToString(true) ?? '';
        // “idle” 是 Claude Code 子代理完成后的状态；其余明确的运行状态都视为仍在执行。
        // 限制 agent 与状态词的距离，避免普通回答中两个无关单词碰巧出现在同一行。
        if (/(?:\b(?:sub-?agents?|agents?)\b.{0,48}\b(?:working|running|thinking|processing|queued|pending|active|in[ -]?progress)\b|\b(?:working|running|thinking|processing|queued|pending|active|in[ -]?progress)\b.{0,48}\b(?:sub-?agents?|agents?)\b)/i.test(line)) return true;
      }
      return false;
    };

    const checkWorkingState = () => {
      if (disposed) return;
      if (checkBufferForClaudeInput()) {
        if (!hasRunningClaudeTask(terminalId)) {
          useAppStore.getState().setSessionWorking(terminalId, false);
          if (workingFallback) clearTimeout(workingFallback);
          return;
        }
        if (handleClaudeTaskCompleted(terminalId, hasBusyClaudeSubagent())) {
          useAppStore.getState().setSessionWorking(terminalId, false);
          if (workingFallback) clearTimeout(workingFallback);
        } else {
          // spinner 或子代理仍在活动时保持工作状态，并持续复核直到它们停止。
          useAppStore.getState().setSessionWorking(terminalId, true);
          if (workingFallback) clearTimeout(workingFallback);
          workingDebounce = setTimeout(checkWorkingState, 800);
        }
        return;
      }
      markClaudeTaskPromptHidden(terminalId);
      if (checkBufferForPrompt()) {
        useAppStore.getState().setSessionWorking(terminalId, false);
        if (workingFallback) clearTimeout(workingFallback);
      }
    };

    const handleOutput = (output: string) => {
      if (disposed || !output) return;
      handleClaudeTerminalOutput(terminalId, output);
      if (xtermRef.current) {
        // 先存原始 chunk，等 RAF 里 join 成完整串后再做 ANSI 改写。
        // normalizeAnsiForLightBackground 用正则匹配「完整的」CSI 序列（\x1b[...m），
        // 而 PTY 每次读取的输出边界是任意的，可能把一个序列切成两半。若逐 chunk 改写，
        // 被切断的序列两边都不匹配正则、原样保留，白板模式下就会偶发出现 claude code
        // 原始的深色背景块（有概率闪、闪一会儿自愈、非纯黑）。RAF join 解决了同一帧
        // 内的切断；跨帧切断（序列一半在上一帧尾、一半在本帧头）由 csiTail 兜住——
        // 帧尾未闭合的 CSI 暂存到下一帧拼接，保证整串先拼完整再改写。
        pendingChunks.push(output);
        if (!pendingRaf) {
          pendingRaf = requestAnimationFrame(() => {
            pendingRaf = null;
            if (disposed) return;
            // 先拼上上一帧遗留的半截 CSI，再 join 本帧所有 chunk
            const combined = csiTail + pendingChunks.join('');
            pendingChunks.length = 0;

            // 切出帧尾未闭合的 CSI（ESC[ 后缺终结符 @-~）暂存到 csiTail，下帧再拼。
            // 完整 CSI 形如 ESC[ 参数串 终结符；不匹配即说明被切断，需保留半个。
            let toWrite = combined;
            const esc = combined.lastIndexOf('\x1b');
            if (esc !== -1) {
              const tail = combined.slice(esc);
              const isCompleteCsi = /^\x1b\[[0-9;?<=>!"#$%&'()*+,\-./]*[\x40-\x7e]/.test(tail);
              if (tail === '\x1b' || (tail.startsWith('\x1b[') && !isCompleteCsi)) {
                csiTail = tail;
                toWrite = combined.slice(0, esc);
              } else {
                csiTail = '';
              }
            } else {
              csiTail = '';
            }

            const normalized = normalizeAnsiForLightBackground(toWrite, lightOptimizedRef.current);
            const term = xtermRef.current;
            // Use write callback to track parse state (learned from VS Code's _writeProcessData)
            // This ensures cursor position stays in sync when TUI programs update the screen
            const messageId = ++latestWriteDataRef.current;
            term?.write(normalized, () => {
              latestParseDataRef.current = messageId;
            });
          });
        }
      } else {
        outputBuffer.push(output);
      }

      // Working state: reset debounce on each output, check xterm buffer for prompt
      if (workingDebounce) clearTimeout(workingDebounce);
      if (workingFallback) clearTimeout(workingFallback);
      // Quick check after 300ms — xterm buffer has clean text (no ANSI codes)
      workingDebounce = setTimeout(checkWorkingState, 300);
      // 普通命令静默 1.5 秒后恢复空闲；Claude 任务由其完成状态机负责，不能提前熄灭工作状态。
      workingFallback = setTimeout(() => {
        if (!disposed) {
          useAppStore.getState().setSessionWorking(terminalId, hasRunningClaudeTask(terminalId));
        }
      }, 1500);
    };

    const initTerminal = async () => {
      const tTotal = performance.now();
      void bootLog(`initTerminal[${terminalId}]: START`);

      // Wait for fonts to be fully loaded so xterm measures correct cell dimensions
      const tFontStart = performance.now();
      await document.fonts.ready;
      void bootLog(`initTerminal[${terminalId}]: fonts.ready took ${(performance.now() - tFontStart).toFixed(0)}ms`);

      if (disposed || !terminalRef.current) return;

      const tBuildNum = performance.now();
      const buildNumber = await getWindowsBuildNumber();
      void bootLog(`initTerminal[${terminalId}]: getWindowsBuildNumber took ${(performance.now() - tBuildNum).toFixed(0)}ms, val=${buildNumber}`);

      const tNewTerm = performance.now();
      const { lightOptimized: initialLightOptimized, ...initialTheme } = colorTheme || {
        background: '#1e1e1e',
        foreground: '#cccccc',
      };
      const terminal = new Terminal({
        cursorBlink: false,
        cursorStyle: 'block',
        cursorInactiveStyle: 'outline',
        cursorWidth: 1,
        fontSize: SPLIT_FONT_SIZE[splitModeRef.current],
        fontFamily: "'Cascadia Mono', Consolas, 'Courier New', monospace",
        fontWeight: 'normal',
        fontWeightBold: 'bold',
        lineHeight: 1,
        letterSpacing: 0,
        scrollback: 50000,
        theme: initialTheme,
        // 仅自动白板模式启用最低对比度增强；黑板/自定义终端配色保持原样
        minimumContrastRatio: initialLightOptimized ? 4.5 : 1,
        allowProposedApi: true,
        disableStdin: !!readOnly,
        ...(buildNumber ? { windowsPty: { backend: 'conpty' as const, buildNumber } } : {}),
        screenReaderMode: false,
      });
      void bootLog(`initTerminal[${terminalId}]: new Terminal() took ${(performance.now() - tNewTerm).toFixed(0)}ms`);

      const tAddons = performance.now();
      const fitAddon = new FitAddon();
      const clipboardAddon = new ClipboardAddon();
      const unicode11Addon = new Unicode11Addon();

      terminal.loadAddon(fitAddon);
      terminal.loadAddon(new WebLinksAddon((event: MouseEvent, uri: string) => {
        if (event.ctrlKey || event.metaKey) {
          openPath(uri).catch((err) => console.error('Failed to open URL:', err));
        }
      }));
      terminal.loadAddon(clipboardAddon);

      const searchAddon = new SearchAddon();
      terminal.loadAddon(searchAddon);
      searchAddonRef.current = searchAddon;

      terminal.loadAddon(unicode11Addon);
      terminal.unicode.activeVersion = '11';
      void bootLog(`initTerminal[${terminalId}]: loadAddons (fit/weblinks/clipboard/search/unicode11) took ${(performance.now() - tAddons).toFixed(0)}ms`);

      // F11 默认会被 xterm 当作 VT 功能键消费（转成转义序列发给 PTY），终端持有
      // 焦点时 App.tsx 的 window/document keydown 监听收不到，表现为「非分屏模式下
      // 按 F11 没反应」。这里显式放行 F11，让它冒泡到 cycleWindowMode。返回 false
      // 表示 xterm 不要处理该键。
      terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
        // F11: 全屏切换；F2: 重命名（TabNav / ConfigNav / TerminalTabBar）
        // 返回 false 让这些键冒泡到 document，不被 xterm 消费
        if (e.type === 'keydown' && (e.key === 'F11' || e.key === 'F2')) return false;
        return true;
      });

      const tOpen = performance.now();
      terminal.open(terminalRef.current!);
      void bootLog(`initTerminal[${terminalId}]: terminal.open() took ${(performance.now() - tOpen).toFixed(0)}ms`);

      const tWebgl = performance.now();
      // dispose 后 xterm 会永久回退到 CPU canvas 渲染器（字形抗锯齿变化、滚动卡顿，
      // 看起来像「字体变了 / GPU 加速没了」）。这里在 context-loss 后重建 WebGL
      // 渲染器恢复 GPU 加速；webglRetries 上限防 GPU 持续 lost 下的重建风暴，
      // disposed 时不再重建以免组件卸载后还在创建 GL 上下文。
      let webglRetries = 0;
      const attachWebgl = () => {
        const webglAddon = new WebglAddon();
        webglAddon.onContextLoss(() => {
          webglAddon.dispose();
          try {
            if (terminal.cols === 0 || terminal.rows === 0) {
              terminal.resize(80, 24);
            }
            terminal.refresh(0, terminal.rows - 1);
          } catch { /* refresh may throw during teardown */ }
          if (disposed || webglRetries >= 5) return;
          webglRetries += 1;
          attachWebgl();
        });
        try {
          terminal.loadAddon(webglAddon);
        } catch {
          // WebGL not supported, fall back to canvas renderer
        }
      };
      attachWebgl();
      void bootLog(`initTerminal[${terminalId}]: WebGL addon took ${(performance.now() - tWebgl).toFixed(0)}ms`);

      const tFit = performance.now();
      fitAddon.fit();
      void bootLog(`initTerminal[${terminalId}]: fitAddon.fit() took ${(performance.now() - tFit).toFixed(0)}ms`);

      xtermRef.current = terminal;

      // Keep the OS IME candidate anchor stable while composing. Some TUIs
      // repaint status areas while keeping their visual input prompt elsewhere.
      const disposeStableImeAnchor = installStableImeAnchor(
        terminal,
        () => inAltBufferRef.current || hasTuiInputChrome(terminal),
      );
      if (disposeStableImeAnchor) cleanupFns.push(disposeStableImeAnchor);

      // Immediately sync PTY dimensions so TUI programs (claude code, vim, etc.)
      // get the correct size from the start instead of the estimated values
      resizeTerminal(terminalId, terminal.rows, terminal.cols).catch(() => {});
      lastPtyDimensionsRef.current = { cols: terminal.cols, rows: terminal.rows };

      // Flush buffered output that arrived before xterm was ready.
      // 同样在 join 后做 ANSI 改写，保持与 RAF 写入路径一致（见 handleOutput 注释）。
      if (outputBuffer.length > 0) {
        const combined = outputBuffer.join('');
        outputBuffer.length = 0;
        const normalized = normalizeAnsiForLightBackground(combined, lightOptimizedRef.current);
        terminal.write(normalized);
      }
      fitAddonRef.current = fitAddon;

      void bootLog(`initTerminal[${terminalId}]: TOTAL took ${(performance.now() - tTotal).toFixed(0)}ms`);

      // --- Resize handling (learned from VS Code's terminalResizeDebouncer) ---
      const doFit = (force?: boolean) => {
        if (disposed || !xtermRef.current || !fitAddonRef.current) return;

        // Don't resize while TUI is active in alternate buffer.
        // TUI programs (claude code, vim, htop) manage their own screen layout
        // and expect stable terminal dimensions.  Resize is triggered when
        // exiting the alt buffer via checkAltBuffer().
        // `force` bypasses this guard for deliberate split-screen layout changes.
        if ((inAltBufferRef.current || hasTuiInputChrome(terminal)) && !force) return;

        // 防止 fit() 在容器尺寸为 0 时把 xterm 设为 0×0（布局过渡期间可能发生）。
        // F11 切换 panels-hidden + 分屏场景：.terminal-content 宽度突变时，
        // ResizeObserver 可能在过渡帧里先于 CSS 落定拿到 0 尺寸；若直接 fit，
        // xterm 会进入 0×0 不可见状态（容器已变宽但 canvas 还是 0），表现为黑屏。
        // 阈值放宽到 < 1（只在真正为 0 时跳过），下一帧 ResizeObserver 通常会
        // 拿到稳定尺寸，fit 会自动跟上。
        const container = terminalRef.current;
        if (container) {
          const rect = container.getBoundingClientRect();
          if (rect.width < 1 || rect.height < 1) return;
        }

        const prevCols = terminal.cols;
        const prevRows = terminal.rows;
        fitAddonRef.current.fit();
        // Sync new dimensions with PTY backend, avoiding redundant calls
        if (terminal.cols !== prevCols || terminal.rows !== prevRows) {
          if (!lastPtyDimensionsRef.current ||
              lastPtyDimensionsRef.current.cols !== terminal.cols ||
              lastPtyDimensionsRef.current.rows !== terminal.rows) {
            lastPtyDimensionsRef.current = { cols: terminal.cols, rows: terminal.rows };
            resizeTerminal(terminalId, terminal.rows, terminal.cols).catch(() => {});
          }
        }
        lastDimensionsRef.current = { cols: terminal.cols, rows: terminal.rows };
      };

      // Force an immediate resize (bypasses debounce) for tab switches and other
      // visibility changes where we need the correct dimensions right away.
      let imeAnchorSyncRaf: number | null = null;
      const imeAnchorSyncTimers: number[] = [];
      const syncImeAnchorAfterLayout = () => {
        const syncImeAnchor = (terminal as any)._tbSyncImeAnchor;
        if (typeof syncImeAnchor === 'function') {
          syncImeAnchor();
        }
        if (imeAnchorSyncRaf !== null) {
          cancelAnimationFrame(imeAnchorSyncRaf);
        }
        imeAnchorSyncRaf = requestAnimationFrame(() => {
          imeAnchorSyncRaf = null;
          if (disposed) return;
          const nextSyncImeAnchor = (terminal as any)._tbSyncImeAnchor;
          if (typeof nextSyncImeAnchor === 'function') {
            nextSyncImeAnchor();
          }
        });
      };

      const syncImeAnchorThroughTuiRedraw = () => {
        syncImeAnchorAfterLayout();
        while (imeAnchorSyncTimers.length > 0) {
          window.clearTimeout(imeAnchorSyncTimers.pop());
        }
        for (const delay of [50, 150]) {
          imeAnchorSyncTimers.push(window.setTimeout(syncImeAnchorAfterLayout, delay));
        }
      };

      const forceFit = (force?: boolean) => {
        if (disposed) return;
        if (resizeTimerRef.current) {
          clearTimeout(resizeTimerRef.current);
          resizeTimerRef.current = null;
        }
        doFit(force);
        if (force) {
          syncImeAnchorThroughTuiRedraw();
        } else {
          syncImeAnchorAfterLayout();
        }
      };

      // ResizeObserver: respond to container size changes with debouncing.
      // Learned from VS Code's TerminalResizeDebouncer:
      // - Vertical resize is cheap, apply immediately
      // - Horizontal resize is expensive (reflow), debounce it
      // - When buffer is small (< 200 lines), apply immediately to avoid visual glitches
      const DEBOUNCE_THRESHOLD = 200; // Buffer length threshold for debouncing
      const HORIZONTAL_DEBOUNCE_MS = 100;

      let pendingResizeTimer: ReturnType<typeof setTimeout> | null = null;

      const applyResize = (immediate: boolean) => {
        if (disposed || !xtermRef.current) return;

        const bufferLength = xtermRef.current.buffer.normal.length;
        const isSmallBuffer = bufferLength < DEBOUNCE_THRESHOLD;

        // Apply immediately if requested or buffer is small
        if (immediate || isSmallBuffer) {
          if (pendingResizeTimer) {
            clearTimeout(pendingResizeTimer);
            pendingResizeTimer = null;
          }
          forceFit();
          return;
        }

        // For large buffers, debounce resize to avoid expensive reflow
        // blocking the UI during TUI program updates
        if (pendingResizeTimer) {
          clearTimeout(pendingResizeTimer);
        }
        pendingResizeTimer = setTimeout(() => {
          pendingResizeTimer = null;
          if (!disposed) {
            forceFit();
          }
        }, HORIZONTAL_DEBOUNCE_MS);
      };

      const resizeObserver = new ResizeObserver(() => {
        if (disposed || !xtermRef.current) return;
        applyResize(false);
      });
      const activateTimer = setTimeout(() => {
        if (!disposed) resizeObserver.observe(terminalRef.current!);
      }, 500);
      cleanupFns.push(() => {
        clearTimeout(activateTimer);
        resizeObserver.disconnect();
        if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
        if (pendingResizeTimer) clearTimeout(pendingResizeTimer);
        if (imeAnchorSyncRaf !== null) cancelAnimationFrame(imeAnchorSyncRaf);
        while (imeAnchorSyncTimers.length > 0) {
          window.clearTimeout(imeAnchorSyncTimers.pop());
        }
      });

      // Expose forceFit for the isActive effect below
      (terminal as any)._tbForceFit = forceFit;

      // --- TUI buffer tracking (learned from VS Code's terminalInstance.ts) ---
      // Track alternate buffer to detect TUI programs (vim, claude, htop, etc.)
      const checkAltBuffer = () => {
        const inAlt = terminal.buffer.active === terminal.buffer.alternate;
        if (inAltBufferRef.current && !inAlt) {
          // TUI program just exited: force viewport refresh to clear stale content.
          // This mirrors VS Code's forceRefresh() which calls viewport._innerRefresh().
          try {
            const core = (terminal as any)._core;
            core?.viewport?._innerRefresh?.();
          } catch { /* xterm internal API may change */ }
          // Schedule a deferred fit to handle any dimension mismatch
          setTimeout(() => {
            if (!disposed) forceFit();
          }, 100);
        }
        inAltBufferRef.current = inAlt;
      };
      terminal.buffer.onBufferChange(checkAltBuffer);
      checkAltBuffer();


      // Auto-focus after initialization
      terminal.focus();

      const xtermViewport = terminal.element!.querySelector('.xterm-viewport') as HTMLElement;
      if (xtermViewport) {
        scrollViewportRef.current = xtermViewport;
        const syncScrollbar = () => {
          const el = xtermViewport;
          const scrollable = el.scrollHeight > el.clientHeight;
          if (!scrollable) {
            setScrollInfo({ top: 0, height: 0, visible: false });
            return;
          }
          const ratio = el.clientHeight / el.scrollHeight;
          const thumbH = Math.max(20, el.clientHeight * ratio);
          const maxTop = el.clientHeight - thumbH;
          const scrollTop = el.scrollTop;
          const maxScrollTop = el.scrollHeight - el.clientHeight;
          const top = maxScrollTop > 0 ? (scrollTop / maxScrollTop) * maxTop : 0;
          setScrollInfo({ top, height: thumbH, visible: true });
        };
        xtermViewport.addEventListener('scroll', syncScrollbar, { passive: true });
        syncScrollbar();
        const ro = new ResizeObserver(syncScrollbar);
        ro.observe(xtermViewport);
        cleanupFns.push(() => {
          xtermViewport.removeEventListener('scroll', syncScrollbar);
          ro.disconnect();
        });
      }

      // Chunk large paste data to prevent SSH/PTY buffer overflow
      const PASTE_CHUNK_SIZE = 256;
      const PASTE_CHUNK_DELAY = 10;
      const chunkedSend = (data: string) => {
        if (data.length <= PASTE_CHUNK_SIZE) {
          onOutputRef.current(terminalId, data);
          return;
        }
        const chunks: string[] = [];
        for (let i = 0; i < data.length; i += PASTE_CHUNK_SIZE) {
          chunks.push(data.slice(i, i + PASTE_CHUNK_SIZE));
        }
        const sendNext = (idx: number) => {
          if (disposed || idx >= chunks.length) return;
          onOutputRef.current(terminalId, chunks[idx]);
          if (idx < chunks.length - 1) {
            setTimeout(() => sendNext(idx + 1), PASTE_CHUNK_DELAY);
          }
        };
        sendNext(0);
      };

      terminal.onData((data) => {
        markClaudeTerminalInteraction(terminalId, data === '\r' || data === '\n');
        // Track command history on Enter
        if (data === '\r' || data === '\n') {
          useAppStore.getState().setSessionWorking(terminalId, true);
          updateAutocomplete(null);
          // Enter 后稍等缓冲区刷新，检测 cd 命令并记录目录
          setTimeout(() => {
            if (!disposed) detectAndTrackCd(terminal, terminalId);
          }, 50);
        }

        const isBracketedPaste = data.startsWith('\x1b[200~');
        if (isBracketedPaste) {
          const inner = data.slice(6, -5);
          // 粘贴内容中可能包含 cd 命令，提取最后一个 cd 的目标目录
          const lines = inner.split(/\r?\n/);
          for (const ln of lines) {
            const trimmed = ln.trim();
            if (/^cd(\s|$)/i.test(trimmed)) {
              const args = trimmed.split(/\s+/);
              const cwd = useAppStore.getState().sessionDirectories[terminalId] || '';
              const target = resolveCdTarget(cwd, args[1]);
              if (target) {
                useAppStore.getState().setSessionDirectory(terminalId, target);
              }
            }
          }
          if (inner.includes('\n')) {
            onOutputRef.current(terminalId, data);
          } else {
            chunkedSend(data);
          }
        } else if (data.length > 1 && /[\r\n]/.test(data)) {
          const sanitized = data.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
          onOutputRef.current(terminalId, `\x1b[200~${sanitized}\x1b[201~`);
        } else {
          onOutputRef.current(terminalId, data);
        }
      });

      // Autocomplete: update suggestions on keypress
      terminal.onKey(() => {
        if (autocompleteTimer) clearTimeout(autocompleteTimer);
        autocompleteTimer = setTimeout(() => {
          if (disposed) return;
          const buffer = terminal.buffer.active;
          const input = getInputAtCursor(terminal) ?? '';
          if (!input || input.length < 1) {
            updateAutocomplete(null);
            return;
          }
          const matches = getCommandSuggestions(input);
          if (matches.length === 0) {
            updateAutocomplete(null);
            return;
          }
          // Calculate popup position
          const screenEl = terminal.element!.querySelector('.xterm-screen') as HTMLElement;
          if (!screenEl) return;
          const screenRect = screenEl.getBoundingClientRect();
          const cellW = screenRect.width / terminal.cols;
          const cellH = screenRect.height / terminal.rows;
          const anchorX = screenRect.left + buffer.cursorX * cellW;
          const anchorBelowY = screenRect.top + (buffer.cursorY + 1) * cellH;
          const anchorAboveY = screenRect.top + buffer.cursorY * cellH;
          const inlineCompletion = getAutocompleteCompletion(matches[0].command, input);
          updateAutocomplete({
            items: matches,
            index: -1,
            selectionExplicit: false,
            input,
            inlineCompletion,
            inlineX: anchorX,
            inlineY: screenRect.top + buffer.cursorY * cellH,
            inlineHeight: cellH,
            x: anchorX,
            y: anchorBelowY,
            anchorX,
            anchorBelowY,
            anchorAboveY,
          });
        }, 0);
      });

      const containerEl = terminalRef.current!;

      const acceptAutocompleteCommand = (command: string): boolean => {
        const input = getInputAtCursor(terminal);
        if (!input) return false;
        const completion = getAutocompleteCompletion(command, input);
        if (!completion) return false;
        onOutputRef.current(terminalId, completion);
        updateAutocomplete(null);
        return true;
      };

      const acceptActiveAutocomplete = (): boolean => {
        const ac = autocompleteRef.current;
        if (!ac || ac.items.length === 0) return false;
        const index = ac.index >= 0 ? ac.index : 0;
        return acceptAutocompleteCommand(ac.items[index].command);
      };

      // Capture-phase keydown — fires before xterm's internal textarea sees the event
      const handleKeyDown = (e: KeyboardEvent) => {
        // ReadOnly mode: only allow copy (Ctrl+C) and search (Ctrl+F)
        if (readOnly) {
          if (e.key === 'c' && e.ctrlKey && !e.shiftKey) {
            const selection = terminal.getSelection();
            if (selection) {
              navigator.clipboard.writeText(selection).catch(() => {});
            }
            return;
          }
          if (e.key === 'f' && e.ctrlKey && !e.shiftKey) {
            e.preventDefault();
            e.stopPropagation();
            setSearchVisible(true);
            return;
          }
          // Block all other input in readOnly mode
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        // Tab: accept autocomplete suggestion
        if (e.key === 'Tab' && !e.ctrlKey && !e.altKey) {
          if (acceptActiveAutocomplete()) {
            e.preventDefault();
            e.stopPropagation();
            return;
          }
        }
        // RightArrow: accept inline ghost suggestion, matching common terminal UX.
        if (e.key === 'ArrowRight' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
          const ac = autocompleteRef.current;
          if (ac?.inlineCompletion && acceptActiveAutocomplete()) {
            e.preventDefault();
            e.stopPropagation();
            return;
          }
        }
        // Escape: close autocomplete
        if (e.key === 'Escape') {
          if (autocompleteRef.current) {
            e.preventDefault();
            e.stopPropagation();
            updateAutocomplete(null);
            return;
          }
        }
        // ArrowUp/ArrowDown: navigate autocomplete
        if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && autocompleteRef.current) {
          const ac = autocompleteRef.current;
          if (ac.items.length > 0) {
            e.preventDefault();
            e.stopPropagation();
            let newIndex: number;
            if (e.key === 'ArrowDown') {
              newIndex = ac.index < 0 ? 0 : Math.min(ac.index + 1, ac.items.length - 1);
            } else {
              newIndex = ac.index < 0 ? ac.items.length - 1 : Math.max(ac.index - 1, 0);
            }
            updateAutocomplete({
              ...ac,
              index: newIndex,
              selectionExplicit: true,
              inlineCompletion: getAutocompleteCompletion(ac.items[newIndex].command, ac.input),
            });
            return;
          }
        }
        // Enter: accept autocomplete suggestion without submitting
        if (e.key === 'Enter' && !e.ctrlKey && !e.shiftKey && autocompleteRef.current) {
          const ac = autocompleteRef.current;
          if (ac.items.length > 0 && ac.index >= 0 && ac.selectionExplicit) {
            e.preventDefault();
            e.stopPropagation();
            acceptAutocompleteCommand(ac.items[ac.index].command);
            return;
          }
        }
        if (e.key === 'Enter' && (e.ctrlKey || e.shiftKey)) {
          e.preventDefault();
          e.stopPropagation();
          onOutputRef.current(terminalId, '\n');
          return;
        }
        if (e.key === 'c' && e.ctrlKey && !e.shiftKey) {
          const selection = terminal.getSelection();
          if (selection) {
            navigator.clipboard.writeText(selection).catch(() => {});
            e.preventDefault();
            e.stopPropagation();
          }
          return;
        }
        if (e.key === 'v' && e.ctrlKey && !e.shiftKey) {
          e.preventDefault();
          e.stopPropagation();
          // Try reading file paths from clipboard first (files copied in Explorer)
          readClipboardFilePaths().then((paths) => {
            if (paths.length > 0) {
              const IMAGE_EXT = /\.(png|jpg|jpeg|gif|bmp|ico|svg|webp|tiff|tif)$/i;
              if (paths.length === 1 && IMAGE_EXT.test(paths[0])) {
                onOutputRef.current(terminalId, `[图片:${paths[0]}]`);
              } else {
                const text = paths.map(p => p).join(' ');
                onOutputRef.current(terminalId, text);
              }
            } else {
              // No file paths — try clipboard image (e.g. screenshot), then text
              readClipboardImageAsFile().then((imagePath) => {
                onOutputRef.current(terminalId, `[图片:${imagePath}]`);
              }).catch(() => {
                navigator.clipboard.readText().then((text) => {
                  if (text) {
                    const trimmed = text.trim();
                    if (/^[A-Za-z]:[\\/]/.test(trimmed) && !trimmed.includes('\n')) {
                      onOutputRef.current(terminalId, trimmed.replace(/"/g, '\\"'));
                    } else if (text.includes('\n') || text.includes('\r')) {
                      const sanitized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
                      onOutputRef.current(terminalId, `\x1b[200~${sanitized}\x1b[201~`);
                    } else {
                      sendPastedText(text);
                    }
                  }
                }).catch(() => {});
              });
            }
          }).catch(() => {
            readClipboardImageAsFile().then((imagePath) => {
              onOutputRef.current(terminalId, `[图片:${imagePath}]`);
            }).catch(() => {
              navigator.clipboard.readText().then((text) => {
                if (text) {
                  sendPastedText(text);
                }
              }).catch(() => {});
            });
          });
          return;
        }
        if (e.key === 'f' && e.ctrlKey && !e.shiftKey) {
          e.preventDefault();
          e.stopPropagation();
          setSearchVisible(true);
          return;
        }
      };
      containerEl.addEventListener('keydown', handleKeyDown, true);
      cleanupFns.push(() => containerEl.removeEventListener('keydown', handleKeyDown, true));

      // Right-click context menu
      const xtermEl = terminal.element!;

      const shouldAutoPasteOnRightClick = (): boolean => {
        if (readOnly) return false;
        const settings = getAppSettings();
        return settings.rightClickPaste && !terminal.hasSelection();
      };

      const suppressRightClickEvent = (e: Event) => {
        e.preventDefault();
        e.stopImmediatePropagation();
      };

      const isSuppressingNativePaste = () => {
        return performance.now() < rightClickPasteRef.current.suppressNativePasteUntil;
      };

      const requestRightClickPaste = () => {
        const pasteState = rightClickPasteRef.current;
        const now = performance.now();
        pasteState.suppressNativePasteUntil = now + RIGHT_CLICK_NATIVE_PASTE_SUPPRESS_MS;

        if (pasteState.inFlight) return;
        pasteState.inFlight = true;

        readClipboardImageAsFile().then((imagePath) => {
          onOutputRef.current(terminalId, `[图片:${imagePath}]`);
          terminal.focus();
        }).catch(() => {
          navigator.clipboard.readText().then((text) => {
            if (!text) return;

            const textNow = performance.now();
            if (
              pasteState.lastText === text &&
              textNow - pasteState.lastTextAt < RIGHT_CLICK_PASTE_DEDUPE_MS
            ) {
              return;
            }

            pasteState.lastText = text;
            pasteState.lastTextAt = textNow;
            sendPastedText(text);
            terminal.focus();
          }).catch(() => {});
        }).finally(() => {
          pasteState.inFlight = false;
        });
      };

      const handleRightMouseDown = (e: MouseEvent) => {
        if (e.button !== 2 || !shouldAutoPasteOnRightClick()) return;

        // Handle auto paste before xterm moves/focuses its hidden textarea for
        // the native context menu; otherwise a later paste path can join in.
        suppressRightClickEvent(e);
        requestRightClickPaste();
      };

      const handleRightMouseUp = (e: MouseEvent) => {
        if (e.button === 2 && isSuppressingNativePaste()) {
          suppressRightClickEvent(e);
        }
      };

      const handleRightAuxClick = (e: MouseEvent) => {
        if (e.button === 2 && isSuppressingNativePaste()) {
          suppressRightClickEvent(e);
        }
      };

      const handleNativePaste = (e: ClipboardEvent) => {
        if (isSuppressingNativePaste()) {
          suppressRightClickEvent(e);
        }
      };

      const handleContextMenu = (e: MouseEvent) => {
        e.preventDefault();
        // In readOnly mode, block paste but still allow copy from context menu
        if (shouldAutoPasteOnRightClick()) {
          suppressRightClickEvent(e);
          requestRightClickPaste();
          return;
        }

        if (isSuppressingNativePaste()) {
          suppressRightClickEvent(e);
          return;
        }

        setContextMenu({
          x: e.clientX,
          y: e.clientY,
          anchorX: e.clientX,
          anchorY: e.clientY,
          visible: true,
        });
      };
      xtermEl.addEventListener('mousedown', handleRightMouseDown, true);
      xtermEl.addEventListener('mouseup', handleRightMouseUp, true);
      xtermEl.addEventListener('auxclick', handleRightAuxClick, true);
      xtermEl.addEventListener('paste', handleNativePaste, true);
      xtermEl.addEventListener('contextmenu', handleContextMenu, true);
      cleanupFns.push(() => {
        rightClickPasteRef.current.inFlight = false;
        rightClickPasteRef.current.suppressNativePasteUntil = 0;
        xtermEl.removeEventListener('mousedown', handleRightMouseDown, true);
        xtermEl.removeEventListener('mouseup', handleRightMouseUp, true);
        xtermEl.removeEventListener('auxclick', handleRightAuxClick, true);
        xtermEl.removeEventListener('paste', handleNativePaste, true);
        xtermEl.removeEventListener('contextmenu', handleContextMenu, true);
      });

      // Ctrl+hover: show pointer cursor on links
      const handleKeyDownGlobal = (e: KeyboardEvent) => {
        if (e.key === 'Control') xtermEl.classList.add('ctrl-hover');
      };
      const handleKeyUpGlobal = (e: KeyboardEvent) => {
        if (e.key === 'Control') xtermEl.classList.remove('ctrl-hover');
      };
      document.addEventListener('keydown', handleKeyDownGlobal);
      document.addEventListener('keyup', handleKeyUpGlobal);
      cleanupFns.push(() => {
        document.removeEventListener('keydown', handleKeyDownGlobal);
        document.removeEventListener('keyup', handleKeyUpGlobal);
      });

    };

    // Register Tauri event listener, then drain buffered backend output
    (async () => {
      const tListener = performance.now();
      void bootLog(`initTerminal[${terminalId}]: registering onTerminalOutput listener`);
      const unlisten = await onTerminalOutput(terminalId, handleOutput);
      if (disposed) { unlisten(); return; }
      cleanupFns.push(unlisten);
      void bootLog(`initTerminal[${terminalId}]: onTerminalOutput registered in ${(performance.now() - tListener).toFixed(0)}ms`);

      // Drain any output buffered in the backend before the listener was active
      try {
        const tDrain = performance.now();
        const drained = await drainTerminalOutput(terminalId);
        if (drained && !disposed) {
          handleOutput(drained);
        }
        void bootLog(`initTerminal[${terminalId}]: drainTerminalOutput took ${(performance.now() - tDrain).toFixed(0)}ms, len=${drained?.length ?? 0}`);
      } catch (err) {
        console.error('Failed to drain terminal output:', err);
      }
    })();

    void bootLog(`initTerminal[${terminalId}]: calling initTerminal()`);
    initTerminal();

    return () => {
      disposed = true;
      disposeClaudeTerminalNotification(terminalId);
      if (autocompleteTimer) {
        clearTimeout(autocompleteTimer);
        autocompleteTimer = null;
      }
      if (workingDebounce) {
        clearTimeout(workingDebounce);
        workingDebounce = null;
      }
      if (workingFallback) {
        clearTimeout(workingFallback);
        workingFallback = null;
      }
      if (pendingRaf) {
        cancelAnimationFrame(pendingRaf);
        pendingRaf = null;
      }
      // Reset output tracking refs
      latestWriteDataRef.current = 0;
      latestParseDataRef.current = 0;
      cleanupFns.forEach(fn => fn());
      xtermRef.current?.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, [terminalId]);

  // When tab becomes visible (isActive changes to true), force a fit to ensure
  // correct dimensions. This mirrors VS Code's setVisible() which flushes pending
  // resizes and re-evaluates dimensions on visibility change.
  useEffect(() => {
    if (!isActive) return;
    // Use double rAF to ensure the CSS visibility transition has completed
    // and layout is stable before measuring
    let raf1: number;
    let raf2: number;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        const term = xtermRef.current;
        if (!term) return;
        const forceFit = (term as any)._tbForceFit;
        if (typeof forceFit === 'function') {
          forceFit();
        }
        try {
          if (term.rows > 0) term.refresh(0, term.rows - 1);
        } catch { /* renderer may be disposing */ }
        term.focus();
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [isActive]);

  // Split-screen layout changes (enter/exit/2x1<->2x2) must force a resize even
  // when a TUI (vim/claude code) is running, so the program redraws via SIGWINCH.
  // Incidental resizes still respect the alt-buffer guard inside doFit.
  useEffect(() => {
    let raf1 = 0;
    let raf2 = 0;
    let repairTimers: ReturnType<typeof setTimeout>[] = [];
    let tuiRedrawTimer: ReturnType<typeof setTimeout> | null = null;
    const clearPendingRepair = () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      raf1 = 0;
      raf2 = 0;
      repairTimers.forEach(timer => clearTimeout(timer));
      repairTimers = [];
      if (tuiRedrawTimer) {
        clearTimeout(tuiRedrawTimer);
        tuiRedrawTimer = null;
      }
    };
    const isCurrentLayout = (detail: TerminalResizeDetail) => {
      const state = useAppStore.getState();
      if (detail.layoutVersion !== state.terminalLayoutVersion) return false;
      if (detail.splitMode !== state.splitMode || detail.windowMode !== state.windowMode) return false;
      if (state.splitMode !== 'off' && !state.splitSlots.some(slot => slot.sessionId === terminalId)) return false;
      return true;
    };
    const runLayoutRepair = (detail: TerminalResizeDetail) => {
      if (!isCurrentLayout(detail)) return;
      const term = xtermRef.current;
      if (!term) return;
      const forceFit = (term as any)._tbForceFit;
      if (typeof forceFit === 'function') forceFit(true);
      try { term.refresh(0, term.rows - 1); } catch { /* renderer may be disposing */ }
      if (
        !readOnly &&
        detail.reason === 'split-layout' &&
        lastTuiRedrawLayoutVersionRef.current !== detail.layoutVersion &&
        (inAltBufferRef.current || hasTuiInputChrome(term))
      ) {
        lastTuiRedrawLayoutVersionRef.current = detail.layoutVersion;
        tuiRedrawTimer = setTimeout(() => {
          tuiRedrawTimer = null;
          if (!isCurrentLayout(detail)) return;
          const currentTerm = xtermRef.current;
          if (!currentTerm || (!inAltBufferRef.current && !hasTuiInputChrome(currentTerm))) return;
          onOutputRef.current(terminalId, '\x0c');
        }, 260);
      }
      // Only the focused pane should steal keyboard focus on a layout change.
      if (useAppStore.getState().activeSessionId === terminalId) term.focus();
    };
    const onSplitResize = (e: Event) => {
      const detail = (e as CustomEvent<TerminalResizeDetail>).detail;
      if (!detail?.terminalIds?.includes(terminalId) || !isCurrentLayout(detail)) return;
      clearPendingRepair();
      raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => {
          runLayoutRepair(detail);
          repairTimers = [80, 220].map(delay => setTimeout(() => runLayoutRepair(detail), delay));
        });
      });
    };
    window.addEventListener(TERMINAL_RESIZE_EVENT, onSplitResize);
    return () => {
      window.removeEventListener(TERMINAL_RESIZE_EVENT, onSplitResize);
      clearPendingRepair();
    };
  }, [terminalId, readOnly]);

  // 分屏模式下缩小终端字号(2x1→12px)，退出分屏恢复原值。
  // 这里只改字号,不立即 fit；TerminalPanel 会在布局稳定后派发带版本号的
  // TERMINAL_RESIZE_EVENT，避免快速连点时把 2x1/2x2/off 的中间尺寸同步给 PTY。
  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;
    const newSize = SPLIT_FONT_SIZE[splitMode];
    if (term.options.fontSize === newSize) return;
    term.options.fontSize = newSize;
  }, [splitMode]);

  // F11 切换 windowMode（panels-hidden）时，.terminal-content 宽度突变，grid 重排
  // 需要时间落定。这里直接订阅 windowMode 再补一次 forceFit，与 TerminalPanel 派发
  // 的 tb-split-resize 互为备份——任意一条路径被 ResizeObserver 卡住时另一条仍能
  // 触发 fit。
  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;
    const forceFit = (term as any)._tbForceFit;
    if (typeof forceFit !== 'function') return;
    const scheduledLayoutVersion = useAppStore.getState().terminalLayoutVersion;
    let raf1 = 0;
    let raf2 = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        timer = setTimeout(() => {
          timer = null;
          if (useAppStore.getState().terminalLayoutVersion !== scheduledLayoutVersion) return;
          try { forceFit(true); } catch { /* terminal may be disposing */ }
        }, 50);
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      if (timer) clearTimeout(timer);
    };
  }, [windowMode]);

  const handleSearch = useCallback((direction: 'next' | 'prev' = 'next') => {
    const searchAddon = searchAddonRef.current;
    if (!searchAddon || !searchText) return;
    if (direction === 'next') {
      searchAddon.findNext(searchText, { caseSensitive: searchCaseSensitive, regex: false });
    } else {
      searchAddon.findPrevious(searchText, { caseSensitive: searchCaseSensitive, regex: false });
    }
  }, [searchText, searchCaseSensitive]);

  const handleCloseSearch = useCallback(() => {
    setSearchVisible(false);
    setSearchText('');
    searchAddonRef.current?.clearDecorations();
  }, []);

  const handleContextMenuAction = useCallback((action: 'copy' | 'paste') => {
    const terminal = xtermRef.current;
    if (!terminal) return;
    if (action === 'copy') {
      const selection = terminal.getSelection();
      if (selection) {
        navigator.clipboard.writeText(selection).catch(() => {});
      }
    } else if (!readOnly) {
      readClipboardImageAsFile().then((imagePath) => {
        onOutputRef.current(terminalId, `[图片:${imagePath}]`);
        terminal.focus();
      }).catch(() => {
        navigator.clipboard.readText().then((text) => {
          if (text) {
            sendPastedText(text);
            terminal.focus();
          }
        }).catch(() => {});
      });
    }
    setContextMenu({ x: 0, y: 0, anchorX: 0, anchorY: 0, visible: false });
  }, []);

  // Close context menu on click outside, keydown, or scroll
  useEffect(() => {
    if (!contextMenu.visible) return;
    const close = () => setContextMenu({ x: 0, y: 0, anchorX: 0, anchorY: 0, visible: false });
    document.addEventListener('click', close, { once: true });
    document.addEventListener('keydown', close);
    document.addEventListener('wheel', close);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', close);
      document.removeEventListener('wheel', close);
    };
  }, [contextMenu.visible]);

  // Close autocomplete on click outside
  useEffect(() => {
    if (!autocomplete) return;
    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.autocomplete-popup')) {
        updateAutocomplete(null);
      }
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [autocomplete]);

  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;

  // Tauri native drag-drop: listen for file drops into the window
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;

    getCurrentWebview().onDragDropEvent((event) => {
      if (cancelled) return;
      if (event.payload.type === 'enter') {
        if (isActiveRef.current) setDragOver(true);
      } else if (event.payload.type === 'over') {
        // hovering — keep drag-over state
      } else if (event.payload.type === 'drop') {
        setDragOver(false);
        if (!isActiveRef.current || readOnly) return;
        const paths = event.payload.paths;
        if (paths && paths.length > 0) {
          const text = paths.map(p => `"${p}"`).join(' ');
          onOutputRef.current(terminalId, text);
        }
      } else {
        // 'leave' / cancel
        setDragOver(false);
      }
    }).then(fn => {
      if (cancelled) { fn(); return; }
      unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Internal drag from FileTree: detect mouseup to receive dropped paths
  useEffect(() => {
    const el = terminalRef.current;
    if (!el) return;

    const handleMouseUp = () => {
      const paths = useAppStore.getState().dragPaths;
      if (!paths || !isActiveRef.current || readOnly) return;
      setInternalDragOver(false);
      const text = paths.map(p => `"${p}"`).join(' ');
      onOutputRef.current(terminalId, text);
      useAppStore.getState().setDragPaths(null);
    };

    const handleMouseMove = (e: MouseEvent) => {
      const paths = useAppStore.getState().dragPaths;
      if (!paths || !isActiveRef.current) return;
      const rect = el.getBoundingClientRect();
      const inside = e.clientX >= rect.left && e.clientX <= rect.right
                  && e.clientY >= rect.top && e.clientY <= rect.bottom;
      setInternalDragOver(inside);
    };

    el.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('mousemove', handleMouseMove);
    return () => {
      el.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('mousemove', handleMouseMove);
    };
  }, []);

  return (
    <div
      ref={terminalRef}
      className={`terminal-instance${dragOver || internalDragOver ? ' drag-over' : ''}`}
      style={{ backgroundColor: termBg }}
    >
      {searchVisible && (
        <div className="terminal-search-bar">
          <input
            className="terminal-search-input"
            value={searchText}
            onChange={(e) => {
              setSearchText(e.target.value);
              if (e.target.value) {
                searchAddonRef.current?.findNext(e.target.value, {
                  caseSensitive: searchCaseSensitive,
                  regex: false,
                });
              } else {
                searchAddonRef.current?.clearDecorations();
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                handleSearch(e.shiftKey ? 'prev' : 'next');
              } else if (e.key === 'Escape') {
                handleCloseSearch();
              }
            }}
            placeholder="搜索终端输出..."
            autoFocus
          />
          <button
            className={`terminal-search-case ${searchCaseSensitive ? 'active' : ''}`}
            onClick={() => setSearchCaseSensitive(!searchCaseSensitive)}
            title="区分大小写"
          >
            Aa
          </button>
          <button className="terminal-search-nav" onClick={() => handleSearch('prev')} title="上一个">▲</button>
          <button className="terminal-search-nav" onClick={() => handleSearch('next')} title="下一个">▼</button>
          <button className="terminal-search-close" onClick={handleCloseSearch} title="关闭 (Esc)">×</button>
        </div>
      )}
      {contextMenu.visible && (
        <div
          ref={contextMenuRef}
          className="terminal-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <div className="context-menu-item" onClick={() => handleContextMenuAction('copy')}>
            复制
          </div>
          <div className="context-menu-item" onClick={() => handleContextMenuAction('paste')}>
            粘贴
          </div>
        </div>
      )}
      {autocomplete?.inlineCompletion && (
        <div
          className="autocomplete-inline-ghost"
          style={{
            left: autocomplete.inlineX,
            top: autocomplete.inlineY,
            height: autocomplete.inlineHeight,
            lineHeight: `${autocomplete.inlineHeight}px`,
            fontSize: `${SPLIT_FONT_SIZE[splitMode]}px`,
          }}
        >
          {autocomplete.inlineCompletion}
        </div>
      )}
      {autocomplete && autocomplete.items.length > 0 && (
        <div
          ref={autocompletePopupRef}
          className="autocomplete-popup"
          style={{ left: autocomplete.x, top: autocomplete.y }}
        >
          {autocomplete.items.map((cmd, i) => (
            <div
              key={cmd.command}
              className={`autocomplete-item ${i === autocomplete.index ? 'selected' : ''}`}
              onClick={() => {
                const buffer = xtermRef.current?.buffer.active;
                const term = xtermRef.current;
                if (!buffer || !term) return;
                const input = getInputAtCursor(term);
                if (input) {
                  const completion = getAutocompleteCompletion(cmd.command, input);
                  if (completion) onOutputRef.current(terminalId, completion);
                }
                updateAutocomplete(null);
              }}
            >
              <span className="autocomplete-cmd">{cmd.command}</span>
              {cmd.kind && <span className="autocomplete-kind">{SUGGESTION_KIND_LABEL[cmd.kind]}</span>}
              <span className="autocomplete-desc">{cmd.desc}</span>
            </div>
          ))}
        </div>
      )}
      {scrollInfo.visible && (
        <div className="terminal-scroll-wrapper">
          <div className="terminal-scroll-track">
            <div
              ref={scrollThumbRef}
              className="terminal-scroll-thumb"
              style={{ top: scrollInfo.top, height: scrollInfo.height }}
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const vp = scrollViewportRef.current;
                if (!vp) return;
                const startY = e.clientY;
                const startScrollTop = vp.scrollTop;
                const maxScrollTop = vp.scrollHeight - vp.clientHeight;
                const maxThumbTop = vp.clientHeight - scrollInfo.height;
                const onMove = (ev: MouseEvent) => {
                  if (maxThumbTop <= 0 || maxScrollTop <= 0) return;
                  const delta = ev.clientY - startY;
                  vp.scrollTop = startScrollTop + (delta / maxThumbTop) * maxScrollTop;
                };
                const onUp = () => {
                  document.removeEventListener('mousemove', onMove);
                  document.removeEventListener('mouseup', onUp);
                };
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
              }}
            />
          </div>
        </div>
      )}
      <ServerMonitor terminalId={terminalId} isSsh={isSsh} />
    </div>
  );
};
