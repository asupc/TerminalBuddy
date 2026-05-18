import { FC, useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { resizeTerminal, openPath, readClipboardFilePaths, onTerminalOutput, drainTerminalOutput } from '../services/tauri';
import { getAppSettings } from '../utils/settings';
import { useAppStore } from '../stores/appStore';
import { getAllSuggestions, addCommandToHistory, type SuggestionItem } from '../data/commandTemplates';
import '@xterm/xterm/css/xterm.css';
import './TerminalInstance.css';

// Match CMD/PowerShell prompt line ending with >
const PROMPT_REGEX = /(?:PS )?([A-Za-z]:\\[^\s>]*)>/g;

interface TerminalInstanceProps {
  terminalId: string;
  onOutput: (data: string) => void;
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
    // Unified textarea position lock — prevents cursor/IME from following
    // TUI cursor movements during rapid output or IME composition.
    // xterm.js repositions .xterm-helper-textarea on every render to match
    // the canvas cursor. When Claude Code rapidly updates status lines, the
    // cursor alternates between status area and input area across frames,
    // causing the textarea (and IME candidate window) to jump.
    let isComposing = false;
    let isOutputLocked = false;
    let savedLeft = '';
    let savedTop = '';
    let lockObserver: MutationObserver | null = null;
    let unlockTimer: ReturnType<typeof setTimeout> | null = null;
    let textareaEl: HTMLTextAreaElement | null = null;
    let compViewEl: HTMLElement | null = null;

    const handleOutput = (output: string) => {
      if (disposed || !output) return;
      if (xtermRef.current) {
        // Batch writes via requestAnimationFrame to reduce cursor position
        // thrashing during rapid TUI updates (e.g., spinners, status lines)
        pendingChunks.push(output);
        // Lock textarea position during rapid output to prevent cursor/IME
        // from following TUI cursor movements (e.g., spinners, status lines).
        // Save position at start of burst; restore it when xterm.js moves it.
        // Only save if textarea has been positioned by xterm.js (left/top are
        // non-empty pixel values), otherwise lock would anchor to (0,0).
        if (!isOutputLocked && !isComposing && textareaEl) {
          const left = textareaEl.style.left;
          const top = textareaEl.style.top;
          if (left && top) {
            savedLeft = left;
            savedTop = top;
          }
        }
        isOutputLocked = true;
        if (textareaEl && !lockObserver) {
          lockObserver = new MutationObserver(() => {
            if (!isComposing && !isOutputLocked) return;
            if (textareaEl!.style.left !== savedLeft || textareaEl!.style.top !== savedTop) {
              textareaEl!.style.left = savedLeft;
              textareaEl!.style.top = savedTop;
            }
            if (compViewEl && (compViewEl.style.left !== savedLeft || compViewEl.style.top !== savedTop)) {
              compViewEl.style.left = savedLeft;
              compViewEl.style.top = savedTop;
            }
          });
          lockObserver.observe(textareaEl, { attributes: true, attributeFilter: ['style'] });
          if (compViewEl) {
            lockObserver.observe(compViewEl, { attributes: true, attributeFilter: ['style'] });
          }
        }
        if (unlockTimer) clearTimeout(unlockTimer);
        unlockTimer = setTimeout(() => {
          isOutputLocked = false;
          if (!isComposing) {
            lockObserver?.disconnect();
            lockObserver = null;
          }
        }, 150);
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

      // Detect directory from prompt lines for active session
      const state = useAppStore.getState();
      if (state.activeSessionId === terminalId) {
        const matches = [...output.matchAll(PROMPT_REGEX)];
        if (matches.length > 0) {
          const detectedPath = matches[matches.length - 1][1];
          if (detectedPath.length >= 3 && detectedPath.includes('\\')) {
            state.setCurrentDirectory(detectedPath);
            state.setSessionDirectory(terminalId, detectedPath);
          }
        }
      }
    };

    const initTerminal = async () => {
      // Wait for fonts to be fully loaded so xterm measures correct cell dimensions
      await document.fonts.ready;

      if (disposed || !terminalRef.current) return;

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

      // Fix: prevent IME composition from causing horizontal content shift
      // When the cursor is near the right edge, the browser's scroll-into-view
      // behavior for the composition textarea can set scrollLeft on the viewport,
      // causing the entire terminal content to drift left.
      const preventHScroll = () => {
        const vp = terminal.element?.querySelector('.xterm-viewport') as HTMLElement;
        if (vp && vp.scrollLeft !== 0) vp.scrollLeft = 0;
        const xt = terminal.element as HTMLElement;
        if (xt && xt.scrollLeft !== 0) xt.scrollLeft = 0;
      };
      const xtermViewport = terminal.element!.querySelector('.xterm-viewport') as HTMLElement;
      if (xtermViewport) {
        xtermViewport.addEventListener('scroll', preventHScroll, { passive: true });
        cleanupFns.push(() => xtermViewport.removeEventListener('scroll', preventHScroll));
      }
      (terminal.element as HTMLElement).addEventListener('scroll', preventHScroll, { passive: true });
      cleanupFns.push(() => (terminal.element as HTMLElement).removeEventListener('scroll', preventHScroll));

      // Also reset scrollLeft after IME composition ends, as the browser may
      // set it during composition without firing a scroll event
      textareaEl = terminal.element!.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement;
      compViewEl = terminal.element!.querySelector('.xterm-composition-view') as HTMLElement | null;
      const xtermTextarea = textareaEl;
      if (xtermTextarea) {
        xtermTextarea.addEventListener('compositionend', () => {
          requestAnimationFrame(preventHScroll);
        });

        // IME composition: wait one frame for xterm.js to position the
        // textarea at the cursor, then save that position and lock.
        // If we save immediately (before xterm.js renders), we may lock
        // to a stale position causing the IME window to appear elsewhere.
        xtermTextarea.addEventListener('compositionstart', () => {
          isComposing = true;
          requestAnimationFrame(() => {
            if (!isComposing) return;
            savedLeft = xtermTextarea.style.left;
            savedTop = xtermTextarea.style.top;
            if (textareaEl && !lockObserver) {
              lockObserver = new MutationObserver(() => {
                if (!isComposing && !isOutputLocked) return;
                if (textareaEl!.style.left !== savedLeft || textareaEl!.style.top !== savedTop) {
                  textareaEl!.style.left = savedLeft;
                  textareaEl!.style.top = savedTop;
                }
                if (compViewEl && (compViewEl.style.left !== savedLeft || compViewEl.style.top !== savedTop)) {
                  compViewEl.style.left = savedLeft;
                  compViewEl.style.top = savedTop;
                }
              });
              lockObserver.observe(textareaEl, { attributes: true, attributeFilter: ['style'] });
              if (compViewEl) {
                lockObserver.observe(compViewEl, { attributes: true, attributeFilter: ['style'] });
              }
            }
          });
        });

        const endCompositionLock = () => {
          isComposing = false;
          if (!isOutputLocked) {
            lockObserver?.disconnect();
            lockObserver = null;
          }
        };
        xtermTextarea.addEventListener('compositionend', endCompositionLock);
        cleanupFns.push(endCompositionLock);
      }

      // Double-fit: immediate + delayed to ensure correct measurements after layout
      fitAddon.fit();
      requestAnimationFrame(() => {
        if (disposed) return;
        fitAddon.fit();
        const { rows, cols } = terminal;
        resizeTerminal(terminalId, rows, cols).catch(() => {});
      });

      xtermRef.current = terminal;
      // Flush buffered output that arrived before xterm was ready
      if (outputBuffer.length > 0) {
        terminal.write(outputBuffer.join(''));
        outputBuffer.length = 0;
      }
      fitAddonRef.current = fitAddon;

      // Auto-focus after initialization
      terminal.focus();

      terminal.onData((data) => {
        // Track command history on Enter
        if (data === '\r' || data === '\n') {
          const buffer = terminal.buffer.active;
          const absY = buffer.baseY + buffer.cursorY;
          const line = buffer.getLine(absY);
          if (line) {
            const text = line.translateToString(true, 0, buffer.cursorX);
            const promptIdx = text.lastIndexOf('>');
            const cmd = promptIdx >= 0 ? text.substring(promptIdx + 1).trim() : text.trim();
            if (cmd) addCommandToHistory(cmd).catch(() => {});
          }
          updateAutocomplete(null);
        }
        onOutputRef.current(data);
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
              if (completion) onOutputRef.current(completion);
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
              if (completion) onOutputRef.current(completion);
            }
            updateAutocomplete(null);
            return;
          }
        }
        if (e.key === 'Enter' && (e.ctrlKey || e.shiftKey)) {
          e.preventDefault();
          e.stopPropagation();
          onOutputRef.current('\n');
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
              onOutputRef.current(text);
            } else {
              // Fallback: read as plain text
              navigator.clipboard.readText().then((text) => {
                if (text) {
                  const trimmed = text.trim();
                  // Detect single Windows file path in text — wrap in quotes
                  if (/^[A-Za-z]:[\\/]/.test(trimmed) && !trimmed.includes('\n')) {
                    onOutputRef.current(`"${trimmed.replace(/"/g, '\\"')}"`);
                  } else {
                    onOutputRef.current(text);
                  }
                }
              }).catch(() => {});
            }
          }).catch(() => {
            // Fallback: read as plain text
            navigator.clipboard.readText().then((text) => {
              if (text) onOutputRef.current(text);
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
      const handleContextMenu = (e: MouseEvent) => {
        e.preventDefault();
        const settings = getAppSettings();
        if (settings.rightClickPaste && !terminal.hasSelection()) {
          navigator.clipboard.readText().then((text) => {
            if (text) {
              onOutputRef.current(text);
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

      // Window resize
      const handleResize = () => {
        fitAddon.fit();
        const { rows, cols } = terminal;
        resizeTerminal(terminalId, rows, cols).catch(() => {});
      };
      window.addEventListener('resize', handleResize);
      cleanupFns.push(() => window.removeEventListener('resize', handleResize));
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
      if (pendingRaf) {
        cancelAnimationFrame(pendingRaf);
        pendingRaf = null;
      }
      cleanupFns.forEach(fn => fn());
      xtermRef.current?.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, [terminalId]);

  // Focus terminal when tab becomes active
  useEffect(() => {
    if (isActive && xtermRef.current) {
      xtermRef.current.focus();
    }
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
    } else {
      navigator.clipboard.readText().then((text) => {
        if (text) {
          onOutputRef.current(text);
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

  return (
    <div ref={terminalRef} className="terminal-instance">
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
                  if (completion) onOutputRef.current(completion);
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
    </div>
  );
};
