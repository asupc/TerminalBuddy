/* 本地渲染层不持有登录令牌，不发网络请求。通信由 Android 原生层负责。 */
(() => {
  'use strict';
  const terminal = new Terminal({
    fontSize: 13, fontFamily: 'monospace', scrollback: 3000, cursorBlink: true,
    theme: { background: '#101418', foreground: '#e6edf3', cursor: '#e6edf3' },
  });
  const fit = new FitAddon.FitAddon();
  terminal.loadAddon(fit);
  terminal.open(document.getElementById('terminal'));
  terminal.onData(data => AndroidTerminal.input(data));
  let lastSize = '';
  let queue = Promise.resolve();
  let disposed = false;
  const write = data => new Promise(resolve => terminal.write(data, resolve));
  function resize(cols, rows) {
    if (cols > 0 && rows > 0 && (terminal.cols !== cols || terminal.rows !== rows)) terminal.resize(cols, rows);
  }
  function measure() {
    const size = fit.proposeDimensions();
    if (!size) return;
    const cols = Math.max(1, Math.min(500, size.cols));
    const rows = Math.max(1, Math.min(500, size.rows));
    const key = `${cols}:${rows}`;
    if (key === lastSize) return;
    lastSize = key;
    resize(cols, rows);
    AndroidTerminal.resize(cols, rows);
  }
  window.terminalHost = {
    receive(message) {
      queue = queue.then(async () => {
        if (disposed) return;
        if (message.type === 'replay') {
          const cols = terminal.cols, rows = terminal.rows;
          terminal.reset();
          for (const frame of message.frames) {
            resize(frame.cols, frame.rows);
            await write(frame.data);
          }
          resize(cols, rows);
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
  new ResizeObserver(measure).observe(document.getElementById('terminal'));
  measure();
  AndroidTerminal.ready();
})();
