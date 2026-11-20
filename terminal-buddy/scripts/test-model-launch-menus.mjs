import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as React from 'react';
import ts from 'typescript';

const require = createRequire(import.meta.url);
function load(file, mocks = {}) {
  const { outputText } = ts.transpileModule(readFileSync(new URL('../' + file, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
    fileName: file,
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', outputText)(name => {
    if (Object.hasOwn(mocks, name)) return mocks[name];
    if (name.endsWith('.css')) return {};
    if (name.startsWith('.')) throw new Error('Missing mock: ' + name);
    return require(name);
  }, module, module.exports);
  return module.exports;
}
// 运行真实的菜单事件处理和命令组装，仅替换环境、终端创建和 React 的挂载过程。
function hooks() {
  let stateIndex = 0, refIndex = 0;
  const values = [], refs = [], effects = [];
  return {
    ...React,
    begin() { stateIndex = 0; refIndex = 0; },
    async mount() {
      effects.splice(0).forEach(effect => effect());
      await tick();
    },
    useState(initial) {
      const index = stateIndex++;
      if (!(index in values)) values[index] = typeof initial === 'function' ? initial() : initial;
      return [values[index], value => { values[index] = typeof value === 'function' ? value(values[index]) : value; }];
    },
    useRef(initial) { return refs[refIndex++] ??= { current: initial }; },
    useMemo(compute) { return compute(); },
    useCallback(callback) { return callback; },
    useEffect: effect => effects.push(effect),
    useLayoutEffect(effect) { effect(); },
  };
}
function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== 'object') return [];
  return [tree, ...nodes(tree.props?.children)];
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const claude = load('src/utils/claudeLaunch.ts');
const codex = load('src/utils/codexLaunch.ts', { './claudeLaunch': claude });
const antigravity = load('src/utils/antigravityLaunch.ts');
const claudeRef = load('src/services/tauri/claudeEnhance.ts', { '@tauri-apps/api/core': {} });
const openAgentChat = { openNewAgentSession: async () => {} };
const agentCommands = load('src/utils/agentCommands.ts', {
  './claudeLaunch': claude, './codexLaunch': codex, './antigravityLaunch': antigravity,
  '../stores/appStore': { useAppStore: { getState: () => ({ agentCommands: { claude: claude.DEFAULT_CLAUDE_COMMAND, codex: codex.DEFAULT_CODEX_COMMAND, antigravity: antigravity.DEFAULT_ANTIGRAVITY_COMMAND } }) } },
});
const types = load('src/types/index.ts');
const projectPath = load('src/utils/projectPath.ts', { '../services/platform': { serverUsesWindowsPaths: () => false } });
const TreeView = () => null;
const ClaudeModelMenuSection = () => null;
const AntigravityModelMenuSection = () => null;
const event = { preventDefault() {}, stopPropagation() {}, clientX: 30, clientY: 40,
  currentTarget: { getBoundingClientRect: () => ({ left: 30, bottom: 40 }) } };

function desktop(command, kind = 'profile', terminalType = 'cmd', enabledAgents = undefined) {
  return desktopWithProject({ name: '测试项目', path: '/test/project', startupCommand: command, enabledAgents })(command, kind, terminalType);
}

