import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const { Terminal } = require('@xterm/xterm');

function load(file, mocks = {}) {
  const module = { exports: {} };
  const { outputText } = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  });
  new Function('require', 'module', 'exports', outputText)(name => {
    if (Object.hasOwn(mocks, name)) return mocks[name];
    throw new Error('Missing mock: ' + name);
  }, module, module.exports);
  return module.exports;
}

const templates = load('../src/data/commandTemplates.ts', {
  '../services/tauri': {},
  './terminalSuggestions': load('../src/data/terminalSuggestions.ts'),
});
const helpers = load('../src/components/terminal/terminal-helpers.ts', {
  './instance-utils': { FLOATING_MENU_MARGIN: 8 },
  '../../stores/appStore': {},
  '../../data/commandTemplates': templates,
  '../../services/tauri': {},
});
const { getInputAtCursor, getCommandSuggestions, getAutocompleteCompletion, installAutocompleteRefresh } = helpers;
const write = (terminal, text) => new Promise(resolve => terminal.write(text, resolve));
const settle = () => new Promise(resolve => setTimeout(resolve, 10));

for (const prompt of [
  'terminalbuddy@host:/workspace$ ', 'root@host:/workspace# ',
  '/workspace % ', '[user@host workspace]$ ', '$ ', '# ',
  'PS C:\\workspace> ', 'C:\\workspace>', 'PS C:\\my project> ', 'PS /workspace> ',
]) {
  const terminal = new Terminal({ cols: 100, rows: 8, allowProposedApi: true });
  try {
    await write(terminal, prompt + 'gi');
    assert.equal(getInputAtCursor(terminal), 'gi', prompt);
    const suggestions = getCommandSuggestions(getInputAtCursor(terminal));
    assert.ok(suggestions.some(item => item.command === 'git'), prompt + ' should suggest git');
    assert.equal(getAutocompleteCompletion('git', getInputAtCursor(terminal)), 't');
    await write(terminal, 't ');
    assert.equal(getInputAtCursor(terminal), 'git ', 'keep the argument boundary');
    assert.ok(getCommandSuggestions(getInputAtCursor(terminal)).some(item => item.command === 'git add'));
    await write(terminal, '\r\n' + prompt + 'echo "$HOME # value" > output.txt');
    assert.equal(getInputAtCursor(terminal), 'echo "$HOME # value" > output.txt', 'preserve command operators');
  } finally {
    terminal.dispose();
  }
}

// A long prompt and command can both wrap; only text before the cursor is input.
{
  const terminal = new Terminal({ cols: 24, rows: 12, allowProposedApi: true });
  try {
    await write(terminal, 'terminalbuddy@host:/workspace/long-project$ git checkout feature/long-name');
    assert.equal(getInputAtCursor(terminal), 'git checkout feature/long-name');
    await write(terminal, '\x1b[1D');
    assert.equal(getInputAtCursor(terminal), 'git checkout feature/long-nam');
  } finally {
    terminal.dispose();
  }
}

console.log('PASS: Linux/Windows prompts, suggestions, argument spaces, redirection and wrapped input.');

for (const [input, expected] of [
  ['git ', 'git add'], ['git  ', 'git  add'], ['git   st', 'git   status'],
  ['git commit ', 'git commit --amend'], ['docker compose ', 'docker compose up'],
]) {
  assert.ok(templates.getTerminalSuggestions(input).some(item => item.command === expected), input);
}

