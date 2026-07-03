import { FC, useEffect, useRef, useState, useCallback } from 'react';
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
import { getAllSuggestions, type SuggestionItem } from '../data/commandTemplates';
import { normalizeAnsiForLightBackground, type TerminalColors } from '../utils/terminalTheme';
import '@xterm/xterm/css/xterm.css';
import './TerminalInstance.css';

// 终端基础字号。分屏模式下按比例缩小:2x1 → 0.9、2x2 → 0.8、单屏 → 1.0。
const BASE_FONT_SIZE = 14;
const SPLIT_FONT_SCALE: Record<'off' | '2x1' | '2x2', number> = {
  off: 1,
  '2x1': 0.9,
  '2x2': 0.8,
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
  return /^[\s─━═-]{20,}$/u.test(text);
}

function hasTuiInputChrome(terminal: Terminal): boolean {
  const buffer = terminal.buffer.active;
  let horizontalRuleCount = 0;

  for (let y = 0; y < terminal.rows; y++) {
    const line = buffer.getLine(buffer.viewportY + y);
    const text = line?.translateToString(true) ?? '';
    if (/Version:.*Claude Code|MCP:|bypass permissions|for agents|ctx:|Opus|effort/u.test(text)) {
      return true;
    }
    if (isHorizontalRuleLine(text)) horizontalRuleCount++;
  }

  return horizontalRuleCount >= 2;
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
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; visible: boolean }>({ x: 0, y: 0, visible: false });
  const [searchVisible, setSearchVisible] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const [autocomplete, setAutocomplete] = useState<{
    items: SuggestionItem[];
    index: number;
    x: number;
    y: number;
  } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [internalDragOver, setInternalDragOver] = useState(false);
  const isSsh = useAppStore(s => s.sessions.find(sess => sess.id === terminalId)?.terminalType === 'ssh');
  const windowMode = useAppStore(s => s.windowMode);
  const [scrollInfo, setScrollInfo] = useState({ top: 0, height: 0, visible: false });
  const scrollThumbRef = useRef<HTMLDivElement>(null);
  const scrollViewportRef = useRef<HTMLElement | null>(null);
  const autocompleteRef = useRef<typeof autocomplete>(null);
  const colorThemeRef = useRef(colorTheme);
  const hideCursorRef = useRef(false);
  const updateAutocomplete = useCallback((val: typeof autocomplete) => {
    autocompleteRef.current = val;
    setAutocomplete(val);
  }, []);
  colorThemeRef.current = colorTheme;

  const applyXtermTheme = useCallback((term: Terminal, hideCursor = hideCursorRef.current) => {
    const currentTheme = colorThemeRef.current;
    const bg = currentTheme?.background || '#1e1e1e';
    const fg = currentTheme?.foreground || '#cccccc';
    const lightOptimized = !!currentTheme?.lightOptimized;
    const { lightOptimized: _lightOptimized, ...xtermTheme } = currentTheme || { background: bg, foreground: fg };
    term.options.theme = hideCursor
      ? { ...xtermTheme, cursor: 'rgba(0, 0, 0, 0)', cursorAccent: 'rgba(0, 0, 0, 0)' }
      : xtermTheme;
    term.options.minimumContrastRatio = lightOptimized ? 4.5 : 1;
  }, []);

  const setVisualCursorHidden = useCallback((term: Terminal, hidden: boolean) => {
    if (hideCursorRef.current === hidden) return;
    hideCursorRef.current = hidden;
    applyXtermTheme(term, hidden);
  }, [applyXtermTheme]);

  const syncVisualCursorVisibility = useCallback((term: Terminal) => {
    setVisualCursorHidden(term, hasTuiInputChrome(term));
  }, [setVisualCursorHidden]);

  // Resize-related refs (learned from VS Code's terminal implementation)
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastDimensionsRef = useRef<{ cols: number; rows: number } | null>(null);
  const lastPtyDimensionsRef = useRef<{ cols: number; rows: number } | null>(null);
  const [termBg, setTermBg] = useState(colorTheme?.background || '#1e1e1e');
  const lightOptimizedRef = useRef(!!colorTheme?.lightOptimized);
  const inAltBufferRef = useRef(false);

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

    const handleOutput = (output: string) => {
      if (disposed || !output) return;
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
            // Use write callback to track parse state (learned from VS Code's _writeProcessData)
            // This ensures cursor position stays in sync when TUI programs update the screen
            const messageId = ++latestWriteDataRef.current;
            xtermRef.current?.write(normalized, () => {
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
      workingDebounce = setTimeout(() => {
        if (!disposed && checkBufferForPrompt()) {
          useAppStore.getState().setSessionWorking(terminalId, false);
          if (workingFallback) clearTimeout(workingFallback);
        }
      }, 300);
      // Fallback: after 1.5s of silence, force idle regardless
      workingFallback = setTimeout(() => {
        if (!disposed) {
          useAppStore.getState().setSessionWorking(terminalId, false);
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
        cursorBlink: true,
        fontSize: Math.round(BASE_FONT_SIZE * SPLIT_FONT_SCALE[splitModeRef.current]),
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

      const tOpen = performance.now();
      terminal.open(terminalRef.current!);
      void bootLog(`initTerminal[${terminalId}]: terminal.open() took ${(performance.now() - tOpen).toFixed(0)}ms`);

      const tWebgl = performance.now();
      const webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => {
        // WebGL context 丢失（常见诱因：F11 panels-hidden 切换 + 分屏 grid 重排
        // 时 canvas 瞬时变 0，GPU 抛 context-lost 事件）。dispose 后必须强制
        // 触发一次重绘，否则 xterm 会停在"等 WebGL 写下一帧"的状态，表现为黑屏。
        webglAddon.dispose();
        try {
          // 若 canvas 已被前面的 bad fit 推到 0，先恢复到一个能渲染的默认尺寸。
          // 用固定 80×24 而不是 prevCols/prevRows：避免容器仍为 0 时 resize
          // 越界写触发 WebView2 native crash。
          if (terminal.cols === 0 || terminal.rows === 0) {
            terminal.resize(80, 24);
          }
          terminal.refresh(0, terminal.rows - 1);
        } catch { /* refresh may throw during teardown */ }
      });
      try {
        terminal.loadAddon(webglAddon);
      } catch {
        // WebGL not supported, fall back to canvas renderer
      }
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
        if (inAltBufferRef.current && !force) return;

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
        syncVisualCursorVisibility(terminal);
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
      const visualCursorWriteDisposable = terminal.onWriteParsed(() => syncVisualCursorVisibility(terminal));
      const visualCursorRenderDisposable = terminal.onRender(() => syncVisualCursorVisibility(terminal));
      cleanupFns.push(() => {
        visualCursorWriteDisposable.dispose();
        visualCursorRenderDisposable.dispose();
      });
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
          const absY = buffer.baseY + buffer.cursorY;
          const line = buffer.getLine(absY);
          if (!line) return;
          const text = line.translateToString(true, 0, buffer.cursorX);
          const promptIdx = text.lastIndexOf('>');
          const input = promptIdx >= 0 ? text.substring(promptIdx + 1).trimStart() : '';
          if (!input || input.length < 1) {
            updateAutocomplete(null);
            return;
          }
          const query = input.toLowerCase();
          const all = getAllSuggestions();
          const matches = all.filter(s => {
            if (s.command === input) return false;
            return s.command.toLowerCase().startsWith(query) || s.desc.toLowerCase().includes(query);
          }).slice(0, 8);
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
          updateAutocomplete({
            items: matches,
            index: -1,
            x: screenRect.left + buffer.cursorX * cellW,
            y: screenRect.top + (buffer.cursorY + 1) * cellH,
          });
        }, 0);
      });

      const containerEl = terminalRef.current!;

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
          const ac = autocompleteRef.current;
          if (ac && ac.items.length > 0 && ac.index >= 0) {
            e.preventDefault();
            e.stopPropagation();
            const selected = ac.items[ac.index].command;
            // Read current input to compute what to append
            const buffer = terminal.buffer.active;
            const absY = buffer.baseY + buffer.cursorY;
            const line = buffer.getLine(absY);
            if (line) {
              const text = line.translateToString(true, 0, buffer.cursorX);
              const promptIdx = text.lastIndexOf('>');
              const input = promptIdx >= 0 ? text.substring(promptIdx + 1).trimStart() : '';
              const completion = selected.substring(input.length);
              if (completion) onOutputRef.current(terminalId, completion);
            }
            updateAutocomplete(null);
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
            updateAutocomplete({ ...ac, index: newIndex });
            return;
          }
        }
        // Enter: accept autocomplete suggestion without submitting
        if (e.key === 'Enter' && !e.ctrlKey && !e.shiftKey && autocompleteRef.current) {
          const ac = autocompleteRef.current;
          if (ac.items.length > 0 && ac.index >= 0) {
            e.preventDefault();
            e.stopPropagation();
            const selected = ac.items[ac.index].command;
            const buffer = terminal.buffer.active;
            const absY = buffer.baseY + buffer.cursorY;
            const line = buffer.getLine(absY);
            if (line) {
              const text = line.translateToString(true, 0, buffer.cursorX);
              const promptIdx = text.lastIndexOf('>');
              const input = promptIdx >= 0 ? text.substring(promptIdx + 1).trimStart() : '';
              const completion = selected.substring(input.length);
              if (completion) onOutputRef.current(terminalId, completion);
            }
            updateAutocomplete(null);
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
                      terminal.paste(text);
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
                  if (text.includes('\n') || text.includes('\r')) {
                    const sanitized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
                    onOutputRef.current(terminalId, `\x1b[200~${sanitized}\x1b[201~`);
                  } else {
                    terminal.paste(text);
                  }
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

      const handleContextMenu = (e: MouseEvent) => {
        e.preventDefault();
        // In readOnly mode, block paste but still allow copy from context menu
        if (!readOnly) {
          const settings = getAppSettings();
          if (settings.rightClickPaste && !terminal.hasSelection()) {
            readClipboardImageAsFile().then((imagePath) => {
              onOutputRef.current(terminalId, `[图片:${imagePath}]`);
              terminal.focus();
            }).catch(() => {
              navigator.clipboard.readText().then((text) => {
                if (text) {
                  if (text.includes('\n') || text.includes('\r')) {
                    const sanitized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
                    onOutputRef.current(terminalId, `\x1b[200~${sanitized}\x1b[201~`);
                  } else {
                    terminal.paste(text);
                  }
                  terminal.focus();
                }
              }).catch(() => {});
            });
            return;
          }
        }
        setContextMenu({ x: e.clientX, y: e.clientY, visible: true });
      };
      xtermEl.addEventListener('contextmenu', handleContextMenu);
      cleanupFns.push(() => xtermEl.removeEventListener('contextmenu', handleContextMenu));

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
  }, [terminalId, syncVisualCursorVisibility]);

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
    const onSplitResize = (e: Event) => {
      const ids = (e as CustomEvent<{ terminalIds: string[] }>).detail?.terminalIds;
      if (!ids || !ids.includes(terminalId)) return;
      cancelAnimationFrame(raf1);
      raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => {
          const term = xtermRef.current;
          if (!term) return;
          const forceFit = (term as any)._tbForceFit;
          if (typeof forceFit === 'function') forceFit(true);
          // Only the focused pane should steal keyboard focus on a layout change.
          if (useAppStore.getState().activeSessionId === terminalId) term.focus();
        });
      });
    };
    window.addEventListener('tb-split-resize', onSplitResize);
    return () => {
      window.removeEventListener('tb-split-resize', onSplitResize);
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [terminalId]);

  // 分屏模式下按比例缩小终端字号(2x1→0.9、2x2→0.8),退出分屏恢复原值。
  // 只改字号,不影响其他终端配置;改完强制重排以正确重算行列。
  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;
    const newSize = Math.round(BASE_FONT_SIZE * SPLIT_FONT_SCALE[splitMode]);
    if (term.options.fontSize === newSize) return;
    term.options.fontSize = newSize;
    const forceFit = (term as any)._tbForceFit;
    if (typeof forceFit === 'function') forceFit(true);
  }, [splitMode]);

  // F11 切换 windowMode（panels-hidden / fullscreen）时，.terminal-content
  // 宽度突变，grid 重排需要时间落定。这里直接订阅 windowMode 再补一次 forceFit，
  // 与 TerminalPanel 派发的 tb-split-resize 互为备份——任意一条路径被 ResizeObserver
  // 卡住时另一条仍能触发 fit。
  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;
    const forceFit = (term as any)._tbForceFit;
    if (typeof forceFit !== 'function') return;
    let raf1 = 0;
    let raf2 = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        timer = setTimeout(() => {
          timer = null;
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
            if (text.includes('\n') || text.includes('\r')) {
              const sanitized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
              onOutputRef.current(terminalId, `\x1b[200~${sanitized}\x1b[201~`);
            } else {
              terminal.paste(text);
            }
            terminal.focus();
          }
        }).catch(() => {});
      });
    }
    setContextMenu({ x: 0, y: 0, visible: false });
  }, []);

  // Close context menu on click outside, keydown, or scroll
  useEffect(() => {
    if (!contextMenu.visible) return;
    const close = () => setContextMenu({ x: 0, y: 0, visible: false });
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
      {autocomplete && autocomplete.items.length > 0 && (
        <div
          className="autocomplete-popup"
          style={{ left: autocomplete.x, top: autocomplete.y }}
        >
          {autocomplete.items.map((cmd, i) => (
            <div
              key={cmd.command}
              className={`autocomplete-item ${i === autocomplete.index ? 'selected' : ''}`}
              onClick={() => {
                const buffer = xtermRef.current?.buffer.active;
                if (!buffer) return;
                const absY = buffer.baseY + buffer.cursorY;
                const line = buffer.getLine(absY);
                if (line) {
                  const text = line.translateToString(true, 0, buffer.cursorX);
                  const promptIdx = text.lastIndexOf('>');
                  const input = promptIdx >= 0 ? text.substring(promptIdx + 1).trimStart() : '';
                  const completion = cmd.command.substring(input.length);
                  if (completion) onOutputRef.current(terminalId, completion);
                }
                updateAutocomplete(null);
              }}
            >
              <span className="autocomplete-cmd">{cmd.command}</span>
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
