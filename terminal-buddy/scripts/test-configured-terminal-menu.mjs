import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const portalBody = {};
class TestElement {
  constructor(className) { this.className = className; }
  closest(selectors) {
    return selectors.split(',').some(selector => this.className.split(' ').includes(selector.trim().slice(1))) ? this : null;
  }
}
function load(file, mocks, windowMock = {}) {
  const { outputText } = ts.transpileModule(readFileSync(new URL('../' + file, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
    fileName: file,
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'window', 'document', 'Element', outputText)(name => {
    if (Object.hasOwn(mocks, name)) return mocks[name];
    if (name.endsWith('.css')) return {};
    if (name.startsWith('.')) throw new Error('Missing mock: ' + name);
    return require(name);
  }, module, module.exports, windowMock, { body: portalBody }, TestElement);
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
  projects: [{ name: 'Beta', path: 'D:\\beta' }, { name: 'Alpha', path: 'D:\\alpha' }],
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
  'react-dom': { createPortal: (children, target) => ({ type: 'portal', props: { children, target } }) },
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
const trigger = tree => nodes(tree).find(node => node.props?.className?.includes('configured-terminal-menu-item'));
const anchorEvent = {
  currentTarget: { getBoundingClientRect: () => ({ right: 300, left: 100, top: 40 }) },
  stopPropagation() {},
};
assert.ok(nodes(menu).some(node => node.props?.children === '新建配置终端'));
assert.equal(nodes(menu).filter(node => node.type === 'portal').length, 0);
trigger(menu).props.onClick(anchorEvent);
menu = renderEntry();
assert.equal(trigger(menu).props['aria-expanded'], true, '点击入口直接打开浮层，不依赖 CSS 悬停');
assert.equal(nodes(menu).find(node => node.type === 'portal').props.target, portalBody, '配置浮层挂在 body，脱离侧栏滚动容器');
trigger(menu).props.onMouseEnter(anchorEvent);
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

// 沿真实菜单层级派发点击，覆盖父侧栏的关闭处理。
const { TreeView: ActualTreeView } = load('src/components/file-explorer/TreeView.tsx', {});
const bubbleClick = path => {
  let stopped = false;
  const event = { ...anchorEvent, stopPropagation() { stopped = true; } };
  for (const node of path) {
    node.props.onClick?.(event);
    if (stopped) break;
  }
};
let blankMenu = nodes(config).find(node => node.props?.className === 'context-menu');
bubbleClick([trigger(menu), blankMenu, config]);
config = renderConfig();
assert.ok(nodes(config).some(node => node.type === ConfiguredTerminalMenuItem), '点击新建配置终端入口不能冒泡关闭菜单');
for (let attempt = 0; attempt < 2; attempt++) {
  entry = nodes(config).find(node => node.type === ConfiguredTerminalMenuItem);
  menu = renderEntry();
  const submenu = nodes(menu).find(node => node.type === TreeView);
  const actualTree = ActualTreeView(submenu.props);
  const alphaNode = nodes(actualTree).find(node => node.key === 'Alpha');
  const projectRow = alphaNode.type(alphaNode.props).props.children[0];
  blankMenu = nodes(config).find(node => node.props?.className === 'context-menu');
  const popup = nodes(menu).find(node => node.props?.className === 'context-submenu new-terminal-profile-menu');
  bubbleClick([projectRow, actualTree, popup, blankMenu, config]);
  config = renderConfig();
  entry = nodes(config).find(node => node.type === ConfiguredTerminalMenuItem);
  assert.ok(entry, '点击项目展开或收起后应保持右键菜单打开');
  assert.equal(entry.props.expandedGroups.has('Alpha'), attempt === 1);
}
assert.equal(launches.length, 0, '展开和收起项目不应启动终端');
console.log('PASS: 点击配置入口和项目名称不会冒泡关闭菜单，项目可以连续展开和收起');

// 从入口移向独立浮层、项目启动浮层和模型浮层时保持打开。
let popup = nodes(menu).find(node => node.props?.className === 'context-submenu new-terminal-profile-menu');
trigger(menu).props.onMouseLeave({ relatedTarget: new TestElement('new-terminal-profile-menu') });
assert.equal(hoverTimers.size, 0);
trigger(menu).props.onMouseLeave({ relatedTarget: null });
assert.equal(hoverTimers.size, 1);
popup.props.onMouseEnter();
assert.equal(hoverTimers.size, 0, '进入配置浮层取消延迟关闭');
popup.props.onMouseLeave({ relatedTarget: new TestElement('new-terminal-project-menu') });
assert.equal(hoverTimers.size, 0);
const projectPopup = nodes(menu).find(node => node.props?.className === 'new-terminal-project-menu');
assert.ok(projectPopup);
assert.ok(nodes(menu).filter(node => node.type === 'portal').every(node => node.props.target === portalBody));
projectPopup.props.onMouseLeave({ relatedTarget: new TestElement('claude-model-submenu') });
assert.equal(hoverTimers.size, 0, '进入模型浮层不能关闭整个配置菜单');
for (const floating of [popup, projectPopup]) {
  let stops = 0;
  const event = { stopPropagation() { stops++; } };
  floating.props.onMouseDown(event);
  floating.props.onClick(event);
  floating.props.onWheel(event);
  assert.equal(stops, 3, '浮层内点击与滚动不触发文档级关闭监听');
}
popup.props.onMouseLeave({ relatedTarget: null });
for (const callback of [...hoverTimers.values()]) callback();
hoverTimers.clear();
menu = renderEntry();
assert.equal(trigger(menu).props['aria-expanded'], false);
assert.equal(nodes(menu).filter(node => node.type === 'portal').length, 0, '真正离开菜单后关闭独立浮层');
trigger(menu).props.onMouseEnter(anchorEvent);
menu = renderEntry();
assert.equal(trigger(menu).props['aria-expanded'], true, '悬停入口也能重新打开浮层');
windowMock.innerWidth = 500;
trigger(menu).props.onMouseEnter({ currentTarget: { getBoundingClientRect: () => ({ right: 460, left: 260, top: 780 }) } });
menu = renderEntry();
popup = nodes(menu).find(node => node.props?.className === 'context-submenu new-terminal-profile-menu');
assert.deepEqual(popup.props.style, { left: 8, top: 600 }, '视口空间不足时翻到左侧并限制纵向位置');
windowMock.innerWidth = 1200;
console.log('PASS: 点击和悬停显式打开 body 浮层，跨浮层移动不误关，内部交互与边界定位正确');

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

config = renderConfig(false);
config.props.onClick();
assert.equal(nodes(renderConfig(false)).some(node => node.props?.className === 'context-menu'), false, '菜单外点击仍正常关闭右键菜单');
console.log('PASS: 菜单内选择配置及菜单外点击仍按原有规则关闭菜单');