// Simulate WebSocket latency: input events arrive before the shell echoes text.
{
  const terminal = new Terminal({ cols: 100, rows: 8, allowProposedApi: true });
  const updates = [];
  let dismissals = 0;
  const refresh = installAutocompleteRefresh(terminal, () => updates.push(getInputAtCursor(terminal)), () => dismissals++);
  try {
    await write(terminal, 'user@host:/workspace$ ');
    terminal.input('g', true);
    await settle();
    assert.equal(updates.at(-1), '', 'the initial key event sees the old buffer');
    await write(terminal, 'g');
    await settle();
    assert.equal(updates.at(-1), 'g', 'refresh after the delayed first echo');
    assert.ok(getCommandSuggestions(updates.at(-1)).some(item => item.command === 'git'));

    // A paste/IME input may be echoed in multiple packets.
    terminal.input('it ', true);
    await write(terminal, 'i');
    await settle();
    await write(terminal, 't ');
    await settle();
    assert.equal(updates.at(-1), 'git ');
    assert.ok(getCommandSuggestions(updates.at(-1)).some(item => item.command === 'git add'));

    terminal.input('\x7f', true);
    await write(terminal, '\b \b');
    await settle();
    assert.equal(updates.at(-1), 'git', 'refresh after backspace echo');

    for (const cancelInput of ['\r', '\n', '\x1b', '\x03', '\x04', 'git\nstatus']) {
      terminal.input('s', true);
      const dismissCount = dismissals;
      terminal.input(cancelInput, true);
      assert.equal(dismissals, dismissCount + 1, 'submit/cancel must close the existing popup');
      const count = updates.length;
      await write(terminal, '\r\noutput\r\nuser@host:/workspace$ ');
      await settle();
      assert.equal(updates.length, count, 'submitted/cancelled input must not reopen suggestions');
    }

    terminal.input('gi', true);
    refresh.cancel();
    const cancelledCount = updates.length;
    await write(terminal, 'git');
    await settle();
    assert.equal(updates.length, cancelledCount, 'accept/dismiss cancels pending echo refresh');

    terminal.input('s', true);
    refresh.dispose();
    const disposedCount = updates.length;
    await write(terminal, 's');
    terminal.input('t', true);
    await settle();
    assert.equal(updates.length, disposedCount, 'dispose removes listeners and queued work');
  } finally {
    refresh.dispose();
    terminal.dispose();
  }
}

console.log('PASS: Delayed/fragmented PTY echo, paste/IME input, backspace, submit/cancel and disposal.');

// 状态查询会通过 onData 自动回复，不能将回复当作用户输入。
{
  const terminal = new Terminal({ cols: 100, rows: 8, allowProposedApi: true });
  const updates = [];
  const refresh = installAutocompleteRefresh(terminal, () => updates.push(getInputAtCursor(terminal)), () => {});
  try {
    await write(terminal, 'PS C:\\workspace> ');
    for (const query of ['\x1b[5n', '\x1b[6n', '\x1b[?6n', '\x1b[c', '\x1b[>c']) {
      await write(terminal, query);
      await settle();
      assert.equal(updates.length, 0, '终端状态回复不应触发补全刷新');
    }

    terminal.input('g', true);
    await write(terminal, 'g');
    await settle();
    assert.equal(updates.at(-1), 'g', '忽略状态回复后仍能正常补全');
    terminal.input('\r', true);
    const submittedCount = updates.length;
    for (const frame of ['-', '/', '|', '\\', '⠋', '⠙']) {
      await write(terminal, '\r\x1b[2K' + frame + '\x1b[6n');
      await settle();
      assert.equal(getInputAtCursor(terminal), null, '加载动画不是命令输入');
      assert.equal(updates.length, submittedCount, '加载动画及其状态查询不应重新唤起补全');
    }

    terminal.input('g', true);
    await settle();
    assert.equal(updates.length, submittedCount, '没有命令提示符时输入也不应唤起补全');

    await write(terminal, '\r\x1b[2KPS C:\\workspace> ');
    terminal.input('gi', true);
    await write(terminal, 'gi');
    await settle();
    assert.equal(updates.at(-1), 'gi', '加载结束后输入可重新触发补全');

    terminal.input('\x1b[D', true);
    await write(terminal, '\x1b[D');
    await settle();
    assert.equal(updates.at(-1), 'g', '方向键编辑后仍会刷新补全');

    terminal.input('\x1b[200~it \x1b[201~', true);
    await write(terminal, 'it ');
    await settle();
    assert.equal(updates.at(-1), 'git ', '括号粘贴后仍会刷新补全');
  } finally {
    refresh.dispose();
    terminal.dispose();
  }
}

console.log('通过：终端状态回复、加载动画、执行期间输入、恢复输入、方向键与括号粘贴。');