function desktopWithProject(project, availability = { claude: true, codex: true, antigravity: true }) {
  return (command = '', kind = 'group', terminalType = 'cmd') => {
  const react = hooks(), launches = [], antigravityLaunches = [], settings = [];
  const profile = { id: 'profile', name: '测试命令', group: project.name, terminalType, startupPath: '', startupCommands: [command] };
  const state = {
    profiles: [profile], projects: [project], configSearchQuery: '',
    refreshClaudeLaunchTargets: async () => {}, refreshCodexLaunchTargets: async () => {},
    antigravityProviderConfigLoaded: true, antigravityProviderConfig: null, refreshAntigravityProviderConfig: async () => {},
    selectProfile() {}, setProviderSettingsTab: source => settings.push(source), openSettingsDialog() {},
  };
  const useAppStore = selector => selector(state);
  useAppStore.getState = () => state;
  const launchMenu = load('src/components/shared/ProjectLaunchMenuItems.tsx', {
    react,
    '../../stores/appStore': { useAppStore },
    '../../utils/openTerminalInDir': {
      openProjectAgentTerminal: async () => {},
      openProjectAntigravityTerminal: async (targetProject, modelId, effort) => antigravityLaunches.push([targetProject, modelId, effort]),
    },
    '../../utils/openAgentChat': openAgentChat,
    '../../utils/agentCommands': agentCommands,
    '../../hooks/useAgentAvailability': { useAgentAvailability: () => availability },
    '../../types': types,
    './AntigravityModelMenuSection': { AntigravityModelMenuSection },
    './ClaudeModelMenuSection': { ClaudeModelMenuSection },
  });
  const ProjectContextMenu = load('src/components/shared/ProjectContextMenu.tsx', {
    react,
    '../../stores/appStore': { useAppStore },
    '../../services/tauri': claudeRef,
    '../../services/platform': { supportsSystemExplorerOpen: () => false },
    '../../utils/contextMenu': { fitContextMenuToViewport: ({ x, y }) => ({ x, y }) },
    './ProjectLaunchMenuItems': launchMenu,
  }).ProjectContextMenu;
  const { ConfigNav } = load('src/components/profile-config/ConfigNav.tsx', {
    react, '../../stores/appStore': { useAppStore }, '../../services/tauri': claudeRef,
    '../../utils/openTerminalInDir': { openTerminalInDir: async (...args) => launches.push(args) },
    '../../utils/contextMenu': {}, '../../utils/terminalResizeEvent': {},
    '../../utils/codexLaunch': codex, '../../utils/claudeLaunch': claude,
    '../../utils/agentCommands': agentCommands,
    '../file-explorer/TreeView': { TreeView }, '../shared/Dialog': {},
    '../shared/ClaudeModelMenuSection': { ClaudeModelMenuSection },
    '../shared/ProjectLaunchMenuItems': launchMenu, '../shared/ProjectContextMenu': { ProjectContextMenu },
    '../shared/ProjectEditDialog': {}, '../shared/ProjectDeleteDialog': {},
    '@tauri-apps/plugin-dialog': {},
    '../../types': types,
    '../../utils/projectPath': projectPath, '../../services/platform': { isDockerClient: () => false, supportsSystemExplorerOpen: () => false },
  });
  function render() {
    react.begin();
    return ConfigNav({ isActive: true, isSidebarMode: true, onStartTerminal: (...args) => launches.push(args) });
  }
  const tree = nodes(render()).find(node => node.type === TreeView);
  tree.props.onContextMenu(event, kind === 'profile' ? { data: profile } : { isGroup: true, id: project.name });
  const rendered = nodes(render());
  let launchNodes = [];
  if (kind === 'group') {
    const projectMenu = rendered.find(node => node.type === ProjectContextMenu);
    const projectMenuNodes = nodes(ProjectContextMenu(projectMenu.props));
    const launchElement = projectMenuNodes.find(node => node.type === launchMenu.ProjectLaunchMenuItems);
    launchNodes = [...projectMenuNodes, ...nodes(launchMenu.ProjectLaunchMenuItems(launchElement.props))];
  } else {
    const profileMenu = rendered.find(node => node.props?.className === 'context-menu');
    launchNodes = nodes(profileMenu);
  }
  const sections = launchNodes.filter(node => node.type === ClaudeModelMenuSection);
  const agySections = launchNodes.filter(node => node.type === AntigravityModelMenuSection);
  if (sections.length) {
    assert.ok(launchNodes.indexOf(sections[0]) > launchNodes.findIndex(node => node.props?.children === '命令行'));
  }
  if (agySections.length) {
    assert.ok(launchNodes.indexOf(agySections[0]) > launchNodes.findIndex(node => node.props?.children === '命令行'));
  }
  return { sections, agySections, launches, antigravityLaunches, settings, profile, project };
  };
}

