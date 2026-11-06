import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown, RefreshCw, Search, X } from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { mobileAiIndicator, mobileAiStatus } from '../../services/mobileAi';
import { isAppHotkeyEvent } from '../../services/hotkeys';
import { useAppStore } from '../../stores/appStore';
import { APP_OPACITY_PREVIEW_EVENT, getAppOpacity, getAppSettings, getEffectiveThemeSkin, type AppOpacityPreviewDetail } from '../../utils/settings';
import { normalizeAnsiForLightBackground, resolveTerminalColors } from '../../utils/terminalTheme';
import { getIndicatorClassName, getIndicatorColor } from '../../utils/claudeIndicator';
import { installTerminalMouseGuard } from '../../utils/terminalMouse';
import { installBrowserClipboard } from '../terminal/browser-clipboard';
import { resolveSplitFontSize } from '../terminal/instance-utils';
import { terminalAppearance, toXtermCanvasTheme } from '../terminal/terminal-appearance';
import '@xterm/xterm/css/xterm.css';
import '../terminal/TerminalInstance.css';
import './MobileChatPage.css';

interface MobileSessionTerminalProps {
  output: string;
  loading: boolean;
  connected: boolean;
  status?: string;
  resultRevision?: number;
  error: string;
  onReconnect: () => void;
  onClose: () => void;
}

