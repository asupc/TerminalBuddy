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
