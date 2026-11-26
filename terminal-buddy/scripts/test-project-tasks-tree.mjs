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
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
    fileName: filename,
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
  new Function('require', 'module', 'exports', 'document', outputText)(mockedRequire, module, module.exports, { body: {} });
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

// 1. 置顶配置在 pinnedProfiles 中聚合，并保留原项目中的配置入口
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
assert.deepEqual(alpha.profiles.map(p => p.id), ['p1', 'p2']);
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

// 最近列表只展示已启动会话，配置即使用过也不加入列表。
const recentProfiles = [
  { ...profiles[0], lastUsedAt: '2026-11-26T10:05:00Z' },
  { ...profiles[0], id: 'used-script', name: '构建脚本', lastUsedAt: '2026-11-26T10:03:00Z' },
  { ...profiles[1], id: 'pinned-script', name: '置顶脚本', lastUsedAt: '2026-11-26T10:01:00Z' },
  { ...profiles[0], id: 'unused-script', lastUsedAt: null },
  { ...profiles[0], id: 'invalid-time', lastUsedAt: 'invalid-date' },
];
const recentSessions = [
  { ...sessions[0], createdAt: Date.parse('2026-11-26T10:02:00Z') },
  { ...sessions[2] },
  { ...sessions[3], createdAt: Date.parse('2026-11-26T09:00:00Z') },
];
const recentAgentTabs = [
  { ...agentTabs[0], openedAt: Date.parse('2026-11-26T10:04:00Z') },
  agentTabs[1],
];
const recentInput = {
  projects, profiles: recentProfiles, sessions: recentSessions, agentTabs: recentAgentTabs,
  tabGroups, gitChangesTab, gitHistoryTab, taskSummaries,
};
const snapshot = JSON.stringify(recentInput);
const recentModel = buildProjectTasksTree(recentInput);
const recentKey = item => item.kind === 'terminal' ? `terminal:${item.session.id}`
  : `agent:${item.tab.key}`;
assert.deepEqual(recentModel.recentItems.map(recentKey), [
  'agent:agent:1', 'terminal:s1', 'terminal:s3',
]);
assert.equal(JSON.stringify(recentInput), snapshot);
console.log('PASS: 最近只显示已启动终端与原生 AI 会话，不包含配置或编辑器，按时间倒序排列');

// 配置名称不会产生最近条目，项目名和会话摘要仍可命中运行会话。
assert.deepEqual(
  buildProjectTasksTree({ ...recentInput, searchQuery: '构建脚本' }).recentItems.map(recentKey),
  [],
);
assert.deepEqual(
  buildProjectTasksTree({ ...recentInput, searchQuery: '重构侧边栏' }).recentItems.map(recentKey),
  ['terminal:s1'],
);
assert.deepEqual(
  buildProjectTasksTree({ ...recentInput, searchQuery: 'beta' }).recentItems.map(recentKey),
  ['agent:agent:1'],
);
assert.deepEqual(
  buildProjectTasksTree({ ...recentInput, searchQuery: '不存在的内容' }).recentItems,
  [],
);
console.log('PASS: 最近列表按运行会话搜索，不因配置匹配而添加启动入口');

// 关闭会话后直接移除条目，不回退成配置启动入口。
const closedModel = buildProjectTasksTree({
  ...recentInput, sessions: recentSessions.filter(session => session.id !== 's1'),
});
assert.deepEqual(closedModel.recentItems.map(recentKey), ['agent:agent:1', 'terminal:s3']);
const startingModel = buildProjectTasksTree({
  ...recentInput, sessions: recentSessions.map(session => session.id === 's1' ? { ...session, starting: true } : session),
});
assert.deepEqual(startingModel.recentItems.map(recentKey), ['agent:agent:1', 'terminal:s3']);
console.log('PASS: 已关闭会话和启动占位不显示，不会回退为配置条目');

const pinnedModel = buildProjectTasksTree({
  ...recentInput,
  sessions: recentSessions.map(session => session.id === 's1' ? { ...session, pinned: true } : session),
  agentTabs: recentAgentTabs.map(tab => tab.shape === 'native' ? { ...tab, pinned: true } : tab),
});
assert.deepEqual(pinnedModel.pinnedSessions.map(item => item.kind === 'terminal' ? item.session.id : item.tab.key), ['s1', 'agent:1']);
assert.deepEqual(pinnedModel.pinnedProfiles.map(profile => profile.id), ['pinned-script']);
assert.deepEqual(pinnedModel.recentItems.map(recentKey), ['terminal:s3']);
assert.equal(pinnedModel.openSessionCount, recentModel.openSessionCount);
assert.ok(pinnedModel.groups.some(group => group.sessions.some(item => item.kind === 'terminal' && item.session.id === 's1')));
const pinSearch = buildProjectTasksTree({
  ...recentInput, sessions: [{ ...recentSessions[0], pinned: true }], searchQuery: '重构侧边栏',
});
assert.deepEqual(pinSearch.pinnedSessions.map(item => item.session.id), ['s1']);
console.log('PASS: 置顶支持会话、原生 AI 与脚本，最近列表不重复展示置顶项，项目归属和计数保持正确');

