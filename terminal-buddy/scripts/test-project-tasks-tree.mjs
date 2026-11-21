import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

function load(file, mocks = {}) {
  const filename = path.join(root, file);
  const source = fs.readFileSync(filename, 'utf8')
    .replace(/import\.meta\.env\.DEV/g, 'false')
    .replace(/import\.meta\.env/g, '({})');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: filename,
  });
  const module = { exports: {} };
  const mockedRequire = name => {
    if (Object.hasOwn(mocks, name)) return mocks[name];
    if (name.endsWith('services/platform')) {
      return { serverUsesWindowsPaths: () => true };
    }
    if (name.startsWith('.')) throw new Error('Missing mock: ' + name);
    return require(name);
  };
  new Function('require', 'module', 'exports', outputText)(mockedRequire, module, module.exports);
  return module.exports;
}

const projectPath = load('src/utils/projectPath.ts');
const { buildProjectTasksTree, projectConfigGroupId } = load('src/utils/projectTasksTree.ts', {
  './projectPath': projectPath,
});

const projects = [
  { name: 'Alpha', path: 'D:\\work\\alpha' },
  { name: 'Beta', path: 'D:\\work\\beta' },
];

const profiles = [
  { id: 'p1', name: 'Alpha Dev', group: 'Alpha', terminalType: 'powershell', startupPath: '', startupCommands: [], environmentVariables: {}, colorTheme: 'dark-default', tabColor: null, windowSize: null, createdAt: '', lastUsedAt: null },
  { id: 'p2', name: 'Alpha Pinned', group: 'Alpha', terminalType: 'cmd', startupPath: '', startupCommands: [], environmentVariables: {}, colorTheme: 'dark-default', tabColor: null, windowSize: null, createdAt: '', lastUsedAt: null, pinned: true },
];

const sessions = [
  { id: 's1', profileId: 'p1', profileName: 'Alpha Dev', terminalType: 'powershell', colorTheme: { background: '#000', foreground: '#fff' }, tabColor: null, groupId: 'default' },
  { id: 's2', profileId: 'p2', profileName: 'Alpha Pinned', terminalType: 'cmd', colorTheme: { background: '#000', foreground: '#fff' }, tabColor: null, groupId: 'default' },
  { id: 's3', profileId: '', profileName: 'PowerShell', terminalType: 'powershell', colorTheme: { background: '#000', foreground: '#fff' }, tabColor: null, groupId: 'default' },
  { id: 's4', profileId: '', profileName: 'notes.md', terminalType: 'editor', sessionType: 'editor', colorTheme: { background: '#000', foreground: '#fff' }, tabColor: null, groupId: '文本编辑' },
  { id: 's5', profileId: '', profileName: 'Moved Session', terminalType: 'powershell', colorTheme: { background: '#000', foreground: '#fff' }, tabColor: null, groupId: 'g-beta' },
];

const tabGroups = [{ id: 'g-beta', name: 'Beta', collapsed: false }];
const agentTabs = [
  { key: 'agent:1', shape: 'native', sessionId: '1', title: 'Fix bug', provider: 'claude', projectPath: 'D:\\work\\beta\\sub', openedAt: 1 },
  { key: 'relay:s1', shape: 'relay', terminalId: 's1', title: 'Relay view', provider: 'claude', openedAt: 2 },
];
const gitChangesTab = { repoRoot: 'D:\\work\\alpha', branch: 'main' };
const gitHistoryTab = { repoRoot: 'D:\\work\\beta', branch: 'main' };
const taskSummaries = {
  s1: { provider: 'claude', sessionId: 'c1', summary: '重构侧边栏' },
};

const model = buildProjectTasksTree({
  projects,
  profiles,
  sessions,
  agentTabs,
  tabGroups,
  gitChangesTab,
  gitHistoryTab,
  taskSummaries,
});

// 1. 置顶配置抽离到 pinnedProfiles，不进入项目配置分组
assert.deepEqual(model.pinnedProfiles.map(p => p.id), ['p2']);
// 2. 编辑器会话归入 editorSessions
assert.deepEqual(model.editorSessions.map(s => s.id), ['s4']);
// 3. 打开会话总数 = sessions.length (5) + native agentTabs (1) = 6，不包含 relay
assert.equal(model.openSessionCount, 6);

