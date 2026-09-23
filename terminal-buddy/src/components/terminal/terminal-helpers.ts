import type { Terminal } from '@xterm/xterm';
import { FLOATING_MENU_MARGIN } from './instance-utils';
import { useAppStore } from '../../stores/appStore';
import type { SuggestionItem } from '../../data/commandTemplates';
import { getTerminalSuggestions } from '../../data/commandTemplates';
import { readClipboardImageAsFile } from '../../services/tauri';

export type WebTerminalResizePayload = {
  terminalId: string;
  rows: number;
  cols: number;
};

export type XtermCompositionHelper = {
  updateCompositionElements?: (dontRecurse?: boolean) => void;
  _compositionView?: HTMLElement;
  _textarea?: HTMLTextAreaElement;
};

export type XtermCore = {
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

export type TerminalContextMenuState = {
  x: number;
  y: number;
  anchorX: number;
  anchorY: number;
  visible: boolean;
};

export type AutocompleteState = {
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
  /** 快捷键唤起的面板内置搜索框（自动弹出面板无搜索框） */
  searchable?: boolean;
};

export type RightClickPasteState = {
  inFlight: boolean;
  suppressNativePasteUntil: number;
  lastText: string;
  lastTextAt: number;
};

export function fitFloatingElementToViewport(
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

export type ImeAnchor = {
  left: string;
  top: string;
  width: string;
  height: string;
  lineHeight: string;
  fontFamily: string;
  fontSize: string;
};

export type ImeAnchorCell = {
  x: number;
  y: number;
  widthCells: number;
  inputTopY: number;
  inputBottomY: number;
  cols: number;
  rows: number;
};

export function isHorizontalRuleLine(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 20) return false;

  return /^[─━═-]+$/u.test(trimmed) ||
    /^[╭╰┌└├┬┴┼╮╯┐┘┤│┃║\s─━═-]+$/u.test(trimmed);
}

export function hasTuiInputChrome(terminal: Terminal): boolean {
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

export function allowsTerminalAutocomplete(terminal: Terminal): boolean {
  return terminal.buffer.active !== terminal.buffer.alternate && !hasTuiInputChrome(terminal);
}

export function getLastNonBlankCell(line: ReturnType<Terminal['buffer']['active']['getLine']>, cols: number): number {
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

export function getInputAtCursor(terminal: Terminal): string | null {
  const buffer = terminal.buffer.active;
  const absY = buffer.baseY + buffer.cursorY;
  const line = buffer.getLine(absY);
  if (!line) return null;

  const text = line.translateToString(true, 0, buffer.cursorX);
  const promptIdx = text.lastIndexOf('>');
  return (promptIdx >= 0 ? text.substring(promptIdx + 1) : text).trimStart();
}

export function getAutocompleteCompletion(command: string, input: string): string {
  if (!input || command.length <= input.length) return '';
  if (!command.toLowerCase().startsWith(input.toLowerCase())) return '';
  return command.substring(input.length);
}

export function getCommandSuggestions(input: string): SuggestionItem[] {
  return getTerminalSuggestions(input).slice(0, 8);
}

export const SUGGESTION_KIND_LABEL: Record<NonNullable<SuggestionItem['kind']>, string> = {
  command: '命令',
  subcommand: '子命令',
  option: '参数',
  argument: '值',
  template: '模板',
};

export function findBottomPromptAnchor(terminal: Terminal): ImeAnchorCell | null {
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

export function installStableImeAnchor(terminal: Terminal, shouldUsePromptAnchor: () => boolean): (() => void) | undefined {
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
export function resolveCdTarget(cwd: string, arg: string | undefined): string | null {
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
export function detectAndTrackCd(terminal: Terminal, terminalId: string) {
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

// --- xterm 私有 API 访问收敛 ---
// 这些是版本锁定的内部接口（_tbForceFit 为本项目挂载），带类型注记便于替换。

export type ForceFitFn = (force?: boolean, redeclarePty?: boolean) => boolean;

export function forceFitOf(term: Terminal): ForceFitFn | null {
  const fn = (term as any)._tbForceFit;
  return typeof fn === 'function' ? fn : null;
}

export function setForceFit(term: Terminal, fn: ForceFitFn): void {
  (term as any)._tbForceFit = fn;
}

export function syncImeAnchorOf(term: Terminal): (() => void) | null {
  const fn = (term as any)._tbSyncImeAnchor;
  return typeof fn === 'function' ? fn : null;
}

export function xtermCoreOf(term: Terminal): { viewport?: { _innerRefresh?: () => void } } | null {
  return ((term as any)._core as { viewport?: { _innerRefresh?: () => void } } | undefined) ?? null;
}

// --- 剪贴板粘贴（图片/文本三级回退的单一实现） ---

export type ClipboardPasteResult =
  | { kind: 'image'; path: string }
  | { kind: 'text'; text: string }
  | null;

/** 读取剪贴板：优先图片（截图），否则回退纯文本；两者均不可用时返回 null。 */
export async function pasteFromClipboard(): Promise<ClipboardPasteResult> {
  try {
    const imagePath = await readClipboardImageAsFile();
    return { kind: 'image', path: imagePath };
  } catch {
    try {
      const text = await navigator.clipboard.readText();
      return text ? { kind: 'text', text } : null;
    } catch {
      return null;
    }
  }
}

