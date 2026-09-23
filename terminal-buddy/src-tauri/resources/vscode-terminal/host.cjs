'use strict';

const fs = require('node:fs');
const path = require('node:path');
const pty = require('node-pty');

if (process.argv[2] === '--probe') {
  const nodePtyPackagePath = require.resolve('node-pty/package.json');
  const nodePtyRoot = path.dirname(nodePtyPackagePath);
  const prebuildRoot = path.join(nodePtyRoot, 'prebuilds', `${process.platform}-${process.arch}`);
  const requiredFiles = [
    path.join(prebuildRoot, 'conpty.node'),
    path.join(prebuildRoot, 'conpty', 'conpty.dll'),
    path.join(prebuildRoot, 'conpty', 'OpenConsole.exe'),
  ];
  const missingFiles = requiredFiles.filter(file => !fs.existsSync(file));
  if (missingFiles.length > 0) {
    throw new Error(`Missing VS Code terminal resources: ${missingFiles.join(', ')}`);
  }
  const nodePtyVersion = require(nodePtyPackagePath).version;
  process.stdout.write(JSON.stringify({
    protocol: 'TBP-PROBE-1',
    nodeVersion: process.versions.node,
    arch: process.arch,
    nodePtyVersion,
  }));
  process.exit(0);
}

const FRAME_INPUT = 1;
const FRAME_RESIZE = 2;
const FRAME_KILL = 3;
const FRAME_ACK = 4;
const MAX_FRAME_LENGTH = 16 * 1024 * 1024;
const HIGH_WATERMARK_CHARS = 100000;
const LOW_WATERMARK_CHARS = 5000;
const PRIMARY_DEVICE_ATTRIBUTES_RESPONSE = '\x1b[?61;4c';

function fail(error) {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(`[vscode-terminal] ${message}\n`);
  process.exit(1);
}

function decodeConfig(value) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

try {
  const config = decodeConfig(process.argv[2]);
  const env = {
    ...process.env,
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'vscode',
    TERM_PROGRAM_VERSION: config.vsCodeVersion,
    ...config.env,
  };
  const terminal = pty.spawn('cmd.exe', [], {
    name: 'cmd.exe',
    cols: config.cols,
    rows: config.rows,
    cwd: config.cwd || process.cwd(),
    env,
    useConpty: true,
    useConptyDll: true,
    conptyInheritCursor: false,
  });

  let pausedForBackpressure = false;
  let pausedForFlowControl = false;
  let ptyPaused = false;
  let unacknowledgedCharCount = 0;
  let handshakeSent = false;
  let killRequested = false;
  let pendingOutput = [];
  let handshakePoll = null;
  let handshakeTimeout = null;
  let deviceAttributesScanTail = '';

  const respondToPrimaryDeviceAttributes = data => {
    const scanData = deviceAttributesScanTail + data;
    const queries = scanData.match(/\x1b\[(?:0)?c/g)?.length ?? 0;
    for (let i = 0; i < queries; i += 1) {
      terminal.write(PRIMARY_DEVICE_ATTRIBUTES_RESPONSE);
    }

    deviceAttributesScanTail = '';
    for (const prefix of ['\x1b[0', '\x1b[', '\x1b']) {
      if (scanData.endsWith(prefix)) {
        deviceAttributesScanTail = prefix;
        break;
      }
    }
  };

  const updatePtyPause = () => {
    const shouldPause = pausedForBackpressure || pausedForFlowControl;
    if (shouldPause && !ptyPaused) {
      ptyPaused = true;
      terminal.pause();
    } else if (!shouldPause && ptyPaused) {
      ptyPaused = false;
      terminal.resume();
    }
  };

  const forwardOutput = data => {
    unacknowledgedCharCount += data.length;
    if (!pausedForFlowControl && unacknowledgedCharCount > HIGH_WATERMARK_CHARS) {
      pausedForFlowControl = true;
      updatePtyPause();
    }
    const accepted = process.stdout.write(Buffer.from(data, 'utf8'));
    if (!accepted && !pausedForBackpressure) {
      pausedForBackpressure = true;
      updatePtyPause();
      process.stdout.once('drain', () => {
        pausedForBackpressure = false;
        updatePtyPause();
      });
    }
  };

  const sendHandshake = () => {
    if (handshakeSent || terminal.pid <= 0) return false;
    const handshake = Buffer.allocUnsafe(8);
    handshake.write('TBP1', 0, 4, 'ascii');
    handshake.writeUInt32LE(terminal.pid >>> 0, 4);
    process.stdout.write(handshake);
    handshakeSent = true;
    if (handshakePoll) clearInterval(handshakePoll);
    if (handshakeTimeout) clearTimeout(handshakeTimeout);
    const queuedOutput = pendingOutput;
    pendingOutput = [];
    for (const data of queuedOutput) forwardOutput(data);
    return true;
  };

  terminal.onData(data => {
    // ConPTY asks for DA1 during startup and expects the answer immediately.
    // Routing this through Tauri/xterm can arrive after cmd.exe starts reading
    // commands, where it becomes visible input and prefixes the shell command.
    respondToPrimaryDeviceAttributes(data);

    // node-pty >= 1.2.0-beta.11 connects ConPTY asynchronously. Keep output in
    // order until the real pid is visible instead of treating a zero pid as a
    // process failure.
    if (!handshakeSent) {
      pendingOutput.push(data);
      sendHandshake();
      return;
    }
    forwardOutput(data);
  });
  if (!sendHandshake()) {
    handshakePoll = setInterval(sendHandshake, 2);
    handshakeTimeout = setTimeout(() => fail('Timed out waiting for the ConPTY process id'), 10000);
  }

  terminal.onExit(event => {
    if (handshakePoll) clearInterval(handshakePoll);
    if (handshakeTimeout) clearTimeout(handshakeTimeout);
    process.stdout.end(() => process.exit(killRequested ? 0 : (event.exitCode || 0)));
  });

  let input = Buffer.alloc(0);
  process.stdin.on('data', chunk => {
    input = input.length === 0 ? chunk : Buffer.concat([input, chunk]);
    while (input.length >= 5) {
      const type = input.readUInt8(0);
      const length = input.readUInt32LE(1);
      if (length > MAX_FRAME_LENGTH) fail(`Invalid frame length: ${length}`);
      if (input.length < 5 + length) return;
      const payload = input.subarray(5, 5 + length);
      input = input.subarray(5 + length);

      if (type === FRAME_INPUT) {
        terminal.write(payload.toString('utf8'));
      } else if (type === FRAME_RESIZE && payload.length === 4) {
        terminal.resize(payload.readUInt16LE(0), payload.readUInt16LE(2));
      } else if (type === FRAME_KILL) {
        killRequested = true;
        terminal.kill();
      } else if (type === FRAME_ACK && payload.length === 4) {
        const charCount = payload.readUInt32LE(0);
        unacknowledgedCharCount = Math.max(unacknowledgedCharCount - charCount, 0);
        if (pausedForFlowControl && unacknowledgedCharCount < LOW_WATERMARK_CHARS) {
          pausedForFlowControl = false;
          updatePtyPause();
        }
      } else {
        fail(`Invalid frame type ${type} with ${payload.length} bytes`);
      }
    }
  });
  process.stdin.on('end', () => {
    killRequested = true;
    terminal.kill();
  });
  process.stdin.on('error', fail);
  process.on('uncaughtException', fail);
  process.on('unhandledRejection', fail);
} catch (error) {
  fail(error);
}
