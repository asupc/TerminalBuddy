import { FC, useEffect, useRef, useState, useCallback, useLayoutEffect } from 'react';
import { X } from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import { acknowledgeTerminalOutput, getTerminalLoadingMode, resizeTerminal, openPath, readClipboardFilePaths, onTerminalOutput, drainTerminalOutput, getWindowsBuildNumber } from '../../services/tauri';
import { ServerMonitor } from '../shared/ServerMonitor';
import { listen } from '@tauri-apps/api/event';
import { getAppSettings, matchesHotkey } from '../../utils/settings';
import { getHotkey, isAppHotkeyEvent } from '../../services/hotkeys';
import { getAllSuggestions, getTerminalSuggestions } from '../../data/commandTemplates';
import { bootLog } from '../../utils/bootLog';
import { useAppStore } from '../../stores/appStore';
import { isLightBackground, normalizeAnsiForLightBackground, type TerminalColors } from '../../utils/terminalTheme';
import { cancelPendingClaudeNotifications, handleClaudeTerminalInputActivity } from '../../services/claudeNotification';
import '@xterm/xterm/css/xterm.css';
import './TerminalInstance.css';
import { RIGHT_CLICK_PASTE_DEDUPE_MS, RIGHT_CLICK_NATIVE_PASTE_SUPPRESS_MS, resolveSplitFontSize, adaptCodexInputBackground, recolorCodexInputBuffer } from './instance-utils';
import {
  TerminalContextMenuState, AutocompleteState, RightClickPasteState,
  fitFloatingElementToViewport,
  hasTuiInputChrome, allowsTerminalAutocomplete,
  getInputAtCursor, getAutocompleteCompletion,
  getCommandSuggestions, installStableImeAnchor,
  resolveCdTarget, detectAndTrackCd, SUGGESTION_KIND_LABEL,
  pasteFromClipboard, forceFitOf, setForceFit, syncImeAnchorOf, xtermCoreOf,
} from './terminal-helpers';
import type { WebTerminalResizePayload } from './terminal-helpers';
import { usePtyResize } from './hooks/usePtyResize';
import { useDragDrop } from './hooks/useDragDrop';


interface TerminalInstanceProps {
  terminalId: string;
  onOutput: (sessionId: string, data: string) => void;
  colorTheme?: TerminalColors;
  isActive?: boolean;
  visible?: boolean;
  readOnly?: boolean;
  splitMode?: 'off' | '2x1' | '2x2';
}

// 半透明皮肤由 terminal-instance 外层统一绘制一次背景。xterm 画布保持透明，
// 避免相同 rgba 在外层与画布上重复合成（例如 45% 两层叠加后视觉接近 70%）。
const toXtermCanvasTheme = (colors: TerminalColors) => {
  const { lightOptimized: _lightOptimized, canvasBackground, ...theme } = colors;
  return colors.background.startsWith('rgba(')
    ? { ...theme, background: canvasBackground ?? 'rgba(0, 0, 0, 0)' }
    : theme;
};