// 直接驱动组件事件，验证重复列表只高亮当前点击位置，不需要浏览器或真实终端。
let hookIndex = 0;
const hookState = [];
const useState = initial => {
  const index = hookIndex++;
  if (!(index in hookState)) hookState[index] = typeof initial === 'function' ? initial() : initial;
  return [hookState[index], value => {
    hookState[index] = typeof value === 'function' ? value(hookState[index]) : value;
  }];
};
const viewState = {
  ...recentInput, groups: tabGroups, activeSessionId: 's1', selectedProfileId: null,
  gitHistoryTab, gitChangesTab, claudeReplayTab: null, claudeReplayTabs: [],
  activeSpecialTab: null, scheduledTasksTabOpen: false, activeAgentTabKey: null,
  terminalActivities: {}, terminalWebTakeovers: {}, lastClickRegion: 'tab', splitMode: 'off',
  setLastClickRegion: value => { viewState.lastClickRegion = value; },
  selectProfile: value => { viewState.selectedProfileId = value; },
  setActiveSession: value => { viewState.activeSessionId = value; viewState.activeSpecialTab = null; },
  setActiveAgentTab: value => { viewState.activeAgentTabKey = value; viewState.activeSpecialTab = 'agent-chat'; },
  updateSession: (id, patch) => { viewState.sessions = viewState.sessions.map(item => item.id === id ? { ...item, ...patch } : item); },
  updateAgentTab: (key, patch) => { viewState.agentTabs = viewState.agentTabs.map(item => item.key === key ? { ...item, ...patch } : item); },
};
const useViewStore = selector => selector(viewState);
useViewStore.getState = () => viewState;
const Noop = () => null;
const { ProjectTasksView } = load('src/components/profile-config/ProjectTasksView.tsx', {
  react: { useState, useMemo: callback => callback(), useRef: value => ({ current: value }), useEffect: () => {} },
  'react-dom': { createPortal: children => children },
  '../../services/platform': { isDockerClient: () => false },
  '../../stores/appStore': { useAppStore: useViewStore },
  '../../stores/taskSummaryStore': { useTaskSummaryStore: selector => selector({ summaries: taskSummaries, providers: {} }) },
  '../../utils/projectTasksTree': { buildProjectTasksTree, EDITOR_GROUP_ID: '__editors__', PINNED_GROUP_ID: '__pinned__' },
  '../../utils/claudeIndicator': {
    getIndicatorClassName: () => '', getIndicatorColor: () => '#55b988', getIndicatorTitle: () => '',
    getNativeAgentLight: () => 'idle', getIndicatorLight: () => 'idle',
  },
  '../../utils/formatDuration': { formatDuration: () => '' },
  '../../utils/taskLaunchInfo': { getTaskLaunchInfo: () => undefined },
  '../agent-chat/AgentIcon': { AgentIcon: Noop },
  '../shell/AgentTabContextMenu': { AgentTabContextMenu: Noop },
  '../shell/SessionTaskLabel': { SessionTaskLabel: Noop },
  '../shell/TabContextMenu': { TabContextMenu: Noop },
  '../../utils/visibility': { onPageVisible: () => () => {} },
  '../file-explorer/TreeView.css': {}, '../shell/TabNav.css': {},
});
let profileLaunches = 0;
const viewProps = {
  isActive: true, searchQuery: '', renamingProfileId: null, renamingProfileName: '',
  onRenamingProfileChange: Noop, onRenamingProfileSubmit: Noop, onRenamingProfileCancel: Noop,
  onStartTerminal: () => { profileLaunches += 1; }, onProfileContextMenu: Noop, onGroupContextMenu: Noop,
  onCloseSession: Noop, onCloseGroup: Noop, onCloseExternalMenus: Noop,
};
const renderView = () => {
  hookIndex = 0;
  return ProjectTasksView({ ...viewProps, selectedProfileId: viewState.selectedProfileId });
};
const nodes = node => {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!node || typeof node !== 'object') return [];
  return [node, ...nodes(node.props?.children)];
};
const selectedRows = tree => nodes(tree).filter(node => /\b(tree-item|tab-nav-settings-btn)\b/.test(node.props?.className ?? '')
  && /\b(active|selected)\b/.test(node.props.className));
const mouseDown = { button: 0, stopPropagation() {} };
const selectSection = (tree, section) => tree.props.onMouseDownCapture({
  button: 0, target: { closest: () => ({ dataset: { taskSection: section } }) },
});
const recentRow = (tree, key) => nodes(nodes(tree).find(node => node.props?.id === 'project-tasks-recent-list'))
  .find(node => node.key === key && /\btree-item\b/.test(node.props?.className ?? ''));
