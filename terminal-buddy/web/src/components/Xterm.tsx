import { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '@xterm/xterm/css/xterm.css';
import { useTerminalWs } from '../hooks/useTerminalWs';
import type { TerminalLoadingMode } from '../types';
import InputBar from './InputBar';
import { terminalPaste } from '../utils/terminalInput';
import { installTouchKeyboardGuard } from '../utils/terminalKeyboard';
import { installTerminalMouseGuard } from '../../../src/utils/terminalMouse';
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
  lastX: number;
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
  const [inputTerminalId, setInputTerminalId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const pendingRef = useRef<string[]>([]);
  const rafRef = useRef<number | null>(null);
  const bufRef = useRef<string[]>([]);
  const replayingRef = useRef(false);
  const connectionEpochRef = useRef(0);
  const fitViewportRef = useRef<(() => void) | null>(null);
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
      if (!term || replayingRef.current) {
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
    onReplay: (frames) => {
      const term = termRef.current;
      if (!term) return;
      const epoch = connectionEpochRef.current;
      replayingRef.current = true;
      setInputTerminalId(null);
      let index = 0;
      const next = () => {
        if (termRef.current !== term || connectionEpochRef.current !== epoch) return;
        const frame = frames[index++];
        if (frame) {
          // 光标绝对定位、边框和自动换行均按这一段原来的尺寸解释。
          term.resize(frame.cols, frame.rows);
          // resize 会同步清空 xterm 的 write 队列，须等当前回调退出后再推进。
          term.write(frame.data, () => queueMicrotask(next));
          return;
        }
        replayingRef.current = false;
        setInputTerminalId(terminalId);
        fitViewportRef.current?.();
        if (bufRef.current.length) {
          const output = bufRef.current.join('');
          bufRef.current = [];
          writeOutput(output);
        }
      };
      // 排在旧 write 队列之后重置，防止重连前的未完成输出混入新快照。
      term.write('\x1bc', () => queueMicrotask(next));
    },
    onExited: () => {
      setInputTerminalId(null);
      flushPending();
      writeOutput('\r\n\n[连接已结束]\r\n');
      onExitedRef.current?.();
    },
    onConnected: () => {
      connectionEpochRef.current += 1;
      replayingRef.current = false;
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      pendingRef.current = [];
      bufRef.current = [];
      // 旧服务端仍发送 output；同样先清空上次画面，避免历史叠加。
      termRef.current?.write('\x1bc');
      setInputTerminalId(terminalId);
      onStateRef.current?.(true);
    },
    onClose: () => {
      connectionEpochRef.current += 1;
      replayingRef.current = false;
      setInputTerminalId(null);
      onStateRef.current?.(false);
    },
  });

  const sendComposerInput = useCallback((data: string, asText = false): boolean => {
    const term = termRef.current;
    if (!term || replayingRef.current) return false;
    const sent = sendInput(asText ? terminalPaste(data, term.modes.bracketedPasteMode) : data);
    if (sent) term.scrollToBottom();
    return sent;
  }, [sendInput]);

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
    // XTVERSION 的 DCS 回包经 WebSocket 延迟抵达时，可能被 Codex 当作普通输入。
    // 手机端跳过可选的版本探测，避免输入框混入 >|xterm.js(...)。
    const xtVersionHandler = term.parser.registerCsiHandler({ prefix: '>', final: 'q' }, () => true);
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
    const removeMouseGuard = installTerminalMouseGuard(term);
    const removeTouchKeyboardGuard = installTouchKeyboardGuard(term);
    fit.fit();
    sendResize(term.cols, term.rows); // 首帧 resize → 触发后端回放历史输出

    let lastFontSize = getFontSize();
    let lastCols = term.cols;
    let lastRows = term.rows;
    const doFit = () => {
      if (!termRef.current || !fitRef.current || replayingRef.current) return;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect || rect.width < 1 || rect.height < 1) return;
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
    fitViewportRef.current = doFit;
    const ro = new ResizeObserver(() => doFit());
    ro.observe(containerRef.current);

    term.onData((d) => {
      // 历史中的终端能力/光标查询已被回答，回放时不能再注入当前运行的程序。
      if (replayingRef.current) return;
      // 粘贴行尾必须写 CR：ConPTY 会把输入流里的 LF 当成带 Ctrl 修饰的 Enter，
      // 在开启 kitty 键盘协议的 TUI（如 pi）里被编码成 CSI 13;5u（Ctrl+Enter=提交），
      // 导致粘贴内容被逐行提交、或 CSI-u 序列被字面插进消息文本。
      // 与 PC 端 TerminalInstance 的 onData 同步维护。
      if (d.startsWith('\x1b[200~')) {
        const inner = d.slice(6, -5);
        sendInput(inner.includes('\n') ? `\x1b[200~${inner.replace(/\r?\n/g, '\r')}\x1b[201~` : d);
      } else if (d.length > 1 && /[\r\n]/.test(d)) {
        sendInput(`\x1b[200~${d.replace(/\r?\n/g, '\r')}\x1b[201~`);
      } else {
        sendInput(d);
      }
    });

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
    const dispatchWheel = (deltaY: number, clientX: number, clientY: number) => {
      if (!scrollTarget || ![deltaY, clientX, clientY].every(Number.isFinite) || Math.abs(deltaY) < 0.01) return;
      scrollTarget.dispatchEvent(
        new WheelEvent('wheel', {
          deltaY,
          clientX,
          clientY,
          deltaMode: WheelEvent.DOM_DELTA_PIXEL,
          bubbles: true,
          cancelable: true,
        }),
      );
    };
    const startMomentum = (velocity: number, clientX: number, clientY: number) => {
      stopMomentum();
      if (!Number.isFinite(velocity) || Math.abs(velocity) < 0.04) return;

      let lastTime = performance.now();
      let currentVelocity = velocity;
      const step = (now: number) => {
        const dt = Math.min(32, now - lastTime);
        lastTime = now;

        dispatchWheel(currentVelocity * dt, clientX, clientY);
        currentVelocity *= Math.pow(0.92, dt / 16.67);

        if (Math.abs(currentVelocity) > 0.015) {
          momentumFrame = requestAnimationFrame(step);
        } else {
          momentumFrame = null;
        }
      };
      momentumFrame = requestAnimationFrame(step);
    };
    // 触摸只走本桥接，阻止 document 上的 xterm Gesture 再处理同一次滑动和惯性。
    const onTouchStart = (event: TouchEvent) => {
      event.stopPropagation();
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
        lastX: touch.clientX,
        lastY: touch.clientY,
        lastTime: now,
        velocity: 0,
        isVerticalScroll: false,
      };
    };
    const onTouchMove = (event: TouchEvent) => {
      event.stopPropagation();
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
      touchScroll.lastX = touch.clientX;
      touchScroll.lastY = touch.clientY;
      touchScroll.lastTime = now;
      touchScroll.velocity = deltaY / dt;
      dispatchWheel(deltaY, touch.clientX, touch.clientY);
    };
    const onTouchEnd = (event: TouchEvent) => {
      event.stopPropagation();
      if (event.type === 'touchcancel') {
        stopMomentum();
      } else if (touchScroll?.isVerticalScroll) {
        startMomentum(touchScroll.velocity, touchScroll.lastX, touchScroll.lastY);
      }
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
      connectionEpochRef.current += 1;
      replayingRef.current = false;
      fitViewportRef.current = null;
      xtVersionHandler.dispose();
      da1Handler?.dispose();
      removeMouseGuard();
      removeTouchKeyboardGuard();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [terminalId, loadingMode, sendResize, sendInput, writeOutput]);

  // 地址栏/横屏变化时重新 fit（visualViewport 触发 doFit 经 ResizeObserver）
  useEffect(() => {
    const onResize = () => fitViewportRef.current?.();
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
      <InputBar key={terminalId} connected={inputTerminalId === terminalId} onSend={sendComposerInput} onText={(text) => sendComposerInput(text, true)} />
    </>
  );
}