/** 使用原生终端的渲染与外观设置展示手机消息，不创建第二个任务。 */
export function MobileSessionTerminal({ output, loading, connected, status, resultRevision, error, onReconnect, onClose }: MobileSessionTerminalProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const redrawRef = useRef<() => void>(() => {});
  const outputRef = useRef(output);
  outputRef.current = output;
  const followingRef = useRef(true);
  const [following, setFollowing] = useState(true);
  const [searchVisible, setSearchVisible] = useState(false);
  const [search, setSearch] = useState('');
  const [settings, setSettings] = useState(getAppSettings);
  const [skin, setSkin] = useState(getEffectiveThemeSkin);
  const colors = resolveTerminalColors(undefined, skin, settings.terminalFollowAppTheme, getAppOpacity(settings, skin));
  const colorsRef = useRef(colors);
  colorsRef.current = colors;

  useEffect(() => {
    const update = () => { setSettings(getAppSettings()); setSkin(getEffectiveThemeSkin()); };
    const preview = (event: Event) => {
      const detail = (event as CustomEvent<AppOpacityPreviewDetail>).detail;
      if (detail) setSettings(current => ({ ...current, appOpacityBySkin: { ...current.appOpacityBySkin, [detail.skin]: detail.opacity } }));
    };
    window.addEventListener('app-settings-changed', update);
    window.addEventListener('app-theme-changed', update);
    window.addEventListener(APP_OPACITY_PREVIEW_EVENT, preview);
    return () => {
      window.removeEventListener('app-settings-changed', update);
      window.removeEventListener('app-theme-changed', update);
      window.removeEventListener(APP_OPACITY_PREVIEW_EVENT, preview);
    };
  }, []);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const terminal = new Terminal({
      ...terminalAppearance(colorsRef.current, resolveSplitFontSize('off', getAppSettings())),
      allowProposedApi: true,
      disableStdin: true,
      reflowCursorLine: true,
    });
    const fit = new FitAddon();
    const searchAddon = new SearchAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(searchAddon);
    terminal.loadAddon(new ClipboardAddon());
    terminal.loadAddon(new Unicode11Addon());
    terminal.unicode.activeVersion = '11';
    terminal.loadAddon(new WebLinksAddon((event, uri) => {
      if ((event.ctrlKey || event.metaKey) && /^https?:\/\//i.test(uri)) window.open(uri, '_blank', 'noopener,noreferrer');
    }));
    terminal.attachCustomKeyEventHandler(event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        if (event.type === 'keydown') { event.preventDefault(); setSearchVisible(true); }
        return false;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c' && terminal.hasSelection()) return false;
      if (event.key === 'F11' || event.key === 'F2' || isAppHotkeyEvent(event)) return false;
      return true;
    });
    terminal.open(host);
    const mouseCleanup = installTerminalMouseGuard(terminal);
    const clipboardCleanup = installBrowserClipboard(terminal, {
      canPaste: () => false, uploadFiles: async () => [], insertFiles: () => {},
      onError: reason => useAppStore.getState().showToast(String(reason), 'error'),
    });
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      terminal.loadAddon(webgl);
    } catch { /* 无 WebGL 时沿用 xterm 的默认渲染器。 */ }
    terminalRef.current = terminal;
    fitRef.current = fit;
    searchRef.current = searchAddon;
    let disposed = false;
    let rendered = '';
    let writing = false;
    let frame = 0;
    let paintedLight = Boolean(colorsRef.current.lightOptimized);

    const redraw = () => {
      if (disposed || writing) return;
      const light = Boolean(colorsRef.current.lightOptimized);
      const next = normalizeAnsiForLightBackground(outputRef.current, light);
      if (next === rendered && light === paintedLight) return;
      const viewport = terminal.buffer.active.viewportY;
      const append = light === paintedLight && next.startsWith(rendered);
      const data = append ? next.slice(rendered.length) : next;
      writing = true;
      if (!append) terminal.reset();
      rendered = next;
      paintedLight = light;
      terminal.write(`${data}\x1b[?25l`, () => {
        if (disposed) return;
        if (followingRef.current) terminal.scrollToBottom();
        else if (!append) terminal.scrollToLine(viewport);
        writing = false;
        redraw();
      });
    };
    redrawRef.current = redraw;
    const fitTerminal = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (disposed || host.clientWidth < 24 || host.clientHeight < 24) return;
        fit.fit();
        if (followingRef.current) terminal.scrollToBottom();
      });
    };
    const scroll = terminal.onScroll(() => {
      if (writing) return;
      const buffer = terminal.buffer.active;
      const atBottom = buffer.viewportY >= buffer.baseY - 1;
      followingRef.current = atBottom;
      setFollowing(atBottom);
    });
    const observer = new ResizeObserver(fitTerminal);
    observer.observe(host);
    fitTerminal();
    void document.fonts.ready.then(() => { if (!disposed) fitTerminal(); });
    redraw();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      scroll.dispose();
      clipboardCleanup();
      mouseCleanup();
      redrawRef.current = () => {};
      terminalRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
      terminal.dispose();
    };
  }, []);

  useEffect(() => { redrawRef.current(); }, [output]);
  useLayoutEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.theme = toXtermCanvasTheme(colors);
    terminal.options.minimumContrastRatio = colors.lightOptimized ? 4.5 : 1;
    terminal.options.fontSize = resolveSplitFontSize('off', settings);
    fitRef.current?.fit();
    redrawRef.current();
  }, [colors, settings]);
  useEffect(() => {
    if (searchVisible && search) searchRef.current?.findNext(search);
    else searchRef.current?.clearDecorations();
  }, [searchVisible, search]);

  const closeSearch = () => { setSearchVisible(false); terminalRef.current?.focus(); };
  const latest = () => { followingRef.current = true; setFollowing(true); terminalRef.current?.scrollToBottom(); };
  const light = error ? 'failed' : mobileAiIndicator(status ?? 'idle', resultRevision);

  return (
    <section className="mobile-terminal-view" aria-label="移动端实时终端" style={{ backgroundColor: colors.background, color: colors.foreground }}>
      {searchVisible && <div className="terminal-search-bar">
        <input className="terminal-search-input" autoFocus value={search} placeholder="搜索终端输出..."
          onChange={event => setSearch(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Escape') closeSearch();
            if (event.key === 'Enter') { event.preventDefault(); if (event.shiftKey) searchRef.current?.findPrevious(search); else searchRef.current?.findNext(search); }
          }} />
        <button className="terminal-search-nav" onClick={() => searchRef.current?.findPrevious(search)} title="上一个">▲</button>
        <button className="terminal-search-nav" onClick={() => searchRef.current?.findNext(search)} title="下一个">▼</button>
        <button className="terminal-search-close" onClick={closeSearch} title="关闭搜索" aria-label="关闭搜索"><X size={14} /></button>
      </div>}
      <div ref={hostRef} className="terminal-instance" />
      {!following && <button className="mobile-terminal-latest" onClick={latest}><ArrowDown size={13} />回到最新</button>}
      <div className="mobile-terminal-status" role="status">
        <span className={`terminal-tab-dot${getIndicatorClassName(light)}`} style={{ background: getIndicatorColor(light) }} />
        <span className="mobile-terminal-status-text" title={error || undefined}>{error || `${loading ? '正在加载' : connected ? '实时同步' : '正在重连'} · ${mobileAiStatus(status ?? 'idle')}`}</span>
        <button onClick={() => setSearchVisible(true)} title="搜索终端输出（Ctrl+F）" aria-label="搜索终端输出"><Search size={13} /></button>
        <button onClick={onReconnect} title="重新同步" aria-label="重新同步移动端会话"><RefreshCw size={13} /></button>
        <button onClick={onClose} title="关闭查看" aria-label="关闭移动端会话查看"><X size={14} /></button>
      </div>
    </section>
  );
}
