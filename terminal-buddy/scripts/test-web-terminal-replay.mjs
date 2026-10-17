import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const source = ts.transpileModule(
  readFileSync(new URL('../web/src/hooks/useTerminalWs.ts', import.meta.url), 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } },
).outputText;
const effects = [], timers = [], sockets = [], events = [];
const state = { token: 'fixture', reconnectNonce: 0, setConnectionFatal() {}, logout() {} };
const useStore = Object.assign(selector => selector(state), { getState: () => state });

class Socket {
  static CONNECTING = 0;
  static OPEN = 1;
  readyState = Socket.CONNECTING;
  sent = [];
  constructor(url) { this.url = url; sockets.push(this); }
  send(data) { this.sent.push(JSON.parse(data)); events.push('resize'); }
  open() { this.readyState = Socket.OPEN; this.onopen(); }
  close() { this.readyState = 3; this.onclose?.(); }
  receive(message) { this.onmessage({ data: JSON.stringify(message) }); }
}

const exports = {};
runInNewContext(source, {
  exports,
  WebSocket: Socket,
  location: { protocol: 'https:', host: 'terminal.example.com' },
  setTimeout: callback => { timers.push(callback); return timers.length; },
  clearTimeout() {},
  require: name => {
    if (name === 'react') return {
      useRef: current => ({ current }),
      useCallback: callback => callback,
      useEffect: callback => effects.push(callback),
    };
    if (name === '../store') return { useStore };
    if (name === '../api') return { isTokenExpired: () => false, probeAuth: async () => 'ok' };
    throw new Error('Unexpected import: ' + name);
  },
});

const output = [], replay = [];
const hook = exports.useTerminalWs('terminal-id', {
  onOutput: data => output.push(data),
  onReplay: frames => replay.push(frames),
  onConnected: () => events.push('reset'),
  onExited() {},
});
const cleanup = effects[0]();
hook.sendResize(120, 30);
sockets[0].open();
assert.equal(sockets[0].url, 'wss://terminal.example.com/ws/terminal/terminal-id?token=fixture&replay=1');
assert.deepEqual(events, ['reset', 'resize'], 'Reset the old view before requesting history');
assert.deepEqual(sockets[0].sent, [{ type: 'resize', cols: 120, rows: 30 }]);
const frames = [{ data: 'wide screen', cols: 120, rows: 30 }, { data: 'phone', cols: 45, rows: 35 }];
sockets[0].receive({ type: 'replay', frames });
assert.deepEqual(JSON.parse(JSON.stringify(replay)), [frames]);
sockets[0].receive({ type: 'output', data: 'live output' });
assert.deepEqual(output, ['live output']);

hook.sendResize(45, 35);
sockets[0].close();
assert.equal(timers.length, 1);
timers[0]();
await Promise.resolve();
sockets[1].open();
assert.deepEqual(sockets[1].sent, [{ type: 'resize', cols: 45, rows: 35 }], 'Reconnect must resend the latest grid even without a new layout event');
sockets[0].receive({ type: 'output', data: 'stale socket' });
assert.deepEqual(output, ['live output']);
cleanup();
sockets[1].receive({ type: 'output', data: 'after unmount' });
assert.deepEqual(output, ['live output']);

console.log('Web terminal replay checks passed: grid frames, legacy output, reset ordering, reconnect handshake and stale sockets.');
