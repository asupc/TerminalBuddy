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
const codex = load('src/utils/codexLaunch.ts', { './claudeLaunch': claude });
const id = '019f0000-0000-7000-8000-000000000001';
assert.equal(codex.buildCodexResumeCommand(id), `codex resume ${id}`);
assert.equal(codex.buildCodexResumeCommand(id, 'claude --dangerously-skip-permissions'), `codex resume ${id}`);
assert.equal(codex.buildCodexResumeCommand(id, 'codex --sandbox read-only resume old-id --last'), `codex --sandbox read-only resume ${id}`);
assert.equal(codex.buildCodexResumeCommand(id, 'codex --model old --cd "D:/old dir" -i old.png --sandbox workspace-write; echo after'), `codex --model old --sandbox workspace-write resume ${id}`);
assert.equal(codex.buildCodexResumeCommand(id, 'codex -c \'name="some; value"\' --sandbox read-only'), `codex -c 'name="some; value"' --sandbox read-only resume ${id}`);
assert.equal(codex.buildCodexResumeCommand(id, '__TB_CODEX_REF__:p:old --sandbox read-only', { providerId: 'new', modelId: 'gpt-codex' }), `__TB_CODEX_REF__:new:gpt-codex --sandbox read-only resume ${id}`);
assert.equal(codex.buildCodexResumeCommand(id, 'codex --model=old -p other -c \'name="some; value"\' --sandbox read-only', { providerId: 'new', modelId: 'gpt-codex' }), `__TB_CODEX_REF__:new:gpt-codex --sandbox read-only resume ${id}`);
assert.equal(codex.buildCodexResumeCommand(id, undefined, { providerId: 'new', modelId: 'gpt-codex' }), `__TB_CODEX_REF__:new:gpt-codex resume ${id}`);
assert.equal(codex.buildCodexResumeCommand(id, 'codex --last'), `codex resume ${id}`);
assert.throws(() => codex.buildCodexResumeCommand('x; echo unsafe'), /ID/);
assert.equal(codex.resumedCodexSessionId(`claude resume ${id}`), undefined);
assert.equal(codex.resumedCodexSessionId(`__TB_CODEX_REF__:p:m resume ${id}`), id);

const platform = { serverUsesWindowsPaths: () => false, defaultShellType: () => 'bash', clientTerminalOwner: () => 'web' };
const paths = load('src/utils/projectPath.ts', { '../services/platform': platform });
const types = load('src/types/index.ts');
let state;
let launched;
let focused;
let directory;
const starts = [];
const profile = (profileId, path, command, type = 'bash') => ({
  id: profileId, startupPath: path, startupCommands: [command], terminalType: type,
  group: '', colorTheme: 'dark-default', tabColor: null,
});
const store = { getState: () => state };
const resume = load('src/components/claude-history/resumeCodexSession.ts', {
  '../../services/tauri': {
    startTerminal: async (...args) => { starts.push(['profile', ...args]); return 'new-terminal'; },
    startBlankTerminal: async (...args) => { starts.push(['blank', ...args]); return 'new-terminal'; },
    updateProfileLastUsed: async () => {},
  },
  '../../services/sessionRestore': { launchTerminalSession: async options => {
    launched = options.makeSession('starting');
    const terminalId = await options.start(30, 100);
    options.onStarted(terminalId);
  } },
  '../../services/platform': platform,
  '../../utils/projectPath': paths,
  '../../utils/claudeLaunch': claude,
  '../../utils/codexLaunch': codex,
  '../../types': types,
  '../../stores/appStore': { useAppStore: store },
  './resumeClaudeSession': { focusTerminalById: terminalId => { focused = terminalId; } },
});
state = {
  projects: [], sessions: [], profiles: [profile('other', '/other', 'codex'), profile('claude', '/work', 'claude'), profile('remote', '/work', 'codex', 'ssh')],
  setSessionDirectory: (...args) => { directory = args; }, addSession() {}, resolveStartingSession() {}, setAgentSessionBinding() {},
};
assert.equal(resume.pickCodexProfile(state.profiles, '/work/app'), undefined);
await resume.resumeCodexSession({ sessionId: id, title: '测试会话', projectDir: '/work/app' });
assert.equal(starts[0][0], 'blank');
assert.equal(starts[0][1], 'bash');
assert.equal(starts[0][4], '/work/app');
// 无匹配 profile 时用内置默认命令（跳过审批与沙箱）恢复会话。
const defaultResume = `codex --dangerously-bypass-approvals-and-sandbox resume ${id}`;
assert.equal(starts[0][6], defaultResume);
assert.equal(launched.extraParams, defaultResume);
assert.equal(launched.extraParamMode, 'independent');
assert.deepEqual(directory, ['new-terminal', '/work/app']);
state.profiles.push(profile('parent', '/work', 'codex --sandbox read-only'), profile('closest', '/work/app', 'codex --model old --sandbox workspace-write'));
assert.equal(resume.pickCodexProfile(state.profiles, '/work/app/child').id, 'closest');
await resume.resumeCodexSession({ sessionId: id, title: '继续工作', projectDir: '/work/app/child' }, { name: '预设', params: '--no-alt-screen', tagColor: null });
assert.equal(starts[1][0], 'profile');
assert.equal(starts[1][1], 'closest');
assert.equal(starts[1][2], `codex --model old --sandbox workspace-write resume ${id} --no-alt-screen`);
assert.equal(starts[1][6], '/work/app/child');
assert.equal(starts[1][9], 'independent');
state.sessions.push({ id: 'existing', extraParamMode: 'independent', extraParams: `codex resume ${id}` });
await resume.resumeCodexSession({ sessionId: id, title: '已运行', projectDir: '/work' });
assert.equal(focused, 'existing');
assert.equal(starts.length, 2);
await assert.rejects(() => resume.resumeCodexSession({ sessionId: 'other-id', title: '未知目录', projectDir: '' }), /工作目录/);

const keys = load('src/utils/sessionHistory.ts');
const { createProfilesSlice } = load('src/stores/slices/profilesSlice.ts', {
  '../../utils/sessionHistory': keys,
  '../../utils/settings': { getAppSettings: () => ({}), saveAppSettings() {} },
});
let tabs = {};
const set = patch => { tabs = { ...tabs, ...(typeof patch === 'function' ? patch(tabs) : patch) }; };
tabs = createProfilesSlice(set);
tabs.openClaudeReplayTab({ sessionId: 'same-id', title: 'Claude' });
tabs.openClaudeReplayTab({ sessionId: 'same-id', provider: 'codex', title: 'Codex' });
assert.equal(tabs.claudeReplayTabs.length, 2);
tabs.closeClaudeReplayTab('same-id', 'codex');
assert.equal(tabs.claudeReplayTabs.length, 1);
assert.equal(tabs.claudeReplayTab.title, 'Claude');
tabs.openClaudeReplayTab({ sessionId: 'same-id', provider: 'claude', title: 'Claude 新标题' });
assert.equal(tabs.claudeReplayTabs.length, 1);
tabs.closeClaudeReplayTab();
assert.equal(tabs.activeSpecialTab, null);
console.log('PASS: Codex 恢复命令、目录与权限参数、同项目配置选择、运行中会话聚焦、双来源回放隔离');