const clickProject = (tree, name) => {
  selectSection(tree, 'projects');
  const row = nodes(tree).find(node => /\bproject-tasks-project-header\b/.test(node.props?.className ?? '')
    && nodes(node).some(child => child.props?.className === 'tree-group-name' && child.props.children === name));
  row.props.onMouseDown(mouseDown);
  row.props.onClick();
};
let view = renderView();
clickProject(view, 'Alpha');
view = renderView();
assert.equal(selectedRows(view).length, 1);
const initiallyExpandedProjectList = nodes(view).find(node => node.props?.id === 'project-tasks-project-list');
const initiallyVisibleProfiles = nodes(initiallyExpandedProjectList)
  .filter(node => /\bproject-tasks-profile-item\b/.test(node.props?.className ?? '')).map(node => node.key);
assert.ok(initiallyVisibleProfiles.includes('p1'), '展开项目应直接显示原有配置');
assert.ok(initiallyVisibleProfiles.includes('pinned-script'), '置顶配置应保留原项目中的入口');
clickProject(view, 'Beta');
view = renderView();
assert.equal(selectedRows(view).length, 1);
assert.ok(nodes(selectedRows(view)[0]).some(node => node.props?.children === 'Beta'));
selectSection(view, 'recent');
recentRow(view, 's1').props.onMouseDown(mouseDown);
recentRow(view, 's1').props.onClick();
view = renderView();
assert.equal(selectedRows(view).length, 1);
assert.equal(selectedRows(view)[0].key, 's1');
assert.equal(recentRow(view, 'used-script'), undefined);
selectSection(view, 'projects');
const configurationList = nodes(view).find(node => node.props?.id === 'project-tasks-project-list');
const configuredScript = nodes(configurationList).find(node => node.key === 'used-script');
configuredScript.props.onMouseDown(mouseDown);
configuredScript.props.onClick();
view = renderView();
assert.equal(selectedRows(view).length, 1);
assert.equal(selectedRows(view)[0].key, 'used-script');
assert.equal(profileLaunches, 0);
viewState.scheduledTasksTabOpen = true;
viewState.activeSpecialTab = 'scheduled-tasks';
view = renderView();
assert.equal(selectedRows(view).length, 1);
assert.equal(selectedRows(view)[0].key, 'used-script');
console.log('PASS: 项目单选与最近会话高亮互斥，最近没有配置启动入口');

selectSection(view, 'recent');
recentRow(view, 's1').props.onMouseDown(mouseDown);
recentRow(view, 's1').props.onClick();
recentRow(view, 's1').props.onContextMenu({ preventDefault() {}, stopPropagation() {} });
view = renderView();
const terminalMenu = nodes(view).find(node => node.props?.sessionId === 's1' && node.props.onTogglePin);
terminalMenu.props.onTogglePin(viewState.sessions.find(session => session.id === 's1'));
terminalMenu.props.onClose();
view = renderView();
assert.equal(recentRow(view, 's1'), undefined);
assert.equal(selectedRows(view).length, 1);
assert.equal(selectedRows(view)[0].key, 's1');
assert.ok(viewState.sessions.find(session => session.id === 's1').pinned);
console.log('PASS: 会话置顶后显示在置顶分组，最近列表移除重复项，仍只有一个选中背景');

selectSection(view, 'projects');
const projectList = nodes(view).find(node => node.props?.id === 'project-tasks-project-list');
nodes(projectList).find(node => node.props?.className === 'tree-item project-tasks-config-group').props.onClick();
view = renderView();
const collapsedProjectList = nodes(view).find(node => node.props?.id === 'project-tasks-project-list');
assert.ok(!nodes(collapsedProjectList).some(node => node.key === 'used-script'));
clickProject(view, 'Alpha');
view = renderView();
clickProject(view, 'Alpha');
view = renderView();
const reopenedProjectList = nodes(view).find(node => node.props?.id === 'project-tasks-project-list');
assert.ok(!nodes(reopenedProjectList).some(node => node.key === 'used-script'), '手动收起配置后，重开项目应保留折叠状态');
nodes(reopenedProjectList).find(node => node.props?.className === 'tree-item project-tasks-config-group').props.onClick();
view = renderView();
const expandedProjectList = nodes(view).find(node => node.props?.id === 'project-tasks-project-list');
nodes(expandedProjectList).find(node => node.key === 'used-script' && /\bproject-tasks-profile-item\b/.test(node.props?.className ?? '')).props.onDoubleClick();
assert.equal(profileLaunches, 1);
console.log('PASS: 展开项目默认显示全部配置，置顶配置保留项目入口，并支持手动折叠及恢复');
console.log('PASS: 项目配置仍可显式启动，最近列表只切换已有会话');
