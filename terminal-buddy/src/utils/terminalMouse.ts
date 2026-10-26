import type { Terminal } from '@xterm/xterm';

/** pi 的 OSC 0 标题形如「π - 目录」或「π - 会话 - 目录」。 */
const PI_TITLE = /^\s*(?:π|pi)(?:\s*[-–—·|/]|\s*$)/iu;

/** 这些鼠标协议会向应用上报滚轮；其余协议下 xterm 会把滚轮转成上下方向键。 */
function reportsWheel(mode: 'none' | 'x10' | 'vt200' | 'drag' | 'any'): boolean {
  return mode === 'vt200' || mode === 'drag' || mode === 'any';
}

/**
 * pi 在 Windows ConPTY 下有个启动时序问题：鼠标模式（?1000h/?1002h/?1003h/?1006h）
 * 在 stdin 进入 raw mode 之前就写入，会被 ConPTY 吞掉，xterm 以为应用没开鼠标，
 * 于是把滚轮翻译成 ↑/↓（pi 会当成输入框历史）。此时直接按应用期望补发 SGR
 * 滚轮报文，让 pi 自己的滚动视图处理。
 *
 * 仅在标题为 pi、处于备用屏、且应用未成功启用滚轮上报时接管；其余情况完全
 * 交还 xterm 默认行为。
 */
export function installPiWheelFallback(
  terminal: Terminal,
  send: (data: string) => void,
  isReadOnly: () => boolean = () => false
): () => void {
  let title = '';
  const titleDisposable = terminal.onTitleChange((nextTitle) => {
    title = nextTitle;
  });

  const wheelCell = (event: WheelEvent): { col: number; row: number } | null => {
    const screen = terminal.element?.querySelector('.xterm-screen') as HTMLElement | null;
    if (!screen || terminal.cols < 1 || terminal.rows < 1) return null;
    const rect = screen.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    const col = Math.floor((event.clientX - rect.left) / (rect.width / terminal.cols));
    const row = Math.floor((event.clientY - rect.top) / (rect.height / terminal.rows));
    if (!Number.isFinite(col) || !Number.isFinite(row)) return null;
    return {
      col: Math.min(Math.max(col, 0), terminal.cols - 1),
      row: Math.min(Math.max(row, 0), terminal.rows - 1),
    };
  };

  terminal.attachCustomWheelEventHandler((event) => {
    if (isReadOnly()) {
      event.preventDefault();
      event.stopPropagation();
      return false;
    }
    if (!PI_TITLE.test(title)) return true;
    if (terminal.buffer.active.type !== 'alternate') return true;
    if (reportsWheel(terminal.modes.mouseTrackingMode)) return true;
    if (event.deltaY === 0) return true;

    const cell = wheelCell(event);
    if (!cell) return true;

    // SGR 鼠标：button 64/65 = 滚轮上/下；4/8/16 为 Shift/Alt/Ctrl 修饰位。
    const button = 64
      | (event.shiftKey ? 4 : 0)
      | (event.altKey ? 8 : 0)
      | (event.ctrlKey ? 16 : 0)
      | (event.deltaY < 0 ? 0 : 1);
    send(`\x1b[<${button};${cell.col + 1};${cell.row + 1}M`);
    event.preventDefault();
    event.stopPropagation();
    return false;
  });

  return () => {
    titleDisposable.dispose();
    // xterm 没有提供移除自定义滚轮回调的接口，恢复为全部放行。
    terminal.attachCustomWheelEventHandler(() => true);
  };
}

interface MousePosition {
  clientX: number;
  clientY: number;
  type?: string;
}

interface MouseReport {
  col: number;
  row: number;
  x: number;
  y: number;
}

interface MouseCoordsService {
  getMouseReportCoords(event: MousePosition, element: HTMLElement): MouseReport | undefined;
}

interface TerminalMouseTarget {
  element: HTMLElement | undefined;
}

/** 兼容 xterm 6 的触摸惯性事件，并在编码前阻止无效鼠标坐标进入 PTY。 */
export function installTerminalMouseGuard(terminal: TerminalMouseTarget): () => void {
  const element = terminal.element;
  // xterm 尚未提供公开的鼠标坐标校验接口；将内部 API 的兼容处理集中在这里。
  const service = (terminal as TerminalMouseTarget & {
    _core?: { _mouseCoordsService?: MouseCoordsService };
  })._core?._mouseCoordsService;
  if (!element || !service) return () => {};

  let lastTouch: MousePosition | null = null;
  const rememberTouch = (event: TouchEvent) => {
    if (event.type === 'touchcancel' || event.touches.length > 1) {
      lastTouch = null;
      return;
    }
    const touch = event.touches.item(0) ?? event.changedTouches.item(0);
    lastTouch = touch && Number.isFinite(touch.clientX) && Number.isFinite(touch.clientY)
      ? { clientX: touch.clientX, clientY: touch.clientY }
      : null;
  };

  const originalGetCoords = service.getMouseReportCoords;
  const guardedGetCoords: MouseCoordsService['getMouseReportCoords'] = (event, screenElement) => {
    let position = event;
    if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) {
      // xterm 的惯性事件只带 translationX/Y；沿用离手位置，避免生成 CSI <…;NaN;NaNM。
      if (event.type !== '-xterm-gesturechange' || !lastTouch) return undefined;
      position = lastTouch;
    }
    const report = originalGetCoords.call(service, position, screenElement);
    if (!report || ![report.col, report.row, report.x, report.y].every(Number.isFinite)) {
      return undefined;
    }
    return report;
  };
  service.getMouseReportCoords = guardedGetCoords;

  const touchEvents = ['touchstart', 'touchmove', 'touchend', 'touchcancel'] as const;
  for (const type of touchEvents) {
    element.addEventListener(type, rememberTouch, { capture: true, passive: true });
  }

  return () => {
    for (const type of touchEvents) {
      element.removeEventListener(type, rememberTouch, true);
    }
    if (service.getMouseReportCoords === guardedGetCoords) {
      service.getMouseReportCoords = originalGetCoords;
    }
  };
}
