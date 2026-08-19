import { useEffect, useState } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { getAppSettings } from '../../../utils/settings';
import { useAppStore } from '../../../stores/appStore';
import {
  TERMINAL_PANEL_RESIZE_EVENT,
  TERMINAL_RESIZE_EVENT,
  type TerminalResizeDetail,
} from '../../../utils/terminalResizeEvent';
import { resolveSplitFontSize } from '../instance-utils';
import { forceFitOf } from '../terminal-helpers';

export interface UsePtyResizeOptions {
  terminalRef: React.RefObject<HTMLDivElement | null>;
  xtermRef: React.MutableRefObject<Terminal | null>;
  fitAddonRef: React.MutableRefObject<FitAddon | null>;
  visibleRef: React.MutableRefObject<boolean>;
  pendingWebTakeoverRecoveryRef: React.MutableRefObject<boolean>;
  terminalId: string;
  isActive?: boolean;
  visible: boolean;
  splitMode: 'off' | '2x1' | '2x2';
  windowMode: string;
}

/**
 * PTY 尺寸同步：可见性切换 fit、分屏布局变更修复、字号跟随设置、
 * F11 windowMode 备份 fit。全部经由 xterm 上挂载的 _tbForceFit 私有接口。
 */
export function usePtyResize(opts: UsePtyResizeOptions) {
  const [fontSizeSettings, setFontSizeSettings] = useState(() => {
    const s = getAppSettings();
    return {
      terminalFontSizeOff: s.terminalFontSizeOff,
      terminalFontSize2x1: s.terminalFontSize2x1,
      terminalFontSize2x2: s.terminalFontSize2x2,
    };
  });

  // When tab becomes visible (isActive changes to true), force a fit to ensure
  // correct dimensions. This mirrors VS Code's setVisible() which flushes pending
  // resizes and re-evaluates dimensions on visibility change.
  useEffect(() => {
    if (!opts.visible) return;
    // Use double rAF to ensure the CSS visibility transition has completed
    // and layout is stable before measuring
    let raf1: number;
    let raf2: number;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        const term = opts.xtermRef.current;
        if (!term) return;
        const forceFit = forceFitOf(term);
        if (forceFit) {
          const recoverFromWebTakeover = opts.pendingWebTakeoverRecoveryRef.current;
          const fitted = forceFit(recoverFromWebTakeover, recoverFromWebTakeover);
          if (recoverFromWebTakeover) {
            opts.pendingWebTakeoverRecoveryRef.current = !fitted;
          }
        }
        try {
          if (term.rows > 0) term.refresh(0, term.rows - 1);
        } catch { /* renderer may be disposing */ }
        if (opts.isActive) term.focus();
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [opts.isActive, opts.visible]);

  // Navigation dividers are deliberate layout changes. Force-fit active TUIs
  // while dragging, but keep focus on the divider instead of stealing it back.
  useEffect(() => {
    let resizeRaf = 0;
    const onPanelResize = () => {
      if (resizeRaf) return;
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = 0;
        if (!opts.visibleRef.current) return;
        const term = opts.xtermRef.current;
        if (!term) return;
        const forceFit = forceFitOf(term);
        if (forceFit) forceFit(true);
        try { term.refresh(0, term.rows - 1); } catch { /* renderer may be disposing */ }
      });
    };
    window.addEventListener(TERMINAL_PANEL_RESIZE_EVENT, onPanelResize);
    return () => {
      window.removeEventListener(TERMINAL_PANEL_RESIZE_EVENT, onPanelResize);
      cancelAnimationFrame(resizeRaf);
    };
  }, [opts.terminalId]);

  // Split-screen layout changes (enter/exit/2x1<->2x2) must force a resize even
  // when a TUI (vim/claude code) is running, so the program redraws via SIGWINCH.
  // Incidental resizes still respect the alt-buffer guard inside doFit.
  useEffect(() => {
    let raf1 = 0;
    let raf2 = 0;
    let repairTimers: ReturnType<typeof setTimeout>[] = [];
    const clearPendingRepair = () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      raf1 = 0;
      raf2 = 0;
      repairTimers.forEach(timer => clearTimeout(timer));
      repairTimers = [];
    };
    const isCurrentLayout = (detail: TerminalResizeDetail) => {
      const state = useAppStore.getState();
      if (detail.layoutVersion !== state.terminalLayoutVersion) return false;
      if (detail.splitMode !== state.splitMode || detail.windowMode !== state.windowMode) return false;
      if (state.splitMode !== 'off' && !state.splitSlots.some(slot => slot.sessionId === opts.terminalId)) return false;
      return true;
    };
    const runLayoutRepair = (detail: TerminalResizeDetail, redeclarePty = false) => {
      if (!opts.visibleRef.current || !isCurrentLayout(detail)) return;
      const term = opts.xtermRef.current;
      if (!term) return;
      const forceFit = forceFitOf(term);
      if (forceFit) forceFit(true, redeclarePty);
      try { term.refresh(0, term.rows - 1); } catch { /* renderer may be disposing */ }
      // Only the focused pane should steal keyboard focus on a layout change.
      if (useAppStore.getState().activeSessionId === opts.terminalId) term.focus();
    };
    const onSplitResize = (e: Event) => {
      const detail = (e as CustomEvent<TerminalResizeDetail>).detail;
      if (!detail?.terminalIds?.includes(opts.terminalId) || !isCurrentLayout(detail)) return;
      clearPendingRepair();
      raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => {
          runLayoutRepair(detail);
          repairTimers = [80, 220].map((delay, index, delays) =>
            setTimeout(() => runLayoutRepair(detail, index === delays.length - 1), delay)
          );
        });
      });
    };
    window.addEventListener(TERMINAL_RESIZE_EVENT, onSplitResize);
    return () => {
      window.removeEventListener(TERMINAL_RESIZE_EVENT, onSplitResize);
      clearPendingRepair();
    };
  }, [opts.terminalId]);

  // 监听用户在设置面板改了终端字号，同步到本地 fontSizeSettings 以驱动下方
  // splitMode effect 重算。空依赖：mount 时挂一次，unmount 时解绑。
  useEffect(() => {
    const sync = () => {
      const s = getAppSettings();
      setFontSizeSettings({
        terminalFontSizeOff: s.terminalFontSizeOff,
        terminalFontSize2x1: s.terminalFontSize2x1,
        terminalFontSize2x2: s.terminalFontSize2x2,
      });
    };
    window.addEventListener('app-settings-changed', sync);
    return () => window.removeEventListener('app-settings-changed', sync);
  }, []);

  // 分屏/单屏字号跟随设置：splitMode 切换或用户在设置面板改值都会重新评估。
  // 这里只改字号,不立即 fit；TerminalPanel 会在布局稳定后派发带版本号的
  // TERMINAL_RESIZE_EVENT，避免快速连点时把 2x1/2x2/off 的中间尺寸同步给 PTY。
  useEffect(() => {
    if (!opts.visible) return;
    const term = opts.xtermRef.current;
    if (!term) return;
    const newSize = resolveSplitFontSize(opts.splitMode, fontSizeSettings);
    if (term.options.fontSize === newSize) return;
    term.options.fontSize = newSize;
  }, [
    opts.splitMode,
    opts.visible,
    fontSizeSettings.terminalFontSizeOff,
    fontSizeSettings.terminalFontSize2x1,
    fontSizeSettings.terminalFontSize2x2,
  ]);

  // F11 切换 windowMode（panels-hidden）时，.terminal-content 宽度突变，grid 重排
  // 需要时间落定。这里直接订阅 windowMode 再补一次 forceFit，与 TerminalPanel 派发
  // 的 tb-split-resize 互为备份——任意一条路径被 ResizeObserver 卡住时另一条仍能
  // 触发 fit。
  useEffect(() => {
    const term = opts.xtermRef.current;
    if (!term) return;
    const forceFit = forceFitOf(term);
    if (!forceFit) return;
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
  }, [opts.windowMode]);
}