// 4. 项目分组及各自的配置与会话
const alpha = model.groups.find(g => g.id === 'Alpha');
const beta = model.groups.find(g => g.id === 'Beta');
const def = model.groups.find(g => g.id === '默认');

assert.ok(alpha && beta && def);
assert.equal(alpha.configGroupId, projectConfigGroupId('Alpha'));
assert.deepEqual(alpha.profiles.map(p => p.id), ['p1']);
assert.deepEqual(
  alpha.sessions.map(leaf => (leaf.kind === 'terminal' ? leaf.session.id : leaf.kind)),
  ['git-changes', 's1', 's2'],
);

// Beta 无配置（profiles 为空，不渲染「配置」分组），但承载移动来的终端、原生 AI 会话和 Git 历史
assert.equal(beta.profiles.length, 0);
assert.deepEqual(
  beta.sessions.map(leaf => (leaf.kind === 'terminal' ? leaf.session.id : leaf.kind === 'agent' ? leaf.tab.key : leaf.kind)),
  ['git-history', 's5', 'agent:1'],
);

// 空白终端自动落入「默认」分组
assert.equal(def.profiles.length, 0);
assert.deepEqual(def.sessions.map(leaf => (leaf.kind === 'terminal' ? leaf.session.id : '')), ['s3']);
console.log('PASS: 项目分组、配置子分组、置顶与各类型会话归类');

// 4b. 旧版 Web/App 会话把 canonicalize scope key 当项目路径：`//?/d:/...` 仍要归到项目
const legacyModel = buildProjectTasksTree({
  projects,
  profiles: [],
  sessions: [],
  agentTabs: [
    { key: 'agent:legacy-slashed', shape: 'native', sessionId: 'l1', title: '旧会话 1', provider: 'claude', projectPath: '//?/d:/work/beta/sub', openedAt: 1 },
    { key: 'agent:legacy-verbatim', shape: 'native', sessionId: 'l2', title: '旧会话 2', provider: 'claude', projectPath: '\\\\?\\D:\\work\\alpha', openedAt: 2 },
  ],
  tabGroups: [],
  gitChangesTab: null,
  gitHistoryTab: null,
  taskSummaries: {},
});
const legacyAlpha = legacyModel.groups.find(g => g.id === 'Alpha');
const legacyBeta = legacyModel.groups.find(g => g.id === 'Beta');
assert.ok(legacyAlpha && legacyBeta);
assert.deepEqual(
  legacyAlpha.sessions.map(leaf => (leaf.kind === 'agent' ? leaf.tab.key : leaf.kind)),
  ['agent:legacy-verbatim'],
);
assert.deepEqual(
  legacyBeta.sessions.map(leaf => (leaf.kind === 'agent' ? leaf.tab.key : leaf.kind)),
  ['agent:legacy-slashed'],
);
console.log('PASS: 旧版 //?/ 与 \\\\?\\ 项目路径仍按项目归类');

// 5. 搜索过滤：按任务摘要命中 Alpha 的会话
const searchBySummary = buildProjectTasksTree({
  projects,
  profiles,
  sessions,
  agentTabs,
  tabGroups,
  gitChangesTab,
  gitHistoryTab,
  taskSummaries,
  searchQuery: '重构侧边栏',
});
assert.deepEqual(searchBySummary.groups.map(g => g.id), ['Alpha']);
assert.equal(searchBySummary.groups[0].profiles.length, 0);
assert.deepEqual(
  searchBySummary.groups[0].sessions.map(leaf => (leaf.kind === 'terminal' ? leaf.session.id : '')),
  ['s1'],
);

// 6. 搜索过滤：按项目名命中时保留该项目下全部配置和会话
const searchByProject = buildProjectTasksTree({
  projects,
  profiles,
  sessions,
  agentTabs,
  tabGroups,
  gitChangesTab,
  gitHistoryTab,
  taskSummaries,
  searchQuery: 'beta',
});
assert.deepEqual(searchByProject.groups.map(g => g.id), ['Beta']);
assert.equal(searchByProject.groups[0].sessions.length, 3);
console.log('PASS: 搜索过滤按项目名、配置名、会话名与任务摘要生效');