// 配置右键：模型区排序、命令整体替换与配置入口；分组右键：按项目启用 Agent 展开启动区。
for (const kind of ['profile', 'group']) {
  for (const [command, order] of [
    ['claude --model old --verbose', ['claude', 'codex']],
    ['codex --model old --sandbox read-only', ['codex', 'claude']],
    ['CLAUDE.CMD --resume session', ['claude', 'codex']],
    ['"codex.exe" --sandbox read-only', ['codex', 'claude']],
  ]) {
    const enabledAgents = kind === 'group' ? { claude: true, codex: true, antigravity: true } : undefined;
    const d = desktop(command, kind, 'cmd', enabledAgents);
    // profile 按 profile 启动命令推导顺序；group 固定按项目启用顺序（claude → codex）。
    assert.deepEqual(d.sections.map(section => section.props.source), kind === 'profile' ? order : ['claude', 'codex']);
    for (const source of ['claude', 'codex']) {
      const expected = source === 'claude'
        ? claudeRef.buildClaudeRefCommand('provider', 'model', claude.inheritableClaudeArgs(command, claude.DEFAULT_CLAUDE_COMMAND))
        : codex.buildCodexRefCommand('provider', 'model', command);
      const ds = d.sections.find(section => section.props.source === source);
      if (kind === 'profile') {
        ds.props.onPickModel('provider', 'model');
        await tick();
        const dc = d.launches.at(-1);
        assert.equal(dc[0], d.profile);
        assert.equal(dc[1], expected);
        assert.equal(dc[3], 'independent', '配置模型启动应替换整条原命令');
      }
      ds.props.onGotoProviders();
      assert.equal(d.settings.at(-1), source);
    }
  }
}
for (const command of ['', 'npm run dev']) {
  assert.equal(desktop(command, 'profile').sections.length, 0);
}
// 项目停用全部 Agent 后，分组右键不再展开模型区。
const disabledAll = desktopWithProject({ name: '停用项目', path: '/test/disabled', enabledAgents: { claude: false, codex: false, antigravity: false } })();
assert.equal(disabledAll.sections.length, 0);
assert.equal(disabledAll.agySections.length, 0);

// Antigravity CLI 命令组装（含 effort & conversation 恢复）、taskLaunchInfo 识别、右键菜单显隐/同步。
assert.equal(antigravity.buildAntigravityLaunchCommand(), antigravity.DEFAULT_ANTIGRAVITY_COMMAND);
assert.equal(antigravity.buildAntigravityLaunchCommand('agy --mode auto'), 'agy --mode auto');
assert.equal(
  antigravity.buildAntigravityLaunchCommand('agy --dangerously-skip-permissions --model old-model --effort low', 'gemini-4-neon-high', 'high'),
  'agy --dangerously-skip-permissions --model gemini-4-neon-high --effort high',
);
assert.equal(
  antigravity.buildAntigravityLaunchCommand('agy --model=old && echo ok', 'gemini-pro-orchestrator-neon'),
  'agy --model gemini-pro-orchestrator-neon && echo ok',
);
assert.equal(
  antigravity.buildAntigravityLaunchCommand('agy --dangerously-skip-permissions', undefined, 'xhigh'),
  'agy --dangerously-skip-permissions --effort xhigh',
);
assert.equal(
  antigravity.buildAntigravityResumeCommand('abc-123', 'agy --dangerously-skip-permissions -c', 'gemini-3-pro', 'max'),
  'agy --dangerously-skip-permissions --model gemini-3-pro --effort max --conversation abc-123',
);
assert.equal(
  antigravity.resumedAntigravitySessionId('agy --dangerously-skip-permissions --conversation abc-123'),
  'abc-123',
);
assert.equal(antigravity.resumedAntigravitySessionId('claude --conversation abc-123'), undefined);
assert.throws(() => antigravity.buildAntigravityLaunchCommand('agy', 'bad model;rm'));
assert.throws(() => antigravity.buildAntigravityLaunchCommand('agy', 'gemini-3-pro', 'turbo'));

const taskLaunchInfo = load('src/utils/taskLaunchInfo.ts', {
  './claudeLaunch': claude,
  './codexLaunch': codex,
});
assert.deepEqual(
  taskLaunchInfo.getTaskLaunchInfo('agy --dangerously-skip-permissions --model gemini-4-neon-high --effort high', [], 'independent'),
  { provider: 'antigravity', model: 'gemini-4-neon-high', effort: 'high' },
);
assert.deepEqual(
  taskLaunchInfo.getTaskLaunchInfo('agy.exe --conversation conv-1', [], 'independent'),
  { provider: 'antigravity', model: undefined, effort: undefined },
);

