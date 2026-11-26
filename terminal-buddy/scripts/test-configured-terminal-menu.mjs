import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
function load(file, mocks, windowMock = {}) {
  const { outputText } = ts.transpileModule(readFileSync(new URL('../' + file, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
    fileName: file,
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'window', outputText)(name => {
    if (Object.hasOwn(mocks, name)) return mocks[name];
    if (name.endsWith('.css')) return {};
    if (name.startsWith('.')) throw new Error('Missing mock: ' + name);
    return require(name);
  }, module, module.exports, windowMock);
  return module.exports;
}
function hooks() {
  let index = 0;
  const values = [];
  return {
    begin() { index = 0; },
    useState(initial) {
      const current = index++;
      if (!(current in values)) values[current] = typeof initial === 'function' ? initial() : initial;
      return [values[current], value => { values[current] = typeof value === 'function' ? value(values[current]) : value; }];
    },
    useRef(initial) { return values[index++] ??= { current: initial }; },
    useMemo: factory => factory(),
    useCallback: callback => callback,
    useEffect() {},
    useLayoutEffect() {},
  };
}
function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== 'object') return [];
  return [tree, ...nodes(tree.props?.children)];
}
const Noop = () => null;
const TreeView = Noop;
const ProjectLaunchMenuItems = () => null;
const profile = { id: 'alpha-config', name: '开发终端', group: 'Alpha', terminalType: 'cmd', startupCommands: [] };
const pinnedProfile = { ...profile, id: 'pinned-config', name: '置顶终端', pinned: true };
const state = {
  projects: [{ name: 'Beta', path: 'D:\beta' }, { name: 'Alpha', path: 'D:\alpha' }],
  profiles: [profile, pinnedProfile], sessions: [], agentTabs: [],
  gitChangesTab: null, gitHistoryTab: null, claudeReplayTabs: [], scheduledTasksTabOpen: false,
  selectedProfileId: null, configPanelVisible: true, configSearchQuery: '不匹配的旧搜索',
  lastClickRegion: 'config',
  setLastClickRegion(value) { state.lastClickRegion = value; },
};
const useAppStore = selector => selector(state);
useAppStore.getState = () => state;
const menuReact = hooks();
const hoverTimers = new Map();
let timerId = 0;
const windowMock = {
  innerWidth: 1200, innerHeight: 800,
  setTimeout(callback) { hoverTimers.set(++timerId, callback); return timerId; },
  clearTimeout(id) { hoverTimers.delete(id); },
};
const { ConfiguredTerminalMenuItem, NewTerminalMenu } = load('src/components/shell/NewTerminalMenu.tsx', {
  react: menuReact,
  '../../services/platform': { defaultShellType: () => 'cmd', serverUsesWindowsPaths: () => true },
  '../../services/tauri': {},
  '../../stores/appStore': { useAppStore },
  '../../utils/settings': {},
  '../file-explorer/TreeView': { TreeView },
  '../shared/ProjectLaunchMenuItems': { ProjectLaunchMenuItems },
}, windowMock);
const configReact = hooks();
const launches = [];
const { ConfigNav } = load('src/components/profile-config/ConfigNav.tsx', {
  react: configReact,
  '../../stores/appStore': { useAppStore },
  '../../services/tauri': {}, '../../utils/openTerminalInDir': {},
  '../../utils/contextMenu': {}, '../../utils/terminalResizeEvent': {},
  '../../utils/codexLaunch': {}, '../../utils/claudeLaunch': {}, '../../utils/agentCommands': {},
  '../file-explorer/TreeView': { TreeView }, '../shared/Dialog': {},
  '../shared/ClaudeModelMenuSection': {}, '../shared/ProjectContextMenu': {},
  '../shared/ProjectEditDialog': {}, '../shared/ProjectDeleteDialog': {},
  './ProjectTasksView': { ProjectTasksView: () => null },
  '../shell/NewTerminalMenu': { ConfiguredTerminalMenuItem },
  '../../hooks/useSessionCloseActions': { useSessionCloseActions: () => ({}) },
  '../../utils/projectPath': {},
  '../../services/platform': { isDockerClient: () => false, serverUsesWindowsPaths: () => true, defaultShellType: () => 'cmd' },
});
const renderConfig = (experimentalProjectTasks = true) => {
  configReact.begin();
  return ConfigNav({
    isActive: true, isSidebarMode: true, experimentalProjectTasks, startupRestoreComplete: true,
    onStartTerminal: (...args) => launches.push(args), onAddProfile: Noop,
    onStartBlankTerminal: Noop, onStartTextEditor: Noop,
  });
};
const contextEvent = { clientX: 30, clientY: 40, preventDefault() {}, target: { closest: () => null } };
let config = renderConfig();
assert.equal(nodes(config).some(node => node.type === ConfiguredTerminalMenuItem), false);
nodes(config).find(node => node.props?.className === 'config-nav-list').props.onContextMenu(contextEvent);
config = renderConfig();
let entry = nodes(config).find(node => node.type === ConfiguredTerminalMenuItem);
assert.ok(entry, '项目与任务空白处右键提供新建配置终端');
assert.deepEqual(entry.props.submenuTree.map(item => item.id), ['__pinned__', 'Alpha', 'Beta']);
assert.deepEqual(entry.props.submenuTree.find(item => item.id === 'Alpha').children.map(item => item.id), [profile.id]);
assert.deepEqual(entry.props.submenuTree[0].children.map(item => item.id), [pinnedProfile.id]);
assert.ok(nodes(config).some(node => node.props?.children === '添加配置'));
assert.ok(nodes(config).some(node => node.props?.children === '添加项目'));
console.log('PASS: 项目与任务空白菜单恢复配置终端入口，保留项目、置顶及添加入口，不受隐藏搜索条件影响');