export const TerminalInstance: FC<TerminalInstanceProps> = ({
  terminalId,
  onOutput,
  colorTheme,
  isActive,
  visible = true,
  readOnly,
  splitMode = 'off',
}) => {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const onOutputRef = useRef(onOutput);
  onOutputRef.current = onOutput;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const pendingWebTakeoverRecoveryRef = useRef(false);
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
  // 快捷键唤起面板内搜索框的关键字（自动弹出面板不使用）
  const [autocompleteSearch, setAutocompleteSearch] = useState('');
  const isSsh = useAppStore(s => s.sessions.find(sess => sess.id === terminalId)?.terminalType === 'ssh');
  const windowMode = useAppStore(s => s.windowMode);
  const [scrollInfo, setScrollInfo] = useState({ top: 0, height: 0, visible: false });
  const scrollViewportRef = useRef<HTMLElement | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const autocompletePopupRef = useRef<HTMLDivElement>(null);
  const autocompleteRef = useRef<typeof autocomplete>(null);
  const colorThemeRef = useRef(colorTheme);
  const codexTuiRef = useRef(false);
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

  // 关闭补全面板；搜索面板关闭后把焦点还给终端（搜索框卸载后焦点会丢失）
  const closeAutocomplete = useCallback(() => {
    if (autocompleteRef.current?.searchable) {
      xtermRef.current?.focus();
    }
    updateAutocomplete(null);
  }, [updateAutocomplete]);
  colorThemeRef.current = colorTheme;

  const sendPastedText = useCallback((text: string): boolean => {
    if (!text) return false;
    if (text.includes('\n') || text.includes('\r')) {
      // 粘贴行尾必须写 CR：ConPTY 会把输入流里的 LF 当成带 Ctrl 修饰的 Enter，
      // 在开启 kitty 键盘协议的 TUI（如 pi）里被编码成 CSI 13;5u（Ctrl+Enter=提交），
      // 导致粘贴内容被逐行提交、或 CSI-u 序列被字面插进消息文本。
      const sanitized = text.replace(/\r?\n/g, '\r');
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
    term.options.theme = toXtermCanvasTheme(currentTheme || { background: bg, foreground: fg });
    term.options.minimumContrastRatio = lightOptimized ? 4.5 : 1;
  }, []);

  // Resize-related refs (learned from VS Code's terminal implementation)
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPtyDimensionsRef = useRef<{ cols: number; rows: number } | null>(null);
  const [termBg, setTermBg] = useState(colorTheme?.background || '#1e1e1e');
  const inAltBufferRef = useRef(false);

  // Sync terminal theme (xterm canvas + outer div) when colorTheme prop changes.
  // xterm 在 options.theme 变化后自动重绘（canvas/webgl 渲染器均支持），
  // 因此切换应用主题时运行中的终端也能实时换色，而非只有外层 div 背景变化。
  // 注意 resolveTerminalColors 返回的引用稳定（cache），不会因无关渲染误触发。
  useEffect(() => {
    const bg = colorTheme?.background || '#1e1e1e';
    setTermBg(bg);
    const term = xtermRef.current;
    if (term) {
      applyXtermTheme(term);
      if (codexTuiRef.current) {
        const lightBackground = !!colorTheme?.lightOptimized
          || isLightBackground(colorTheme?.background || '#1e1e1e');
        recolorCodexInputBuffer(term, lightBackground);
      }
    }
  }, [colorTheme, applyXtermTheme]);

  useEffect(() => {
    if (!terminalRef.current) return;
    pendingWebTakeoverRecoveryRef.current = false;
    let disposed = false;
    let usesVsCodeTerminal = false;
    let unsentAckCharCount = 0;

    const cleanupFns: (() => void)[] = [];
    const preOpenOutputBuffer: string[] = [];
    const pendingLiveOutput: string[] = [];
    let terminalOutputAttached = false;
    let workingDebounce: ReturnType<typeof setTimeout> | null = null;
    let workingFallback: ReturnType<typeof setTimeout> | null = null;
    let autocompleteTimer: ReturnType<typeof setTimeout> | null = null;
    let resizeInFlight = false;
    let pendingPtyResize: { rows: number; cols: number } | null = null;
    let webTakeoverDimensions: { rows: number; cols: number } | null = null;

    const clearAutocomplete = () => {
      if (autocompleteTimer) {
        clearTimeout(autocompleteTimer);
        autocompleteTimer = null;
      }
      if (autocompleteRef.current) {
        closeAutocomplete();
      }
    };

    // Tauri invokes are asynchronous. Keep one resize in flight per terminal and
    // collapse rapid layout transitions to the newest dimensions so an older
    // response can never arrive after the stable layout resize.
    const flushPtyResize = async () => {
      if (resizeInFlight || disposed) return;
      resizeInFlight = true;
      try {
        while (!disposed && pendingPtyResize) {
          if (!visibleRef.current) {
            pendingPtyResize = null;
            break;
          }
          const next = pendingPtyResize;
          pendingPtyResize = null;
          lastPtyDimensionsRef.current = next;
          try {
            await resizeTerminal(terminalId, next.rows, next.cols);
          } catch { /* terminal may have closed while the resize was queued */ }
        }
      } finally {
        resizeInFlight = false;
        if (!disposed && pendingPtyResize) void flushPtyResize();
      }
    };

    const queuePtyResize = (rows: number, cols: number, redeclare = false) => {
      if (disposed || !visibleRef.current || rows < 1 || cols < 1) return;
      const next = { rows, cols };
      const pending = pendingPtyResize;
      const last = lastPtyDimensionsRef.current;
      if (!redeclare) {
        if (pending?.rows === rows && pending.cols === cols) return;
        if (last?.rows === rows && last.cols === cols) {
          // The latest layout returned to the size currently being processed;
          // discard an obsolete intermediate pending resize.
          pendingPtyResize = null;
          return;
        }
      }
      pendingPtyResize = next;
      void flushPtyResize();
    };

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

    const checkWorkingState = () => {
      if (disposed) return;
      if (checkBufferForPrompt()) {
        useAppStore.getState().setTerminalFallbackWorking(terminalId, false);
        if (workingFallback) clearTimeout(workingFallback);
      }
    };

    const writeTerminalOutput = (output: string) => {
      if (disposed || !output) return;
      const term = xtermRef.current;
      if (!term) {
        preOpenOutputBuffer.push(output);
        return;
      }

      const currentTheme = colorThemeRef.current;
      const lightBackground = !!currentTheme?.lightOptimized
        || isLightBackground(currentTheme?.background || '#1e1e1e');
      const tuiAdaptedOutput = codexTuiRef.current
        ? adaptCodexInputBackground(output, lightBackground)
        : output;
      const renderedOutput = normalizeAnsiForLightBackground(tuiAdaptedOutput, lightBackground);

      term.write(renderedOutput, () => {
        if (!allowsTerminalAutocomplete(term)) {
          clearAutocomplete();
        }
        if (usesVsCodeTerminal) {
          unsentAckCharCount += output.length;
          while (unsentAckCharCount > 5000) {
            unsentAckCharCount -= 5000;
            acknowledgeTerminalOutput(terminalId, 5000).catch(() => {});
          }
        }
      });
    };

    const handleOutput = (output: string) => {
      if (disposed || !output) return;
      if (!codexTuiRef.current && /OpenAI Codex|codex-cli/.test(output)) {
        codexTuiRef.current = true;
      }
      writeTerminalOutput(output);

      // Working state: reset debounce on each output, check xterm buffer for prompt
      if (workingDebounce) clearTimeout(workingDebounce);
      if (workingFallback) clearTimeout(workingFallback);
      // Quick check after 300ms — xterm buffer has clean text (no ANSI codes)
      workingDebounce = setTimeout(checkWorkingState, 300);
      // 静默一段时间后恢复空闲；Claude 的精确完成状态由 Stop Hook 更新。
      workingFallback = setTimeout(() => {
        if (!disposed) {
          useAppStore.getState().setTerminalFallbackWorking(terminalId, false);
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
      const [buildNumber, terminalLoadingMode] = await Promise.all([
        getWindowsBuildNumber(),
        getTerminalLoadingMode(terminalId),
      ]);
      usesVsCodeTerminal = terminalLoadingMode === 'vsCode';
      void bootLog(`initTerminal[${terminalId}]: terminal traits took ${(performance.now() - tBuildNum).toFixed(0)}ms, build=${buildNumber}, mode=${terminalLoadingMode}`);

      const tNewTerm = performance.now();
      const initialColors = colorTheme || {
        background: '#1e1e1e',
        foreground: '#cccccc',
      };
      const initialLightOptimized = !!initialColors.lightOptimized;
      const initialTheme = toXtermCanvasTheme(initialColors);
      const terminal = new Terminal({
        cursorBlink: false,
        cursorStyle: 'block',
        cursorInactiveStyle: 'outline',
        cursorWidth: 1,
        fontSize: resolveSplitFontSize(splitModeRef.current, getAppSettings()),
        fontFamily: "'Cascadia Mono', Consolas, 'Courier New', monospace",
        fontWeight: 'normal',
        fontWeightBold: 'bold',
        lineHeight: 1,
        letterSpacing: 0,
        scrollback: 50000,
        theme: initialTheme,
        allowTransparency: true,
        // 仅跟随应用的浅色终端启用最低对比度增强；黑板/自定义终端配色保持原样
        minimumContrastRatio: initialLightOptimized ? 4.5 : 1,
        allowProposedApi: true,
        disableStdin: !!readOnly,
        ...(buildNumber ? { windowsPty: { backend: 'conpty' as const, buildNumber } } : {}),
        reflowCursorLine: usesVsCodeTerminal,
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
      if (usesVsCodeTerminal) {
        const da1Handler = terminal.parser.registerCsiHandler({ final: 'c' }, params => {
          if (params.length === 0 || (params.length === 1 && params[0] === 0)) {
            // The VS Code terminal host answers DA1 synchronously. Consume the
            // forwarded query here so xterm does not send a delayed duplicate.
            return true;
          }
          return false;
        });
        cleanupFns.push(() => da1Handler.dispose());
      }
      void bootLog(`initTerminal[${terminalId}]: loadAddons (fit/weblinks/clipboard/search/unicode11) took ${(performance.now() - tAddons).toFixed(0)}ms`);

      // F11 默认会被 xterm 当作 VT 功能键消费（转成转义序列发给 PTY），终端持有
      // 焦点时 App.tsx 的 window/document keydown 监听收不到，表现为「非分屏模式下
      // 按 F11 没反应」。这里显式放行 F11，让它冒泡到 cycleWindowMode。返回 false
      // 表示 xterm 不要处理该键。
      terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
        // F11: 全屏切换；F2: 重命名（TabNav / ConfigNav / TerminalTabBar）
        // 返回 false 让这些键冒泡到 document，不被 xterm 消费
        if (e.type === 'keydown' && (e.key === 'F11' || e.key === 'F2')) return false;
        // 应用内快捷键（导航开关/设置/新建/关闭标签）放行到 window 分发器,不被 xterm 消费;
        // autocomplete 不在此列,由 capture 阶段 handleKeyDown 本地拦截
        if (isAppHotkeyEvent(e)) return false;
        return true;
      });

      const tOpen = performance.now();
      terminal.open(terminalRef.current!);
      void bootLog(`initTerminal[${terminalId}]: terminal.open() took ${(performance.now() - tOpen).toFixed(0)}ms`);

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
      if (visibleRef.current) {
        const tFit = performance.now();
        if (webTakeoverDimensions) {
          terminal.resize(webTakeoverDimensions.cols, webTakeoverDimensions.rows);
        } else {
          fitAddon.fit();
        }
        void bootLog(`initTerminal[${terminalId}]: fitAddon.fit() took ${(performance.now() - tFit).toFixed(0)}ms`);
      }

      xtermRef.current = terminal;

      // 创建 WebGL context 通常会连续占用主线程 20-40ms。先让终端首帧完成，
      // 再在浏览器空闲阶段切换到 GPU 渲染器，避免新建页签时出现明显掉帧。
      const attachWebglWhenIdle = () => {
        if (disposed) return;
        const tWebgl = performance.now();
        attachWebgl();
        void bootLog(`initTerminal[${terminalId}]: deferred WebGL addon took ${(performance.now() - tWebgl).toFixed(0)}ms`);
      };
      const idleWindow = window as Window & {
        requestIdleCallback?: Window['requestIdleCallback'];
        cancelIdleCallback?: Window['cancelIdleCallback'];
      };
      if (idleWindow.requestIdleCallback) {
        const idleId = idleWindow.requestIdleCallback(attachWebglWhenIdle, { timeout: 500 });
        cleanupFns.push(() => idleWindow.cancelIdleCallback?.(idleId));
      } else {
        const timerId = setTimeout(attachWebglWhenIdle, 50);
        cleanupFns.push(() => clearTimeout(timerId));
      }

      // Keep the OS IME candidate anchor stable while composing. Some TUIs
      // repaint status areas while keeping their visual input prompt elsewhere.
      const disposeStableImeAnchor = installStableImeAnchor(
        terminal,
        () => inAltBufferRef.current || hasTuiInputChrome(terminal),
      );
      if (disposeStableImeAnchor) cleanupFns.push(disposeStableImeAnchor);

      // A split-hidden pane has display:none and xterm would measure it as 5x10.
      // Wait until it is visible before fitting or synchronizing its PTY.
      if (visibleRef.current && !webTakeoverDimensions) {
        queuePtyResize(terminal.rows, terminal.cols);
      }

      // Flush buffered output that arrived before xterm was ready in one write.
      if (preOpenOutputBuffer.length > 0) {
        const combined = preOpenOutputBuffer.join('');
        preOpenOutputBuffer.length = 0;
        writeTerminalOutput(combined);
      }
      fitAddonRef.current = fitAddon;

      void bootLog(`initTerminal[${terminalId}]: TOTAL took ${(performance.now() - tTotal).toFixed(0)}ms`);

      // --- Resize handling (learned from VS Code's terminalResizeDebouncer) ---
      const doFit = (force?: boolean, redeclarePty?: boolean): boolean => {
        if (disposed || !visibleRef.current || !xtermRef.current || !fitAddonRef.current) return false;

        if (webTakeoverDimensions) {
          const { rows, cols } = webTakeoverDimensions;
          if (terminal.rows !== rows || terminal.cols !== cols) {
            terminal.resize(cols, rows);
          }
          return true;
        }

        // Don't resize while TUI is active in alternate buffer.
        // TUI programs (claude code, vim, htop) manage their own screen layout
        // and expect stable terminal dimensions.  Resize is triggered when
        // exiting the alt buffer via checkAltBuffer().
        // `force` bypasses this guard for deliberate split-screen layout changes.
        if ((inAltBufferRef.current || hasTuiInputChrome(terminal)) && !force) return false;

        // 防止 fit() 在容器尺寸为 0 时把 xterm 设为 0×0（布局过渡期间可能发生）。
        // F11 切换 panels-hidden + 分屏场景：.terminal-content 宽度突变时，
        // ResizeObserver 可能在过渡帧里先于 CSS 落定拿到 0 尺寸；若直接 fit，
        // xterm 会进入 0×0 不可见状态（容器已变宽但 canvas 还是 0），表现为黑屏。
        // 阈值放宽到 < 1（只在真正为 0 时跳过），下一帧 ResizeObserver 通常会
        // 拿到稳定尺寸，fit 会自动跟上。
        const container = terminalRef.current;
        if (container) {
          const rect = container.getBoundingClientRect();
          if (rect.width < 1 || rect.height < 1) return false;
        }

        fitAddonRef.current.fit();
        // A final layout repair may redeclare an unchanged stable size. This is
        // intentionally still serialized with all ordinary resize requests.
        queuePtyResize(terminal.rows, terminal.cols, redeclarePty);
        return true;
      };

      // Force an immediate resize (bypasses debounce) for tab switches and other
      // visibility changes where we need the correct dimensions right away.
      let imeAnchorSyncRaf: number | null = null;
      const imeAnchorSyncTimers: number[] = [];
      const syncImeAnchorAfterLayout = () => {
        const syncImeAnchor = syncImeAnchorOf(terminal);
        if (syncImeAnchor) {
          syncImeAnchor();
        }
        if (imeAnchorSyncRaf !== null) {
          cancelAnimationFrame(imeAnchorSyncRaf);
        }
        imeAnchorSyncRaf = requestAnimationFrame(() => {
          imeAnchorSyncRaf = null;
          if (disposed) return;
          const nextSyncImeAnchor = syncImeAnchorOf(terminal);
          if (nextSyncImeAnchor) {
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

      const forceFit = (force?: boolean, redeclarePty?: boolean) => {
        if (disposed || !visibleRef.current) return false;
        if (resizeTimerRef.current) {
          clearTimeout(resizeTimerRef.current);
          resizeTimerRef.current = null;
        }
        const fitted = doFit(force, redeclarePty);
        if (force) {
          syncImeAnchorThroughTuiRedraw();
        } else {
          syncImeAnchorAfterLayout();
        }
        return fitted;
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
        if (disposed || !visibleRef.current || !xtermRef.current) return;

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
        if (disposed || !visibleRef.current || !xtermRef.current) return;
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
      setForceFit(terminal, forceFit);

      // --- TUI buffer tracking (learned from VS Code's terminalInstance.ts) ---
      // Track alternate buffer to detect TUI programs (vim, claude, htop, etc.)
      const checkAltBuffer = () => {
        const inAlt = terminal.buffer.active === terminal.buffer.alternate;
        if (inAlt) {
          clearAutocomplete();
        }
        if (inAltBufferRef.current && !inAlt) {
          // TUI program just exited: force viewport refresh to clear stale content.
          // This mirrors VS Code's forceRefresh() which calls viewport._innerRefresh().
          try {
            xtermCoreOf(terminal)?.viewport?._innerRefresh?.();
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
        // Track command history on Enter
        if (data === '\r' || data === '\n') {
          handleClaudeTerminalInputActivity(terminalId);
          clearAutocomplete();
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
            // 同 sendPastedText：行尾归一化为 CR，避免 ConPTY 把 LF 当 Ctrl+Enter 上报
            onOutputRef.current(terminalId, `\x1b[200~${inner.replace(/\r?\n/g, '\r')}\x1b[201~`);
          } else {
            chunkedSend(data);
          }
        } else if (data.length > 1 && /[\r\n]/.test(data)) {
          // 同 sendPastedText：行尾归一化为 CR，避免 ConPTY 把 LF 当 Ctrl+Enter 上报
          const sanitized = data.replace(/\r?\n/g, '\r');
          onOutputRef.current(terminalId, `\x1b[200~${sanitized}\x1b[201~`);
        } else {
          onOutputRef.current(terminalId, data);
        }
      });

      // 计算补全面板锚点（光标位置），供自动弹出与快捷键唤起共用
      const computeAutocompleteAnchors = () => {
        const buffer = terminal.buffer.active;
        const screenEl = terminal.element!.querySelector('.xterm-screen') as HTMLElement;
        if (!screenEl) return null;
        const screenRect = screenEl.getBoundingClientRect();
        const cellW = screenRect.width / terminal.cols;
        const cellH = screenRect.height / terminal.rows;
        const anchorX = screenRect.left + buffer.cursorX * cellW;
        const anchorBelowY = screenRect.top + (buffer.cursorY + 1) * cellH;
        const anchorAboveY = screenRect.top + buffer.cursorY * cellH;
        return {
          x: anchorX,
          y: anchorBelowY,
          anchorX,
          anchorBelowY,
          anchorAboveY,
          inlineX: anchorX,
          inlineY: screenRect.top + buffer.cursorY * cellH,
          inlineHeight: cellH,
        };
      };

      // 打开补全面板。forceAll 时输入为空也显示全部命令（快捷键唤起，内置搜索框）
      const openAutocomplete = (forceAll = false) => {
        if (disposed) return;
        if (!allowsTerminalAutocomplete(terminal)) {
          clearAutocomplete();
          return;
        }
        const input = getInputAtCursor(terminal) ?? '';
        if (!input && !forceAll) {
          updateAutocomplete(null);
          return;
        }
        const searchable = forceAll;
        // 搜索面板用全量模糊匹配（可滚动浏览）；自动弹出保持 8 条上限
        const matches = searchable
          ? (input ? getTerminalSuggestions(input) : getAllSuggestions())
          : getCommandSuggestions(input);
        if (matches.length === 0) {
          updateAutocomplete(null);
          return;
        }
        const anchors = computeAutocompleteAnchors();
        if (!anchors) return;
        if (searchable) setAutocompleteSearch(input);
        updateAutocomplete({
          items: matches,
          // 搜索面板默认高亮第一条，Enter/Tab 直接插入
          index: searchable ? 0 : -1,
          selectionExplicit: false,
          input,
          // 空输入（全部命令）时无内联提示，避免首条命令整体浮现在光标处
          inlineCompletion: input ? getAutocompleteCompletion(matches[0].command, input) : '',
          ...anchors,
          searchable: searchable || undefined,
        });
      };

      // Autocomplete: update suggestions on keypress
      terminal.onKey(() => {
        if (autocompleteTimer) clearTimeout(autocompleteTimer);
        autocompleteTimer = setTimeout(() => {
          autocompleteTimer = null;
          openAutocomplete();
        }, 0);
      });

      const containerEl = terminalRef.current!;

      const acceptAutocompleteCommand = (command: string): boolean => {
        if (!allowsTerminalAutocomplete(terminal)) {
          clearAutocomplete();
          return false;
        }
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
        // 补全面板内部的按键（如搜索框）由面板自行处理，避免被终端快捷键逻辑截获
        if ((e.target as HTMLElement | null)?.closest?.('.autocomplete-popup')) return;
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
        // 补全面板快捷键：面板开→关、关→开（空输入时显示全部命令）
        const autocompleteHotkey = getHotkey('autocomplete');
        if (autocompleteHotkey && matchesHotkey(e, autocompleteHotkey)) {
          e.preventDefault();
          e.stopPropagation();
          if (autocompleteRef.current) {
            closeAutocomplete();
          } else {
            openAutocomplete(true);
          }
          return;
        }
        const autocompleteAllowed = allowsTerminalAutocomplete(terminal);
        if (!autocompleteAllowed) {
          clearAutocomplete();
        }
        // Tab: accept autocomplete suggestion
        if (autocompleteAllowed && e.key === 'Tab' && !e.ctrlKey && !e.altKey) {
          if (acceptActiveAutocomplete()) {
            e.preventDefault();
            e.stopPropagation();
            return;
          }
        }
        // RightArrow: accept inline ghost suggestion, matching common terminal UX.
        if (autocompleteAllowed && e.key === 'ArrowRight' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
          const ac = autocompleteRef.current;
          if (ac?.inlineCompletion && acceptActiveAutocomplete()) {
            e.preventDefault();
            e.stopPropagation();
            return;
          }
        }
        // Escape: close autocomplete
        if (autocompleteAllowed && e.key === 'Escape') {
          if (autocompleteRef.current) {
            e.preventDefault();
            e.stopPropagation();
            updateAutocomplete(null);
            return;
          }
        }
        // ArrowUp/ArrowDown: navigate autocomplete
        if (autocompleteAllowed && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && autocompleteRef.current) {
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
        if (autocompleteAllowed && e.key === 'Enter' && !e.ctrlKey && !e.shiftKey && autocompleteRef.current) {
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
                onOutputRef.current(terminalId, paths.join(' '));
              }
            } else {
              // No file paths — fall back to image (e.g. screenshot), then text
              void pasteFromClipboard().then((result) => {
                if (!result) return;
                if (result.kind === 'image') {
                  onOutputRef.current(terminalId, `[图片:${result.path}]`);
                  return;
                }
                const text = result.text;
                const trimmed = text.trim();
                if (/^[A-Za-z]:[\\/]/.test(trimmed) && !trimmed.includes('\n')) {
                  onOutputRef.current(terminalId, trimmed.replace(/"/g, '\\"'));
                } else if (text.includes('\n') || text.includes('\r')) {
                  const sanitized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
                  onOutputRef.current(terminalId, `\x1b[200~${sanitized}\x1b[201~`);
                } else {
                  sendPastedText(text);
                }
              });
            }
          }).catch(() => {
            // readClipboardFilePaths 失败（无文件剪贴板权限等）→ 图片/文本回退
            void pasteFromClipboard().then((result) => {
              if (!result) return;
              if (result.kind === 'image') {
                onOutputRef.current(terminalId, `[图片:${result.path}]`);
              } else {
                sendPastedText(result.text);
              }
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

        void pasteFromClipboard().then((result) => {
          if (!result) return;
          if (result.kind === 'image') {
            onOutputRef.current(terminalId, `[图片:${result.path}]`);
          } else {
            const text = result.text;
            if (
              pasteState.lastText === text &&
              performance.now() - pasteState.lastTextAt < RIGHT_CLICK_PASTE_DEDUPE_MS
            ) {
              return;
            }
            pasteState.lastText = text;
            pasteState.lastTextAt = performance.now();
            sendPastedText(text);
          }
          terminal.focus();
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

    void Promise.all([
      listen<WebTerminalResizePayload>('terminal-web-resize', (event) => {
        const payload = event.payload;
        if (payload.terminalId !== terminalId || disposed) return;

        useAppStore.getState().setTerminalWebTakeover(terminalId, true);
        pendingWebTakeoverRecoveryRef.current = false;
        webTakeoverDimensions = { rows: payload.rows, cols: payload.cols };
        pendingPtyResize = null;
        lastPtyDimensionsRef.current = webTakeoverDimensions;

        const terminal = xtermRef.current;
        if (!terminal) return;
        if (terminal.rows !== payload.rows || terminal.cols !== payload.cols) {
          terminal.resize(payload.cols, payload.rows);
        }
        try { terminal.refresh(0, terminal.rows - 1); } catch { /* renderer may be disposing */ }
      }),
      listen<string>('terminal-web-takeover-ended', (event) => {
        if (event.payload !== terminalId || disposed) return;

        useAppStore.getState().setTerminalWebTakeover(terminalId, false);
        webTakeoverDimensions = null;
        pendingPtyResize = null;
        lastPtyDimensionsRef.current = null;

        const terminal = xtermRef.current;
        if (!terminal || !visibleRef.current) {
          pendingWebTakeoverRecoveryRef.current = true;
          return;
        }
        const forceFit = forceFitOf(terminal);
        if (forceFit) {
          pendingWebTakeoverRecoveryRef.current = !forceFit(true, true);
        } else if (fitAddonRef.current) {
          fitAddonRef.current.fit();
          queuePtyResize(terminal.rows, terminal.cols, true);
          pendingWebTakeoverRecoveryRef.current = false;
        }
      }),
    ]).then((unlisteners) => {
      if (disposed) {
        unlisteners.forEach((unlisten) => unlisten());
        return;
      }
      cleanupFns.push(...unlisteners);
    });

    // Register the listener before attaching, but hold live events until the
    // startup snapshot has been written. The backend handshake guarantees that
    // snapshot output is never also emitted as a live event.
    (async () => {
      const tListener = performance.now();
      void bootLog(`initTerminal[${terminalId}]: registering onTerminalOutput listener`);
      const handleLiveOutput = (output: string) => {
        if (terminalOutputAttached) {
          handleOutput(output);
        } else if (output) {
          pendingLiveOutput.push(output);
        }
      };
      const unlisten = await onTerminalOutput(terminalId, handleLiveOutput);
      if (disposed) { unlisten(); return; }
      cleanupFns.push(unlisten);
      void bootLog(`initTerminal[${terminalId}]: onTerminalOutput registered in ${(performance.now() - tListener).toFixed(0)}ms`);

      // Atomically attach and fetch everything produced before live delivery starts.
      try {
        const tDrain = performance.now();
        const drained = await drainTerminalOutput(terminalId);
        if (drained && !disposed) {
          handleOutput(drained);
        }
        if (!disposed) {
          terminalOutputAttached = true;
          if (pendingLiveOutput.length > 0) {
            const pending = pendingLiveOutput.join('');
            pendingLiveOutput.length = 0;
            handleOutput(pending);
          }
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
      cancelPendingClaudeNotifications(terminalId);
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
      pendingPtyResize = null;
      pendingLiveOutput.length = 0;
      cleanupFns.forEach(fn => fn());
      xtermRef.current?.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, [terminalId]);

  usePtyResize({
    terminalRef,
    xtermRef,
    fitAddonRef,
    visibleRef,
    pendingWebTakeoverRecoveryRef,
    terminalId,
    isActive,
    visible,
    splitMode,
    windowMode,
  });

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
      void pasteFromClipboard().then((result) => {
        if (!result) return;
        if (result.kind === 'image') {
          onOutputRef.current(terminalId, `[图片:${result.path}]`);
        } else {
          sendPastedText(result.text);
        }
        terminal.focus();
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
        closeAutocomplete();
      }
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [autocomplete, closeAutocomplete]);

  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;

  const { dragOver, internalDragOver } = useDragDrop({
    terminalRef,
    isActiveRef,
    readOnly,
    onDrop: (text) => {
      onOutputRef.current(terminalId, text);
      xtermRef.current?.focus();
    },
  });

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
          <button className="terminal-search-close" onClick={handleCloseSearch} title="关闭 (Esc)" aria-label="关闭搜索">
            <X aria-hidden="true" />
          </button>
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
            fontSize: `${resolveSplitFontSize(splitMode, getAppSettings())}px`,
          }}
        >
          {autocomplete.inlineCompletion}
        </div>
      )}
      {autocomplete && (autocomplete.items.length > 0 || autocomplete.searchable) && (
        <div
          ref={autocompletePopupRef}
          className={`autocomplete-popup ${autocomplete.searchable ? 'has-search' : ''}`}
          style={{ left: autocomplete.x, top: autocomplete.y }}
        >
          {autocomplete.searchable && (
            <input
              className="autocomplete-search"
              type="text"
              placeholder="搜索命令或说明..."
              value={autocompleteSearch}
              autoFocus
              onChange={(e) => {
                const query = e.target.value;
                setAutocompleteSearch(query);
                const items = query ? getTerminalSuggestions(query) : getAllSuggestions();
                updateAutocomplete({ ...autocomplete, items, index: items.length > 0 ? 0 : -1 });
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  e.stopPropagation();
                  closeAutocomplete();
                  return;
                }
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  if (autocomplete.items.length === 0) return;
                  e.preventDefault();
                  e.stopPropagation();
                  const delta = e.key === 'ArrowDown' ? 1 : -1;
                  const next = Math.min(Math.max(autocomplete.index + delta, 0), autocomplete.items.length - 1);
                  updateAutocomplete({ ...autocomplete, index: next });
                  return;
                }
                if (e.key === 'Enter' || (e.key === 'Tab' && !e.shiftKey)) {
                  const item = autocomplete.items[autocomplete.index >= 0 ? autocomplete.index : 0];
                  if (!item) return;
                  e.preventDefault();
                  e.stopPropagation();
                  onOutputRef.current(terminalId, item.command);
                  closeAutocomplete();
                }
              }}
            />
          )}
          {autocomplete.items.length === 0 && (
            <div className="autocomplete-empty">无匹配命令</div>
          )}
          {autocomplete.items.map((cmd, i) => (
            <div
              key={cmd.command}
              className={`autocomplete-item ${i === autocomplete.index ? 'selected' : ''}`}
              onClick={() => {
                const buffer = xtermRef.current?.buffer.active;
                const term = xtermRef.current;
                if (!buffer || !term || !allowsTerminalAutocomplete(term)) {
                  closeAutocomplete();
                  return;
                }
                const input = getInputAtCursor(term);
                if (autocomplete.searchable || !input) {
                  // 搜索面板或输入为空：整条插入命令
                  onOutputRef.current(terminalId, cmd.command);
                } else {
                  const completion = getAutocompleteCompletion(cmd.command, input);
                  if (completion) onOutputRef.current(terminalId, completion);
                }
                closeAutocomplete();
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
      <ServerMonitor terminalId={terminalId} isSsh={isSsh} isActive={Boolean(isActive)} />
    </div>
  );
};
