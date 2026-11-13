import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

function load(file, mocks = {}) {
  const source = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', outputText)(name => {
    if (!(name in mocks)) throw new Error('Unexpected dependency: ' + name);
    return mocks[name];
  }, module, module.exports);
  return module.exports;
}
const claude = load('src/utils/claudeLaunch.ts');
const desktop = load('src/utils/codexLaunch.ts', { './claudeLaunch': claude });

for (const utils of [desktop]) {
  for (const command of ['codex', 'codex --sandbox workspace-write', 'codex.cmd --resume', '"codex.exe" -m old']) {
    assert.equal(utils.isCodexCommand(command), true, command);
  }
  for (const command of ['codex-other', 'echo mycodex', 'claude']) {
    assert.equal(utils.isCodexCommand(command), false, command);
  }
  const command = utils.buildCodexRefCommand('provider', 'vendor/model:variant', [
    'echo before',
    'codex.cmd --model old -p other -c \'model_provider="old"\' --sandbox workspace-write --dangerously-bypass-hook-trust; echo after',
  ]);
  assert.equal(command.replace(/\s+/g, ' '), '__TB_CODEX_REF__:provider:vendor/model:variant --sandbox workspace-write --dangerously-bypass-hook-trust');
  assert.equal(utils.buildCodexRefCommand('p', 'm', 'codex --profile=old --model=old --config="model=old" --verbose').replace(/\s+/g, ' '), '__TB_CODEX_REF__:p:m --verbose');
  assert.equal(utils.buildCodexRefCommand('p', 'm', 'codex --oss --local-provider ollama --remote ws://example.invalid --remote-auth-token-env REMOTE --sandbox workspace-write').replace(/\s+/g, ' '), '__TB_CODEX_REF__:p:m --sandbox workspace-write');
  for (const source of [undefined, [], 'claude --model old --verbose', ['echo before', 'claude --resume session']]) {
    assert.equal(utils.buildCodexRefCommand('p', 'm', source), '__TB_CODEX_REF__:p:m --dangerously-bypass-approvals-and-sandbox');
  }
  assert.equal(utils.buildCodexRefCommand('p', 'm', 'codex'), '__TB_CODEX_REF__:p:m');
  assert.equal(utils.buildCodexRefCommand('p', 'm', utils.DEFAULT_CODEX_COMMAND), '__TB_CODEX_REF__:p:m --dangerously-bypass-approvals-and-sandbox');
}
assert.deepEqual(desktop.parseModelRef('  __TB_CODEX_REF__:p:vendor/model:variant --resume'), { providerId: 'p', modelId: 'vendor/model:variant' });
assert.deepEqual(desktop.parseModelRef('__TB_CLAUDE_REF__:p:claude-model'), { providerId: 'p', modelId: 'claude-model' });
for (const command of ['codex', '__TB_CODEX_REF__:missing', '__TB_CODEX_REF__::model', '__TB_CODEX_REF__:p:']) {
  assert.equal(desktop.parseCodexRef(command), null);
}
console.log('PASS: 桌面 Codex 引用、参数继承、冲突配置剔除、跨工具默认命令及模型标签解析');

// 「以此配置新建终端」必须剥掉续接参数：会话既可能以字面量 codex 启动，
// 也可能以供应商引用标记（__TB_CODEX_REF__:）启动。
const params = load('src/utils/commandParams.ts');
for (const [input, expected, sessionId] of [
  ['codex --sandbox workspace-write resume abc-123', 'codex --sandbox workspace-write', 'abc-123'],
  ['__TB_CODEX_REF__:p:m resume abc-123', '__TB_CODEX_REF__:p:m', 'abc-123'],
  ['__TB_CODEX_REF__:p:m -c model_provider=terminal_buddy_x resume abc-123', '__TB_CODEX_REF__:p:m -c model_provider=terminal_buddy_x', 'abc-123'],
]) {
  assert.deepEqual(params.stripCodexResumeArgs(input), { params: expected, sessionId });
  assert.equal(params.withoutResumeArgs(input), expected);
}
assert.equal(params.withoutResumeArgs('__TB_CODEX_REF__:p:m --sandbox workspace-write'), '__TB_CODEX_REF__:p:m --sandbox workspace-write');
console.log('PASS: 剥离 Codex 续接参数（含供应商引用标记启动的会话）');

for (const source of [[], ['codex --model old --sandbox read-only'], ['echo before', 'codex --resume session']]) {
  assert.equal(claude.inheritableClaudeArgs(source, claude.DEFAULT_CLAUDE_COMMAND), '--dangerously-skip-permissions');
  assert.equal(claude.inheritableClaudeArgs(source), '', '历史恢复仍由已有参数控制');
}
for (const [source, expected] of [
  [['claude'], ''],
  [['claude --model old --effort high --settings="old file" --resume session'], '--resume session'],
  [[claude.DEFAULT_CLAUDE_COMMAND], '--dangerously-skip-permissions'],
]) {
  assert.equal(claude.inheritableClaudeArgs(source, claude.DEFAULT_CLAUDE_COMMAND), expected);
}
console.log('PASS: Codex 切换 Claude 使用默认命令，同类参数和历史恢复保持原行为');
