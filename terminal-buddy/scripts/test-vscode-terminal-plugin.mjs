import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const handshakeOnly = process.argv.includes('--handshake-only');
const bundleKind = process.argv.includes('--release')
  ? 'release'
  : process.argv.includes('--bundled') ? 'bundled' : 'source';
const pluginRoot = bundleKind === 'release'
  ? path.join(root, 'src-tauri', 'target', 'release', 'resources', 'vscode-terminal')
  : bundleKind === 'bundled'
    ? path.join(root, 'src-tauri', 'resources', 'vscode-terminal')
    : path.join(root, 'plugins', 'vscode-terminal');
const node = process.execPath;
let host = path.join(pluginRoot, 'host.cjs');
if (process.argv.includes('--verbatim-host')) {
  host = `\\\\?\\${host}`;
}
const config = Buffer.from(JSON.stringify({
  cols: 80,
  rows: 24,
  cwd: root,
  env: {},
  vsCodeVersion: '1.126.0',
})).toString('base64url');

const child = spawn(node, [host, config], {
  cwd: root,
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});
const startedAt = Date.now();

let handshake = Buffer.alloc(0);
let output = '';
let stderr = '';
let shellPid = 0;
let resolveHandshake;
const handshakeReady = new Promise(resolve => {
  resolveHandshake = resolve;
});

child.stdout.on('data', chunk => {
  if (shellPid > 0) {
    output += chunk.toString('utf8');
  } else {
    handshake = Buffer.concat([handshake, chunk]);
    if (handshake.length < 8) return;
    assert.equal(handshake.subarray(0, 4).toString('ascii'), 'TBP1');
    shellPid = handshake.readUInt32LE(4);
    assert.ok(shellPid > 0, 'handshake must contain the real shell pid');
    output += handshake.subarray(8).toString('utf8');
    resolveHandshake();
  }
});
child.stderr.on('data', chunk => {
  stderr += chunk.toString('utf8');
});

function writeFrame(type, data = Buffer.alloc(0)) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  const frame = Buffer.allocUnsafe(5 + payload.length);
  frame.writeUInt8(type, 0);
  frame.writeUInt32LE(payload.length, 1);
  payload.copy(frame, 5);
  child.stdin.write(frame);
}

async function waitFor(predicate, description, timeout = 10000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) {
      throw new Error(`Timed out waiting for ${description}\nPTY output:\n${output}\nPlugin stderr:\n${stderr}`);
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function withTimeout(promise, message, timeout = 10000) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeout);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

try {
  await withTimeout(handshakeReady, 'Handshake timed out');
  const handshakeMs = Date.now() - startedAt;
  let resizeMs = handshakeMs;
  let redrawMs = handshakeMs;

  if (!handshakeOnly) {
    await new Promise(resolve => setTimeout(resolve, 300));
    writeFrame(1, 'powershell.exe -NoLogo -NoProfile\r');
    writeFrame(1, 'Write-Output __TB_POWERSHELL_READY__\r');
    await waitFor(() => output.includes('__TB_POWERSHELL_READY__'), 'PowerShell startup');
    assert.ok(!output.includes('?61;4cpowershell.exe'), 'DA1 response leaked into the shell command');
    const exitOutputOffset = output.length;
    writeFrame(1, 'exit\r');
    await waitFor(() => output.slice(exitOutputOffset).includes('cmd.exe'), 'cmd.exe resume');

    const resizePayload = Buffer.allocUnsafe(4);
    resizePayload.writeUInt16LE(100, 0);
    resizePayload.writeUInt16LE(30, 2);
    writeFrame(2, resizePayload);

    writeFrame(1, 'node -e "process.stdout.write([\'__TB_SIZE__\',process.stdout.columns,\'x\',process.stdout.rows].join(\'\'))"\r');
    await waitFor(() => output.includes('__TB_SIZE__100x30'), '100x30 resize result');
    resizeMs = Date.now() - startedAt;

    const redrawCommand = 'node -e "let i=0,t=setInterval(()=>{process.stdout.write(\'\\x1b[?2026h\\x1b[1;1Hframe \'+i+\'\\x1b[?2026l\');if(++i===20){clearInterval(t);process.stdout.write([\'__TB\',\'ANSI\',\'DONE__\'].join(\'_\'))}},2)"\r';
    writeFrame(1, redrawCommand);
    await waitFor(() => output.includes('__TB_ANSI_DONE__'), 'ANSI redraw sequence');
    redrawMs = Date.now() - startedAt;

    assert.ok(output.split('\x1b[?2026h').length - 1 >= 20, 'missing synchronized-output begin sequences');
    assert.ok(output.split('\x1b[?2026l').length - 1 >= 20, 'missing synchronized-output end sequences');
  }

  writeFrame(3);
  const exitCode = await withTimeout(
    new Promise(resolve => child.once('exit', resolve)),
    'Plugin did not exit after kill',
  );
  assert.equal(exitCode, 0, stderr);
  console.log(
    `VS Code terminal plugin passed (${bundleKind}): ` +
    `pid=${shellPid}, ${handshakeOnly ? 'handshake-only' : 'size=100x30, redraws=20'}, ` +
    `timing=${handshakeMs}/${resizeMs}/${redrawMs}/${Date.now() - startedAt}ms`,
  );
} catch (error) {
  child.kill();
  throw error;
}
