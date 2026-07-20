import { useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '@xterm/xterm/css/xterm.css';
import { useTerminalWs } from '../hooks/useTerminalWs';
import type { TerminalLoadingMode } from '../types';
import InputBar from './InputBar';
import { PRESET_THEMES, type ColorTheme } from '../types';

interface Props {
  terminalId: string;
  /** PC 端 Profile.colorTheme 解析得到的主题色；缺省取 dark-default */
  theme?: ColorTheme;
  loadingMode: TerminalLoadingMode;
  onStateChange?: (connected: boolean) => void;
  onExited?: () => void;
}

interface TouchScrollState {
  startX: number;
  startY: number;
  lastY: number;
  lastTime: number;
  velocity: number;
  isVerticalScroll: boolean;
}

/**
 * xterm.js 封装 + 终端 WS。模式移植自旧 web/src/components/TerminalView.tsx：
 * - FitAddon + Unicode11Addon；初始化后立即 fit + 首帧 resize（触发后端回放历史）
 * - requestAnimationFrame 合批输出；初始化前到期的 output 先入缓冲
 * - ResizeObserver 去重发 resize（横屏/地址栏变化）
 * - ConPTY buildNumber 从 UA 解析
 * - 手机触摸拖动桥接到 xterm 自带滚动管线，并补离手惯性
 */
export default function Xterm({ terminalId, theme, loadingMode, onStateChange, onExited }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const pendingRef = useRef<string[]>([]);
  const rafRef = useRef<number | null>(null);
  const bufRef = useRef<string[]>([]);
  const onStateRef = useRef(onStateChange);
  onStateRef.current = onStateChange;
  const onExitedRef = useRef(onExited);
  onExitedRef.current = onExited;

  const flushPending = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (pendingRef.current.length) {
      const combined = pendingRef.current.join('');
      pendingRef.current.length = 0;
      termRef.current?.write(combined);
    }
  }, []);

  const writeOutput = useCallback(
    (data: string) => {
      const term = termRef.current;
      if (!term) {
        bufRef.current.push(data);
        return;
      }
      pendingRef.current.push(data);
      if (rafRef.current == null) {
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = null;
          const combined = pendingRef.current.join('');
          pendingRef.current.length = 0;
          termRef.current?.write(combined);
        });
      }
    },
    [],
  );

  const { sendInput, sendResize } = useTerminalWs(terminalId, {
    onOutput: writeOutput,
    onExited: () => {
      flushPending();
      termRef.current?.writeln('\r\n\n[连接已结束]');
      onExitedRef.current?.();
    },
    onConnected: () => onStateRef.current?.(true),
    onClose: () => onStateRef.current?.(false),
  });

  useEffect(() => {
    if (!containerRef.current) return;

    const ua = (navigator as { userAgentData?: { platform?: string }; userAgent: string });
    const isWindows = /Windows/i.test(ua.userAgentData?.platform || ua.userAgent || '');
    // iPadOS 13+ 在桌面 Safari 上 UA 标自己是 MacIntel，靠多点触控特征识别。
    // iPad Safari 对合成 wheel 事件的 deltaY 解读与 PC 相反，需要对翻号后再派发。
    const isIPad = /iPad/.test(ua.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const touchSign = isIPad ? -1 : 1;
    let buildNumber: number | null = null;
    if (isWindows) {
      const m = ua.userAgent.match(/Build\/(\d+)/);
      if (m) buildNumber = parseInt(m[1], 10);
    }

    const getFontSize = () => (window.innerWidth >= 768 ? 14 : 13);
    const resolved = theme ?? PRESET_THEMES[0];
    const term = new Terminal({
      cursorBlink: false,
      cursorStyle: 'block',
      cursorInactiveStyle: 'outline',
      cursorWidth: 1,
      fontSize: getFontSize(),
      fontFamily: "Cascadia Code, Consolas, 'Courier New', monospace",
      scrollback: 1000,
      minimumContrastRatio: 4.5,
      theme: {
        background: resolved.background,
        foreground: resolved.foreground,
        cursor: '#65d5a5',
        cursorAccent: resolved.background,
        selectionBackground: '#285d49',
      },
      allowProposedApi: true,
      ...(isWindows && buildNumber
        ? { windowsPty: { backend: 'conpty' as const, buildNumber } }
        : isWindows
          ? { windowsPty: { backend: 'conpty' as const, buildNumber: 22000 } }
          : {}),
    });

    const fit = new FitAddon();
    const uni = new Unicode11Addon();
    term.loadAddon(fit);
    term.loadAddon(uni);
    term.unicode.activeVersion = '11';
    const da1Handler = loadingMode === 'vsCode'
      ? term.parser.registerCsiHandler({ final: 'c' }, (params) => {
          if (params.length === 0 || (params.length === 1 && params[0] === 0)) {
            // VS Code's terminal host already answers this startup query. Consuming
            // the forwarded copy prevents xterm's delayed reply prefixing cmd input.
            return true;
          }
          return false;
        })
      : null;
    term.open(containerRef.current);
    fit.fit();
    sendResize(term.cols, term.rows); // 首帧 resize → 触发后端回放历史输出

    let lastFontSize = getFontSize();
    let lastCols = term.cols;
    let lastRows = term.rows;
    const doFit = () => {
      if (!termRef.current || !fitRef.current) return;
      const nextFontSize = getFontSize();
      if (nextFontSize !== lastFontSize) {
        lastFontSize = nextFontSize;
        termRef.current.options.fontSize = nextFontSize;
      }
      fitRef.current.fit();
      if (termRef.current.cols !== lastCols || termRef.current.rows !== lastRows) {
        lastCols = termRef.current.cols;
        lastRows = termRef.current.rows;
        sendResize(lastCols, lastRows);
      }
    };
    const ro = new ResizeObserver(() => doFit());
    ro.observe(containerRef.current);

    term.onData((d) => sendInput(d));

    termRef.current = term;
    fitRef.current = fit;

    // flush 初始化前缓冲的输出
    if (bufRef.current.length) {
      term.write(bufRef.current.join(''));
      bufRef.current.length = 0;
    }

    const viewport = term.element?.querySelector('.xterm-viewport') as HTMLElement | null;
    const scrollable = term.element?.querySelector('.xterm-scrollable-element') as HTMLElement | null;
    const scrollTarget = scrollable ?? viewport ?? term.element;
    if (viewport) viewport.style.touchAction = 'none';
    if (scrollable) scrollable.style.touchAction = 'none';

    // 触屏手指像素 → 合成 wheel 的 deltaY 之前放大，让 xterm 翻译成行滚动时跟上指尖速度。
    // 单帧 deltaY 较小（<16px）时 xterm 默认按行高阈值换算容易丢事件。
    const TOUCH_SCROLL_GAIN = 2.5;
    let touchScroll: TouchScrollState | null = null;
    let momentumFrame: number | null = null;
    const stopMomentum = () => {
      if (momentumFrame != null) {
        cancelAnimationFrame(momentumFrame);
        momentumFrame = null;
      }
    };
    const dispatchWheel = (deltaY: number) => {
      if (!scrollTarget || !Number.isFinite(deltaY) || Math.abs(deltaY) < 0.01) return;
      scrollTarget.dispatchEvent(
        new WheelEvent('wheel', {
          deltaY,
          deltaMode: WheelEvent.DOM_DELTA_PIXEL,
          bubbles: true,
          cancelable: true,
        }),
      );
    };
    const startMomentum = (velocity: number) => {
      stopMomentum();
      if (Math.abs(velocity) < 0.04) return;

      let lastTime = performance.now();
      let currentVelocity = velocity;
      const step = (now: number) => {
        const dt = Math.min(32, now - lastTime);
        lastTime = now;

        dispatchWheel(currentVelocity * dt);
        currentVelocity *= Math.pow(0.92, dt / 16.67);

        if (Math.abs(currentVelocity) > 0.015) {
          momentumFrame = requestAnimationFrame(step);
        } else {
          momentumFrame = null;
        }
      };
      momentumFrame = requestAnimationFrame(step);
    };
    const onTouchStart = (event: TouchEvent) => {
      stopMomentum();
      if (event.touches.length !== 1) {
        touchScroll = null;
        return;
      }
      const touch = event.touches.item(0);
      if (!touch) return;
      const now = performance.now();
      touchScroll = {
        startX: touch.clientX,
        startY: touch.clientY,
        lastY: touch.clientY,
        lastTime: now,
        velocity: 0,
        isVerticalScroll: false,
      };
    };
    const onTouchMove = (event: TouchEvent) => {
      if (!touchScroll || event.touches.length !== 1) return;

      const touch = event.touches.item(0);
      if (!touch) return;
      const totalX = touch.clientX - touchScroll.startX;
      const totalY = touch.clientY - touchScroll.startY;

      if (!touchScroll.isVerticalScroll) {
        const absX = Math.abs(totalX);
        const absY = Math.abs(totalY);
        if (absY < 8 && absX < 8) return;
        if (absX > absY) {
          touchScroll = null;
          return;
        }
        touchScroll.isVerticalScroll = true;
      }

      if (event.cancelable) event.preventDefault();
      const now = performance.now();
      const rawDeltaY = (touch.clientY - touchScroll.lastY) * touchSign;
      const deltaY = rawDeltaY * TOUCH_SCROLL_GAIN;
      const dt = Math.max(1, now - touchScroll.lastTime);
      touchScroll.lastY = touch.clientY;
      touchScroll.lastTime = now;
      touchScroll.velocity = deltaY / dt;
      dispatchWheel(deltaY);
    };
    const onTouchEnd = () => {
      if (touchScroll?.isVerticalScroll) startMomentum(touchScroll.velocity);
      touchScroll = null;
    };
    term.element?.addEventListener('touchstart', onTouchStart, { passive: true });
    term.element?.addEventListener('touchmove', onTouchMove, { passive: false });
    term.element?.addEventListener('touchend', onTouchEnd);
    term.element?.addEventListener('touchcancel', onTouchEnd);

    return () => {
      ro.disconnect();
      stopMomentum();
      term.element?.removeEventListener('touchstart', onTouchStart);
      term.element?.removeEventListener('touchmove', onTouchMove);
      term.element?.removeEventListener('touchend', onTouchEnd);
      term.element?.removeEventListener('touchcancel', onTouchEnd);
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      pendingRef.current = [];
      bufRef.current = [];
      da1Handler?.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [terminalId, loadingMode, sendResize, sendInput, writeOutput]);

  // 地址栏/横屏变化时重新 fit（visualViewport 触发 doFit 经 ResizeObserver）
  useEffect(() => {
    const onResize = () => fitRef.current?.fit();
    window.visualViewport?.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      window.visualViewport?.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, []);

  return (
    <>
      <div ref={containerRef} className="xterm-container" />
      <InputBar onSend={sendInput} />
    </>
  );
}
