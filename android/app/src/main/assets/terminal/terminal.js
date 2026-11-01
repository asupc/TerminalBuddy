/* 本地渲染层不持有登录令牌，不发网络请求。通信由 Android 原生层负责。 */
(() => {
  'use strict';
  // 与桌面端的鼠标坐标保护保持一致，在 xterm 编码前拦截无效触摸坐标。
  function installMouseGuard(terminal) {
    const element = terminal.element;
    const service = terminal._core?._mouseCoordsService;
    if (!element || !service) return () => {};

    let lastTouch = null;
    function rememberTouch(event) {
      if (event.type === 'touchcancel' || event.touches.length > 1) {
        lastTouch = null;
        return;
      }
      const touch = event.touches.item(0) || event.changedTouches.item(0);
      lastTouch = touch && Number.isFinite(touch.clientX) && Number.isFinite(touch.clientY)
        ? { clientX: touch.clientX, clientY: touch.clientY }
        : null;
    }

    const originalGetCoords = service.getMouseReportCoords;
    function guardedGetCoords(event, screenElement) {
      let position = event;
      if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) {
        // xterm 惯性事件只带位移；沿用离手位置，避免生成 CSI <…;NaN;NaNM。
        if (event.type !== '-xterm-gesturechange' || !lastTouch) return undefined;
        position = lastTouch;
      }
      const report = originalGetCoords.call(service, position, screenElement);
      if (!report || ![report.col, report.row, report.x, report.y].every(Number.isFinite)) return undefined;
      return report;
    }
    service.getMouseReportCoords = guardedGetCoords;
    const touchEvents = ['touchstart', 'touchmove', 'touchend', 'touchcancel'];
    for (const type of touchEvents) {
      element.addEventListener(type, rememberTouch, { capture: true, passive: true });
    }
    return () => {
      for (const type of touchEvents) element.removeEventListener(type, rememberTouch, true);
      if (service.getMouseReportCoords === guardedGetCoords) service.getMouseReportCoords = originalGetCoords;
      lastTouch = null;
    };
  }
  try {
    const container = document.getElementById('terminal');
    const terminal = new Terminal({
      fontSize: 13, fontFamily: 'monospace', scrollback: 3000, cursorBlink: true,
      // 手机端用触摸滚动，隐藏 xterm 自绘滚动条，内容区才能铺满整个宽度。
      scrollbar: { showScrollbar: false },
      theme: { background: '#101418', foreground: '#e6edf3', cursor: '#e6edf3' },
    });
    terminal.open(container);
    const removeMouseGuard = installMouseGuard(terminal);
    let lastSize = '';
    let localSize = { cols: terminal.cols, rows: terminal.rows };
    let queue = Promise.resolve();
    let disposed = false;
    let replaying = false;
    terminal.onData(data => { if (!replaying && !disposed) AndroidTerminal.input(data); });
    // 回放中的能力查询不能再次回复到正在运行的 shell。
    terminal.parser.registerCsiHandler({ prefix: '>', final: 'q' }, () => true);
    const write = data => new Promise(resolve => terminal.write(data, resolve));
    function resize(cols, rows) {
      if (Number.isFinite(cols) && Number.isFinite(rows) && cols > 0 && rows > 0 &&
          (terminal.cols !== cols || terminal.rows !== rows)) terminal.resize(cols, rows);
    }
    // 不依赖 addon-fit：它固定为滚动条预留 14px，而这里已经隐藏滚动条，
    // 直接按容器实际尺寸与字符格宽算列数，才能铺满整屏不留右侧空白。
    function proposeSize() {
      const core = terminal._core;
      const dims = core && core._renderService && core._renderService.dimensions;
      if (!dims || !dims.css.cell.width || !dims.css.cell.height) return null;
      const element = terminal.element;
      if (!element) return null;
      const style = window.getComputedStyle(element);
      const padding = n => parseFloat(style.getPropertyValue(n)) || 0;
      const rect = container.getBoundingClientRect();
      const width = Math.max(0, rect.width - padding('padding-left') - padding('padding-right'));
      const height = Math.max(0, rect.height - padding('padding-top') - padding('padding-bottom'));
      if (width < 1 || height < 1) return null;
      return {
        cols: Math.floor(width / dims.css.cell.width),
        rows: Math.floor(height / dims.css.cell.height),
      };
    }
    function measure() {
      if (disposed) return;
      const rect = container.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      const size = proposeSize();
      if (!size || !Number.isFinite(size.cols) || !Number.isFinite(size.rows)) return;
      const cols = Math.max(2, Math.min(500, size.cols));
      const rows = Math.max(1, Math.min(500, size.rows));
      localSize = { cols, rows };
      if (replaying) return;
      resize(cols, rows);
      const key = `${cols}:${rows}`;
      if (key === lastSize) return;
      lastSize = key;
      AndroidTerminal.resize(cols, rows);
    }
    window.terminalHost = {
      receive(message) {
        queue = queue.then(async () => {
          if (disposed) return;
          if (message.type === 'replay') {
            replaying = true;
            try {
              // 等旧 write 队列完成后才重置；逐帧按原网格回放，再恢复手机尺寸。
              await write('\x1bc');
              for (const frame of message.frames) {
                resize(frame.cols, frame.rows);
                await write(frame.data);
              }
              resize(localSize.cols, localSize.rows);
              terminal.scrollToBottom();
            } finally { replaying = false; }
            measure();
          } else if (message.type === 'output') {
            await write(message.data);
          } else if (message.type === 'viewport') {
            resize(message.cols, message.rows);
          }
        }).catch(() => AndroidTerminal.error());
      },
      selection() { return terminal.getSelection(); },
      scrollToBottom() { terminal.scrollToBottom(); },
      dispose() { disposed = true; removeMouseGuard(); terminal.dispose(); },
    };
    if (typeof ResizeObserver === 'function') new ResizeObserver(measure).observe(container);
    window.addEventListener('resize', measure);
    // WebView 的首次脚本执行可能早于 AndroidView 布局；下一帧重新测量。
    requestAnimationFrame(measure);
    measure();
    AndroidTerminal.ready();
  } catch (_) {
    AndroidTerminal.error();
  }
})();
