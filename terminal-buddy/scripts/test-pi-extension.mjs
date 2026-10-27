#!/usr/bin/env node
// Pi 扩展事件映射测试：不启动真实 Pi，用 mock `pi.on` 与 fetch 验证上报内容。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(here, '../src-tauri/resources/pi/terminal-buddy-extension.js');
const source = readFileSync(sourcePath, 'utf8');

async function loadExtension() {
  const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  return module.default;
}

function makePi() {
  const handlers = new Map();
  return {
    handlers,
    on(name, handler) {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
  };
}

function makeContext() {
  return {
    cwd: '/workspace/demo',
    sessionManager: {
      getSessionId: () => '01900000-0000-7000-8000-000000000001',
      getSessionFile: () => '/home/user/.pi/agent/sessions/--workspace-demo--/x.jsonl',
    },
  };
}

async function withEnvironment(env, run) {
  for (const key of ['TERMINAL_BUDDY_TERMINAL_ID', 'TERMINAL_BUDDY_HOOK_TOKEN', 'TERMINAL_BUDDY_HOOK_PORT', 'TERMINAL_BUDDY_PI_TOOL_APPROVAL']) {
    delete process.env[key];
  }
  Object.assign(process.env, env);
  try {
    return await run();
  } finally {
    for (const key of ['TERMINAL_BUDDY_TERMINAL_ID', 'TERMINAL_BUDDY_HOOK_TOKEN', 'TERMINAL_BUDDY_HOOK_PORT', 'TERMINAL_BUDDY_PI_TOOL_APPROVAL']) {
      delete process.env[key];
    }
  }
}

const calls = [];
globalThis.fetch = async (url, options) => {
  calls.push({ url, body: JSON.parse(options.body), headers: options.headers });
  return {
    ok: true,
    text: async () => JSON.stringify({ allow: false }),
  };
};

await withEnvironment({}, async () => {
  const pi = makePi();
  const create = await loadExtension();
  create(pi);
  assert.equal(pi.handlers.size, 0, '无终端环境变量时必须完全 no-op');
});

await withEnvironment({
  TERMINAL_BUDDY_TERMINAL_ID: 'terminal-1',
  TERMINAL_BUDDY_HOOK_TOKEN: 'token-1',
  TERMINAL_BUDDY_HOOK_PORT: '19601',
  TERMINAL_BUDDY_PI_TOOL_APPROVAL: '1',
}, async () => {
  calls.length = 0;
  const pi = makePi();
  const create = await loadExtension();
  create(pi);
  const ctx = makeContext();
  await pi.handlers.get('session_start')({ reason: 'startup' }, ctx);
  assert.equal(calls.at(-1).body.event, 'SessionStart');
  assert.equal(calls.at(-1).body.sessionId, ctx.sessionManager.getSessionId());
  assert.equal(calls.at(-1).headers['x-terminalbuddy-terminal-id'], 'terminal-1');

  await pi.handlers.get('input')({ text: '修复 bug' }, ctx);
  assert.equal(calls.at(-1).body.event, 'UserPromptSubmit');
  assert.equal(calls.at(-1).body.prompt, '修复 bug');

  pi.handlers.get('message_end')({ message: { role: 'assistant', stopReason: 'error' } });
  await pi.handlers.get('agent_settled')({ aborted: false }, ctx);
  assert.equal(calls.at(-1).body.event, 'StopFailure');

  const blocked = await pi.handlers.get('tool_call')({ toolName: 'bash', input: { command: 'rm -rf /' } }, ctx);
  assert.equal(calls.at(-1).body.event, 'ToolApproval');
  assert.deepEqual(blocked, { block: true, reason: '用户在 TerminalBuddy 中拒绝了本次工具调用' });

  const allowedTool = await pi.handlers.get('tool_call')({ toolName: 'read', input: {} }, ctx);
  assert.equal(allowedTool, undefined);
  assert.equal(calls.at(-1).body.event, 'ToolCall');
});

console.log('Pi extension event mapping: OK');