const agyProject = { name: 'Agy项目', path: '/test/agy', enabledAgents: { claude: false, codex: false, antigravity: true } };
const agyEnabled = desktopWithProject(agyProject)();
assert.equal(agyEnabled.agySections.length, 1);
agyEnabled.agySections[0].props.onPickModel(undefined, 'high');
agyEnabled.agySections[0].props.onPickModel('gemini-4-neon-high', 'xhigh');
agyEnabled.agySections[0].props.onGotoProviders();
await tick();
assert.deepEqual(agyEnabled.antigravityLaunches, [
  [agyProject, undefined, 'high'],
  [agyProject, 'gemini-4-neon-high', 'xhigh'],
]);
assert.equal(agyEnabled.settings.at(-1), 'antigravity');

// 验证真实的 AntigravityModelMenuSection 渲染：已启用模型平铺 + defaultEffort 回落 + 跳转设置
const realMenuReact = hooks();
const menuState = {
  antigravityProviderConfigLoaded: true,
  refreshAntigravityProviderConfig: async () => {},
  antigravityProviderConfig: {
    defaultEffortLevel: 'high',
    availableModels: [],
    enabledModels: [
      { id: 'gemini-4-neon', name: 'Gemini 4 Neon', effortLevel: '' },
      { id: 'claude-sonnet', name: 'Claude Sonnet', effortLevel: 'xhigh' },
    ],
  },
};
const realMenuStore = selector => selector(menuState);
realMenuStore.getState = () => menuState;
const { AntigravityModelMenuSection: RealAgySection } = load('src/components/shared/AntigravityModelMenuSection.tsx', {
  react: realMenuReact,
  '../../stores/appStore': { useAppStore: realMenuStore },
  '../../utils/antigravityLaunch': antigravity,
});
const picked = [];
let wentToProviders = 0;
realMenuReact.begin();
const flatTree = nodes(RealAgySection({
  itemClassName: 'context-menu-item',
  separatorClassName: 'context-menu-separator',
  mode: 'launch',
  onPickModel: (id, effort) => picked.push([id, effort]),
  onGotoProviders: () => { wentToProviders++; },
}));
const modelItems = flatTree.filter(n => typeof n.props?.onClick === 'function');
assert.equal(modelItems.length, 2);
modelItems[0].props.onClick(event);
modelItems[1].props.onClick(event);
assert.deepEqual(picked, [
  ['gemini-4-neon', 'high'],
  ['claude-sonnet', 'xhigh'],
]);

menuState.antigravityProviderConfig = { defaultEffortLevel: 'medium', availableModels: [], enabledModels: [] };
realMenuReact.begin();
const fallbackTree = nodes(RealAgySection({
  itemClassName: 'context-menu-item',
  separatorClassName: 'context-menu-separator',
  mode: 'launch',
  onPickModel: (id, effort) => picked.push([id, effort]),
  onGotoProviders: () => { wentToProviders++; },
}));
const fallbackItems = fallbackTree.filter(n => typeof n.props?.onClick === 'function');
assert.equal(fallbackItems.length, 2);
fallbackItems[0].props.onClick(event);
fallbackItems[1].props.onClick(event);
assert.deepEqual(picked.at(-1), [undefined, 'medium']);
assert.equal(wentToProviders, 1);

assert.equal(
  desktopWithProject(agyProject, { claude: true, codex: true, antigravity: false })().agySections.length,
  0,
);
assert.equal(
  desktopWithProject({ name: '停用Agy', path: '/test/no-agy', enabledAgents: { claude: true, codex: true, antigravity: false } })().agySections.length,
  0,
);

for (const terminalType of ['ssh', 'docker', 'k8s']) {
  assert.equal(desktop('claude', 'profile', terminalType).sections.length, 0);
}
console.log('PASS: 项目/配置菜单排序、双向模型切换、Antigravity CLI 启动、命令整体替换、目录保留及配置入口；普通命令和远程终端不显示模型区');