entry.props.onToggleGroup('Alpha');
config = renderConfig();
entry = nodes(config).find(node => node.type === ConfiguredTerminalMenuItem);
assert.ok(entry.props.expandedGroups.has('Alpha'));
const renderEntry = () => { menuReact.begin(); return ConfiguredTerminalMenuItem(entry.props); };
let menu = renderEntry();
assert.ok(nodes(menu).some(node => node.props?.children === '新建配置终端'));
menu.props.onMouseEnter({ currentTarget: { getBoundingClientRect: () => ({ right: 300, left: 100, top: 40 }) } });
menu = renderEntry();
assert.equal(nodes(menu).find(node => node.props?.className === 'context-submenu new-terminal-profile-menu').props.style.left, 300);
const tree = nodes(menu).find(node => node.type === TreeView);
const alpha = entry.props.submenuTree.find(item => item.id === 'Alpha');
assert.equal(tree.props.renderEnd(alpha).props['data-project-id'], 'Alpha');
nodes(menu).find(node => node.props?.className === 'new-terminal-profile-scroll').props.onMouseOver({
  target: { closest: () => ({
    querySelector: () => ({ dataset: { projectId: 'Alpha' } }),
    getBoundingClientRect: () => ({ top: 60, bottom: 90 }),
  }) },
});
for (const callback of hoverTimers.values()) callback();
hoverTimers.clear();
menu = renderEntry();
const projectMenu = nodes(menu).find(node => node.type === ProjectLaunchMenuItems);
assert.equal(projectMenu.props.project, state.projects[1]);
console.log('PASS: 配置树可展开，项目悬停复用原有命令行与 Agent 启动菜单');

tree.props.onSelect(alpha.children[0]);
assert.equal(launches.length, 1);
assert.equal(launches[0][0], profile);
assert.equal(state.lastClickRegion, 'tab');
assert.equal(nodes(renderConfig()).some(node => node.type === ConfiguredTerminalMenuItem), false, '选择配置后关闭菜单');
console.log('PASS: 选择已有配置启动终端、激活会话区域并关闭菜单');

config = renderConfig(false);
nodes(config).find(node => node.props?.className === 'config-nav-list').props.onContextMenu(contextEvent);
assert.equal(nodes(renderConfig(false)).some(node => node.type === ConfiguredTerminalMenuItem), false, '原有项目与命令模式保持原菜单');
const legacyMenu = NewTerminalMenu({
  x: 0, y: 0, ...entry.props, highlightedIndex: 2, visibleSubmenuItems: [profile],
  onStartBlankTerminal: Noop, onStartTextEditor: Noop, onCloseAllTabs: Noop,
});
const legacyEntry = nodes(legacyMenu).find(node => node.type === ConfiguredTerminalMenuItem);
assert.ok(legacyEntry);
assert.equal(legacyEntry.props.highlightedIndex, 2);
assert.equal(legacyEntry.props.submenuTree, entry.props.submenuTree);
assert.ok(nodes(legacyMenu).some(node => node.props?.children === '关闭所有选项卡'));
console.log('PASS: 原会话标签菜单继续复用相同配置入口并保留快捷操作和键盘导航参数');
