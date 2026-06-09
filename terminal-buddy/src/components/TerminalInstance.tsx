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
import { useAppStore } from '../stores/appStore';
import { getAllSuggestions, type SuggestionItem } from '../data/commandTemplates';
import '@xterm/xterm/css/xterm.css';
import './TerminalInstance.css';

interface TerminalInstanceProps {
  terminalId: string;
  onOutput: (sessionId: string, data: string) => void;
  colorTheme?: { background: string; foreground: string };
  isActive?: boolean;
  readOnly?: boolean;
}

export const TerminalInstance: FC<TerminalInstanceProps> = ({
  terminalId,
  onOutput,
  colorTheme,
  isActive,
  readOnly,
}) => {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const onOutputRef = useRef(onOutput);
  onOutputRef.current = onOutput;
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
  const [scrollInfo, setScrollInfo] = useState({ top: 0, height: 0, visible: false });
  const scrollThumbRef = useRef<HTMLDivElement>(null);
  const scrollViewportRef = useRef<HTMLElement | null>(null);
  const autocompleteRef = useRef<typeof autocomplete>(null);
  const updateAutocomplete = useCallback((val: typeof autocomplete) => {
    autocompleteRef.current = val;
    setAutocomplete(val);
  }, []);

  // Resize-related refs (learned from VS Code's terminal implementation)
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastDimensionsRef = useRef<{ cols: number; rows: number } | null>(null);
  const lastPtyDimensionsRef = useRef<{ cols: number; rows: number } | null>(null);
  const [termBg, setTermBg] = useState(colorTheme?.background || '#1e1e1e');
  const inAltBufferRef = useRef(false);

  // Output tracking refs (learned from VS Code's terminalInstance.ts)
  // These track write/parse state to ensure cursor position stays in sync
  const latestWriteDataRef = useRef(0);
  const latestParseDataRef = useRef(0);

  // Sync background color when colorTheme prop changes
  useEffect(() => {
    setTermBg(colorTheme?.background || '#1e1e1e');
  }, [colorTheme?.background]);

  useEffect(() => {
    if (!terminalRef.current) return;
    let disposed = false;

    const cleanupFns: (() => void)[] = [];
    const outputBuffer: string[] = [];
    const pendingChunks: string[] = [];
    let pendingRaf: number | null = null;
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
        pendingChunks.push(output);
        if (!pendingRaf) {
          pendingRaf = requestAnimationFrame(() => {
            pendingRaf = null;
            if (disposed) return;
            const combined = pendingChunks.join('');
            pendingChunks.length = 0;
            // Use write callback to track parse state (learned from VS Code's _writeProcessData)
            // This ensures cursor position stays in sync when TUI programs update the screen
            const messageId = ++latestWriteDataRef.current;
            xtermRef.current?.write(combined, () => {
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
      // Wait for fonts to be fully loaded so xterm measures correct cell dimensions
      await document.fonts.ready;

      if (disposed || !terminalRef.current) return;

      const buildNumber = await getWindowsBuildNumber();

      const terminal = new Terminal({
        cursorBlink: true,
        fontSize: 14,
        fontFamily: "'Cascadia Mono', Consolas, 'Courier New', monospace",
        fontWeight: 'normal',
        fontWeightBold: 'bold',
        lineHeight: 1,
        letterSpacing: 0,
        scrollback: 50000,
        theme: {
          background: colorTheme?.background || '#1e1e1e',
          foreground: colorTheme?.foreground || '#cccccc',
        },
        allowProposedApi: true,
        disableStdin: !!readOnly,
        ...(buildNumber ? { windowsPty: { backend: 'conpty' as const, buildNumber } } : {}),
      });

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

      terminal.open(terminalRef.current!);

      const webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => {
        webglAddon.dispose();
      });
      try {
        terminal.loadAddon(webglAddon);
      } catch {
        // WebGL not supported, fall back to canvas renderer
      }

      fitAddon.fit();

      xtermRef.current = terminal;

      // Immediately sync PTY dimensions so TUI programs (claude code, vim, etc.)
      // get the correct size from the start instead of the estimated values
      resizeTerminal(terminalId, terminal.rows, terminal.cols).catch(() => {});
      lastPtyDimensionsRef.current = { cols: terminal.cols, rows: terminal.rows };

      // --- IME candidate window stabilization ---
      // Problem: xterm.js's CompositionHelper.updateCompositionElements() moves
      // the textarea to follow the cursor during composition.  When a TUI program
      // (claude, vim) updates the screen rapidly, the cursor moves on every
      // write(), causing the IME candidate window to jump.
      //
      // Solution: Monkey-patch the CompositionHelper to skip position updates
      // during composition.  The textarea stays at the position where the user
      // started typing, keeping the candidate window stable.
      try {
        const core = (terminal as any)._core;
        const compositionHelper = core?._compositionHelper;
        if (compositionHelper) {
          const originalUpdate = compositionHelper.updateCompositionElements?.bind(compositionHelper);
          if (originalUpdate) {
            let isImeComposing = false;
            let lockedLeft = '';
            let lockedTop = '';

            // Track composition state via events on the textarea
            const ta = compositionHelper._textarea as HTMLTextAreaElement | undefined;
            if (ta) {
              ta.addEventListener('compositionstart', () => {
                isImeComposing = true;
                // Capture position where composition started
                lockedLeft = ta.style.left || '0px';
                lockedTop = ta.style.top || '0px';
              });
              ta.addEventListener('compositionend', () => {
                // Delay clearing to prevent post-composition jumps from TUI output
                setTimeout(() => {
                  isImeComposing = false;
                  lockedLeft = '';
                  lockedTop = '';
                }, 200);
              });
            }

            compositionHelper.updateCompositionElements = function(dontRecurse?: boolean) {
              if (isImeComposing) {
                // Skip position update during composition to keep candidate window stable.
                // Just update the composition view text content if needed.
                const cv = compositionHelper._compositionView as HTMLElement | undefined;
                if (cv && compositionHelper._compositionSuffix) {
                  cv.textContent = compositionHelper._compositionSuffix;
                }
                // Restore locked position on both textarea and composition view
                if (ta && lockedLeft && lockedTop) {
                  ta.style.left = lockedLeft;
                  ta.style.top = lockedTop;
                }
                if (cv && lockedLeft && lockedTop) {
                  cv.style.left = lockedLeft;
                  cv.style.top = lockedTop;
                }
                return;
              }
              originalUpdate(dontRecurse);
            };
          }
        }
      } catch {
        // xterm.js internal API may change between versions
      }
      // Flush buffered output that arrived before xterm was ready
      if (outputBuffer.length > 0) {
        terminal.write(outputBuffer.join(''));
        outputBuffer.length = 0;
      }
      fitAddonRef.current = fitAddon;

      // --- Resize handling (learned from VS Code's terminalResizeDebouncer) ---
      const doFit = () => {
        if (disposed || !xtermRef.current || !fitAddonRef.current) return;

        // Check if terminal is still parsing data (learned from VS Code's _flushXtermData)
        // If data is being parsed, delay resize to avoid cursor position issues
        // This prevents the cursor from jumping when TUI programs update the screen
        if (latestWriteDataRef.current !== latestParseDataRef.current) {
          // Data is being parsed, schedule a retry after a short delay
          setTimeout(() => {
            if (!disposed) doFit();
          }, 16); // ~1 frame at 60fps
          return;
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
      const forceFit = () => {
        if (disposed) return;
        if (resizeTimerRef.current) {
          clearTimeout(resizeTimerRef.current);
          resizeTimerRef.current = null;
        }
        doFit();
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
        // Track command history on Enter
        if (data === '\r' || data === '\n') {
          useAppStore.getState().setSessionWorking(terminalId, true);
          updateAutocomplete(null);
        }

        const isBracketedPaste = data.startsWith('\x1b[200~');
        if (isBracketedPaste) {
          const inner = data.slice(6, -5);
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
                const text = paths.map(p => `"${p}"`).join(' ');
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
                      onOutputRef.current(terminalId, `"${trimmed.replace(/"/g, '\\"')}"`);
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
      const unlisten = await onTerminalOutput(terminalId, handleOutput);
      if (disposed) { unlisten(); return; }
      cleanupFns.push(unlisten);

      // Drain any output buffered in the backend before the listener was active
      try {
        const drained = await drainTerminalOutput(terminalId);
        if (drained && !disposed) {
          handleOutput(drained);
        }
      } catch (err) {
        console.error('Failed to drain terminal output:', err);
      }
    })();

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
        term.focus();
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [isActive]);

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
