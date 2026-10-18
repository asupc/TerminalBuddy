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
const mobile = load('web/src/utils/codexLaunch.ts');

for (const utils of [desktop, mobile]) {
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
  assert.equal(utils.buildCodexRefCommand('p', 'm', 'claude --verbose'), '__TB_CODEX_REF__:p:m');
}
assert.deepEqual(desktop.parseModelRef('  __TB_CODEX_REF__:p:vendor/model:variant --resume'), { providerId: 'p', modelId: 'vendor/model:variant' });
assert.deepEqual(desktop.parseModelRef('__TB_CLAUDE_REF__:p:claude-model'), { providerId: 'p', modelId: 'claude-model' });
for (const command of ['codex', '__TB_CODEX_REF__:missing', '__TB_CODEX_REF__::model', '__TB_CODEX_REF__:p:']) {
  assert.equal(desktop.parseCodexRef(command), null);
}
console.log('PASS: 桌面与手机 Codex 引用、参数继承、冲突配置剔除及模型标签解析');
