/* 本地渲染层不持有登录令牌，不发网络请求。通信由 Android 原生层负责。 */
(() => {
  'use strict';
  try {
    const container = document.getElementById('terminal');
    const terminal = new Terminal({
      fontSize: 13, fontFamily: 'monospace', scrollback: 3000, cursorBlink: true,
      theme: { background: '#101418', foreground: '#e6edf3', cursor: '#e6edf3' },
    });
    const fit = new FitAddon.FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);
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
    function measure() {
      if (disposed) return;
      const rect = container.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      const size = fit.proposeDimensions();
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
      dispose() { disposed = true; terminal.dispose(); },
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
