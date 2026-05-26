import { FC, useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { resizeTerminal, openPath, readClipboardFilePaths, onTerminalOutput, drainTerminalOutput, getWindowsBuildNumber } from '../services/tauri';
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
}

export const TerminalInstance: FC<TerminalInstanceProps> = ({
  terminalId,
  onOutput,
  colorTheme,
  isActive,
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
  const [scrollInfo, setScrollInfo] = useState({ top: 0, height: 0, visible: false });
  const scrollThumbRef = useRef<HTMLDivElement>(null);
  const scrollViewportRef = useRef<HTMLElement | null>(null);
  const autocompleteRef = useRef<typeof autocomplete>(null);
  const updateAutocomplete = useCallback((val: typeof autocomplete) => {
    autocompleteRef.current = val;
    setAutocomplete(val);
  }, []);

  useEffect(() => {
    if (!terminalRef.current) return;
    let disposed = false;

    const cleanupFns: (() => void)[] = [];
    const outputBuffer: string[] = [];
    const pendingChunks: string[] = [];
    let pendingRaf: number | null = null;
    let workingDebounce: ReturnType<typeof setTimeout> | null = null;
    let workingFallback: ReturnType<typeof setTimeout> | null = null;

    // IME position lock — Chinese/Japanese/Korean input method candidate
    // windows follow the .xterm-helper-textarea position.  During TUI
    // output (spinners, status lines), xterm.js repositions this element
    // to match the canvas cursor on every write(), causing the candidate
    // window to jump or even drift to another monitor.
    //
    // Solution: CSS !important rules (see TerminalInstance.css .ime-locked)
    // override xterm.js's inline style updates.  We save the textarea
    // position from user input events and apply it via CSS custom properties
    // + the .ime-locked class during composition.  This is proactive — the
    // inline style never takes effect — unlike MutationObserver which can
    // only react after the change.
    let isComposing = false;
    let savedLeft = '';
    let savedTop = '';
    let hasUserPosition = false;
    let textareaEl: HTMLTextAreaElement | null = null;
    let compViewEl: HTMLElement | null = null;

    // Validate that a textarea position is within the terminal's visible
    // screen area.  Prevents saving (and locking to) coordinates that would
    // place the IME candidate window off-screen or on another monitor.
    const isPositionInBounds = (left: string, top: string): boolean => {
      if (!xtermRef.current) return false;
      const screenEl = xtermRef.current.element?.querySelector('.xterm-screen') as HTMLElement | null;
      if (!screenEl) return true; // can't check, assume ok
      const rect = screenEl.getBoundingClientRect();
      const x = parseFloat(left);
      const y = parseFloat(top);
      if (isNaN(x) || isNaN(y)) return false;
      return x >= 0 && y >= 0 && x < rect.width && y < rect.height;
    };

    // Save textarea position with bounds validation
    const saveTextPosition = (left: string, top: string) => {
      if (left && top && isPositionInBounds(left, top)) {
        savedLeft = left;
        savedTop = top;
        hasUserPosition = true;
      }
    };

    // Apply CSS !important lock to textarea and composition-view
    const applyImeLock = () => {
      if (!textareaEl || !savedLeft || !savedTop) return;
      textareaEl.style.setProperty('--ime-lock-left', savedLeft);
      textareaEl.style.setProperty('--ime-lock-top', savedTop);
      textareaEl.classList.add('ime-locked');
      if (compViewEl) {
        compViewEl.style.setProperty('--ime-lock-left', savedLeft);
        compViewEl.style.setProperty('--ime-lock-top', savedTop);
        compViewEl.classList.add('ime-locked');
      }
    };

    // Remove CSS !important lock
    const removeImeLock = () => {
      if (textareaEl) {
        textareaEl.classList.remove('ime-locked');
        textareaEl.style.removeProperty('--ime-lock-left');
        textareaEl.style.removeProperty('--ime-lock-top');
      }
      if (compViewEl) {
        compViewEl.classList.remove('ime-locked');
        compViewEl.style.removeProperty('--ime-lock-left');
        compViewEl.style.removeProperty('--ime-lock-top');
      }
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
            xtermRef.current?.write(combined);
          });
        }
      } else {
        outputBuffer.push(output);
      }

      // During composition, the CSS .ime-locked class prevents xterm.js
      // from moving the textarea.  No action needed here — the proactive
      // CSS approach is sufficient.

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
        fontFamily: "Cascadia Code, Consolas, 'Courier New', monospace",
        fontWeight: 'normal',
        fontWeightBold: 'bold',
        scrollback: 50000,
        theme: {
          background: colorTheme?.background || '#1e1e1e',
          foreground: colorTheme?.foreground || '#cccccc',
        },
        allowProposedApi: true,
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

      fitAddon.fit();
      // Immediately sync PTY size — the PTY was created with 80x24,
      // but the container may be much larger.  Without this, TUI programs
      // (Claude Code, vim, etc.) that start before ResizeObserver fires
      // will detect the wrong terminal width.
      const { rows: initRows, cols: initCols } = terminal;
      if (initCols > 0 && initRows > 0) {
        resizeTerminal(terminalId, initRows, initCols).catch(() => {});
      }

      xtermRef.current = terminal;
      // Flush buffered output that arrived before xterm was ready
      if (outputBuffer.length > 0) {
        terminal.write(outputBuffer.join(''));
        outputBuffer.length = 0;
      }
      fitAddonRef.current = fitAddon;

      // Auto-focus after initialization
      terminal.focus();

      // Capture textarea elements for IME position lock
      textareaEl = terminal.element!.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null;
      compViewEl = terminal.element!.querySelector('.xterm-composition-view') as HTMLElement | null;
      if (textareaEl) {
        textareaEl.addEventListener('compositionstart', () => {
          isComposing = true;
          // Save textarea position at composition start.  If we have a
          // position from prior user input (click / keystroke), use that
          // — the textarea may currently be at a TUI cursor position.
          // Otherwise, read from the DOM (xterm.js positions the textarea
          // on compositionstart via _syncTextArea, matching VS Code's
          // approach).
          if (!hasUserPosition) {
            // Wait one frame for xterm.js's compositionstart handler
            // to call _syncTextArea, positioning the textarea at the
            // current buffer cursor.
            requestAnimationFrame(() => {
              if (!isComposing || disposed) return;
              saveTextPosition(textareaEl!.style.left, textareaEl!.style.top);
              applyImeLock();
            });
          } else {
            applyImeLock();
          }
        });

        textareaEl.addEventListener('compositionend', () => {
          isComposing = false;
          removeImeLock();
          // Save current position for the next composition.  After
          // composition ends the cursor has moved right by the length
          // of the committed text, so this is the correct position for
          // subsequent composition at the same prompt.
          if (textareaEl) {
            setTimeout(() => {
              if (disposed || !textareaEl) return;
              saveTextPosition(textareaEl.style.left, textareaEl.style.top);
            }, 50);
          }
        });
      }

      // Prevent horizontal content shift during IME composition.
      // When the cursor is near the right edge, the browser's
      // scroll-into-view behavior for the composition textarea can set
      // scrollLeft on the viewport / terminal element, causing the
      // entire terminal content to drift left.
      const preventHScroll = () => {
        const vp = terminal.element?.querySelector('.xterm-viewport') as HTMLElement;
        if (vp && vp.scrollLeft !== 0) vp.scrollLeft = 0;
        const xt = terminal.element as HTMLElement;
        if (xt && xt.scrollLeft !== 0) xt.scrollLeft = 0;
      };
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
        xtermViewport.addEventListener('scroll', preventHScroll, { passive: true });
        cleanupFns.push(() => xtermViewport.removeEventListener('scroll', preventHScroll));
      }
      (terminal.element as HTMLElement).addEventListener('scroll', preventHScroll, { passive: true });
      cleanupFns.push(() => (terminal.element as HTMLElement).removeEventListener('scroll', preventHScroll));

      // Also reset scrollLeft after IME composition ends — the browser
      // may set it during composition without firing a scroll event
      if (textareaEl) {
        textareaEl.addEventListener('compositionend', () => {
          requestAnimationFrame(preventHScroll);
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
          // Prompt will move to a new line after Enter
          hasUserPosition = false;
        }

        // Save textarea position from user input.  After a short delay
        // the PTY echo will have moved the cursor and xterm.js will have
        // repositioned the textarea at the correct input-line location.
        // This position is used when the next composition starts to lock
        // the textarea via CSS .ime-locked, preventing IME jumps.
        if (textareaEl && !isComposing && data.length <= 2) {
          setTimeout(() => {
            if (disposed || !textareaEl || isComposing) return;
            saveTextPosition(textareaEl.style.left, textareaEl.style.top);
          }, 50);
        }
        const isBracketedPaste = data.startsWith('\x1b[200~');
        if (isBracketedPaste) {
          chunkedSend(data);
        } else if (data.length > 1 && /[\r\n]/.test(data)) {
          // ConPTY may not forward bracketed paste mode, so manually wrap
          // to prevent the shell from executing each line as a command
          const sanitized = data.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
          const wrapped = `\x1b[200~${sanitized}\x1b[201~`;
          chunkedSend(wrapped);
        } else {
          onOutputRef.current(terminalId, data);
        }
      });

      // Autocomplete: update suggestions on keypress
      terminal.onKey(() => {
        setTimeout(() => {
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
              // Paste file paths wrapped in quotes
              const text = paths.map(p => `"${p}"`).join(' ');
              onOutputRef.current(terminalId, text);
            } else {
              // Fallback: read as plain text
              navigator.clipboard.readText().then((text) => {
                if (text) {
                  const trimmed = text.trim();
                  // Detect single Windows file path in text — wrap in quotes
                  if (/^[A-Za-z]:[\\/]/.test(trimmed) && !trimmed.includes('\n')) {
                    onOutputRef.current(terminalId, `"${trimmed.replace(/"/g, '\\"')}"`);
                  } else {
                    terminal.paste(text);
                  }
                }
              }).catch(() => {});
            }
          }).catch(() => {
            // Fallback: read as plain text
            navigator.clipboard.readText().then((text) => {
              if (text) {
                terminal.paste(text);
              }
            }).catch(() => {});
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

      // Update saved textarea position on click — the user clicked at a
      // specific cursor location, so the textarea will be repositioned
      // there by xterm.js after the click is processed.
      const handleClickForPosition = () => {
        if (textareaEl && !isComposing) {
          setTimeout(() => {
            if (disposed || !textareaEl) return;
            saveTextPosition(textareaEl.style.left, textareaEl.style.top);
          }, 50);
        }
      };
      xtermEl.addEventListener('click', handleClickForPosition);
      cleanupFns.push(() => xtermEl.removeEventListener('click', handleClickForPosition));

      const handleContextMenu = (e: MouseEvent) => {
        e.preventDefault();
        const settings = getAppSettings();
        if (settings.rightClickPaste && !terminal.hasSelection()) {
          navigator.clipboard.readText().then((text) => {
            if (text) {
              terminal.paste(text);
              terminal.focus();
            }
          }).catch(() => {});
          return;
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

      // Throttle + trailing resize to prevent ConPTY reflow corruption.
      // Leading edge: immediate resize on first event.
      // During drag: at most one resize per 150ms (~7/s) — manageable for ConPTY.
      // Trailing edge: guaranteed final resize 150ms after last event.
      // lastCols/lastRows are seeded from the initial fit() above so the first
      // ResizeObserver callback can skip a redundant PTY resize.
      let lastResizeTime = Date.now();
      let lastCols = initCols;
      let lastRows = initRows;
      let trailingTimer: ReturnType<typeof setTimeout> | null = null;
      const RESIZE_THROTTLE_MS = 150;

      // Custom fit that doesn't subtract scrollbar width — the native
      // scrollbar is hidden via CSS (overflow-y: hidden), so FitAddon's
      // default subtraction of ~15px wastes ~2 terminal columns.
      const doFit = () => {
        if (!terminal.element || !terminal.element.parentElement) return;
        const core = (terminal as any)._core;
        const dims = core._renderService.dimensions;
        if (!dims?.css?.cell?.width || !dims?.css?.cell?.height) return;
        const parentStyle = window.getComputedStyle(terminal.element.parentElement);
        const parentW = Math.max(0, parseInt(parentStyle.getPropertyValue('width')));
        const parentH = parseInt(parentStyle.getPropertyValue('height'));
        const elStyle = window.getComputedStyle(terminal.element);
        const padH = parseInt(elStyle.getPropertyValue('padding-left'))
                    + parseInt(elStyle.getPropertyValue('padding-right'));
        const padV = parseInt(elStyle.getPropertyValue('padding-top'))
                    + parseInt(elStyle.getPropertyValue('padding-bottom'));
        const cols = Math.max(2, Math.floor((parentW - padH) / dims.css.cell.width));
        const rows = Math.max(1, Math.floor((parentH - padV) / dims.css.cell.height));
        if (terminal.rows !== rows || terminal.cols !== cols) {
          core._renderService.clear();
          terminal.resize(cols, rows);
        }
      };

      const doResize = () => {
        if (disposed) return;
        try {
          doFit();
        } catch {
          return;
        }
        const { rows, cols } = terminal;
        if (cols <= 0 || rows <= 0) return;
        if (cols === lastCols && rows === lastRows) return;
        lastCols = cols;
        lastRows = rows;
        resizeTerminal(terminalId, rows, cols).catch(() => {});
      };

      const resizeObserver = new ResizeObserver(() => {
        if (disposed) return;
        const now = Date.now();
        if (now - lastResizeTime >= RESIZE_THROTTLE_MS) {
          lastResizeTime = now;
          doResize();
        }
        if (trailingTimer) clearTimeout(trailingTimer);
        trailingTimer = setTimeout(() => {
          trailingTimer = null;
          lastResizeTime = Date.now();
          doResize();
        }, RESIZE_THROTTLE_MS);
      });
      resizeObserver.observe(terminalRef.current!);
      cleanupFns.push(() => {
        resizeObserver.disconnect();
        if (trailingTimer) clearTimeout(trailingTimer);
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
      removeImeLock();
      cleanupFns.forEach(fn => fn());
      xtermRef.current?.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, [terminalId]);

  // Focus and re-fit terminal when tab becomes active
  useEffect(() => {
    if (isActive && xtermRef.current) {
      xtermRef.current.focus();
      requestAnimationFrame(() => {
        const terminal = xtermRef.current;
        if (!terminal?.element?.parentElement) return;
        const core = (terminal as any)._core;
        const dims = core._renderService.dimensions;
        if (!dims?.css?.cell?.width || !dims?.css?.cell?.height) return;
        const parentStyle = window.getComputedStyle(terminal.element.parentElement);
        const parentW = Math.max(0, parseInt(parentStyle.getPropertyValue('width')));
        const parentH = parseInt(parentStyle.getPropertyValue('height'));
        const elStyle = window.getComputedStyle(terminal.element);
        const padH = parseInt(elStyle.getPropertyValue('padding-left'))
                    + parseInt(elStyle.getPropertyValue('padding-right'));
        const padV = parseInt(elStyle.getPropertyValue('padding-top'))
                    + parseInt(elStyle.getPropertyValue('padding-bottom'));
        const cols = Math.max(2, Math.floor((parentW - padH) / dims.css.cell.width));
        const rows = Math.max(1, Math.floor((parentH - padV) / dims.css.cell.height));
        if (terminal.rows !== rows || terminal.cols !== cols) {
          core._renderService.clear();
          terminal.resize(cols, rows);
          resizeTerminal(terminalId, rows, cols).catch(() => {});
        }
      });
    }
  }, [isActive, terminalId]);

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
    } else {
      navigator.clipboard.readText().then((text) => {
        if (text) {
          terminal.paste(text);
          terminal.focus();
        }
      }).catch(() => {});
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
        if (!isActiveRef.current) return;
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
      if (!paths || !isActiveRef.current) return;
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
    </div>
  );
};
