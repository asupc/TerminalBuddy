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
    useMemo: compute => compute(),
    useCallback: callback => callback,
    useEffect: effect => effects.push(effect),
    useLayoutEffect() {},
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
const claudeRef = load('src/services/tauri/claudeEnhance.ts', { '@tauri-apps/api/core': {} });
const types = load('src/types/index.ts');
const projectPath = load('src/utils/projectPath.ts', { '../services/platform': { serverUsesWindowsPaths: () => false } });
const startupPresets = load('src/utils/startupPresets.ts');
const TreeView = () => null;
const ClaudeModelMenuSection = () => null;
const event = { preventDefault() {}, stopPropagation() {}, clientX: 30, clientY: 40,
  currentTarget: { getBoundingClientRect: () => ({ left: 30, bottom: 40 }) } };

function desktop(command, kind = 'profile', terminalType = 'cmd') {
  return desktopWithProject({ name: '测试项目', path: '/test/project', startupCommand: command })(command, kind, terminalType);
}

function desktopWithProject(project) {
  return (command = '', kind = 'group', terminalType = 'cmd') => {
  const react = hooks(), launches = [], settings = [];
  const profile = { id: 'profile', name: '测试命令', group: project.name, terminalType, startupPath: '', startupCommands: [command] };
  const state = {
    profiles: [profile], projects: [project], extraParamPresets: [], configSearchQuery: '',
    selectProfile() {}, setProviderSettingsTab: source => settings.push(source), openSettingsDialog() {},
  };
  const useAppStore = selector => selector(state);
  useAppStore.getState = () => state;
  const launchMenu = load('src/components/shared/ProjectLaunchMenuItems.tsx', {
    react,
    '../../stores/appStore': { useAppStore },
    '../../utils/openTerminalInDir': { openProjectAgentTerminal: async () => {} },
    '../../utils/startupPresets': startupPresets, '../../types': types,
    './ClaudeModelMenuSection': { ClaudeModelMenuSection },
  });
  const { ConfigNav } = load('src/components/profile-config/ConfigNav.tsx', {
    react, '../../stores/appStore': { useAppStore }, '../../services/tauri': claudeRef,
    '../../utils/openTerminalInDir': { openTerminalInDir: async (...args) => launches.push(args) },
    '../../utils/startupPresets': startupPresets, '../../utils/contextMenu': {}, '../../utils/terminalResizeEvent': {},
    '../../utils/codexLaunch': codex, '../../utils/claudeLaunch': claude,
    '../file-explorer/TreeView': { TreeView }, '../shared/Dialog': {},
    '../shared/ClaudeModelMenuSection': { ClaudeModelMenuSection },
    '../shared/ProjectLaunchMenuItems': launchMenu, '@tauri-apps/plugin-dialog': {},
    '../../types': types,
    '../../utils/projectPath': projectPath, '../../services/platform': { isDockerClient: () => false, supportsSystemExplorerOpen: () => false },
  });
  function render() {
    react.begin();
    return ConfigNav({ isActive: true, isSidebarMode: true, onStartTerminal: (...args) => launches.push(args) });
  }
  const tree = nodes(render()).find(node => node.type === TreeView);
  tree.props.onContextMenu(event, kind === 'profile' ? { data: profile } : { isGroup: true, id: project.name });
  const menu = nodes(render()).find(node => node.props.className === 'context-menu');
  // 分组菜单的模型区在 ProjectLaunchMenuItems 子组件里，手动展开一层再收集 sections。
  const menuNodes = kind === 'group'
    ? nodes(menu).flatMap(node => node.type === launchMenu.ProjectLaunchMenuItems ? [node, ...nodes(node.type(node.props))] : [node])
    : nodes(menu);
  const sections = menuNodes.filter(node => node.type === ClaudeModelMenuSection);
  if (sections.length) {
    assert.ok(menuNodes.indexOf(sections[0]) > menuNodes.findIndex(node => node.props.children === '命令行'));
  }
  return { sections, launches, settings, profile, project };
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
    const d = desktop(command, kind);
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
        assert.equal(dc[6], 'independent', '配置模型启动应替换整条原命令');
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
assert.equal(desktopWithProject({ name: '停用项目', path: '/test/disabled', enabledAgents: { claude: false, codex: false } })().sections.length, 0);
for (const terminalType of ['ssh', 'docker', 'k8s']) {
  assert.equal(desktop('claude', 'profile', terminalType).sections.length, 0);
}
console.log('PASS: 项目/配置菜单排序、双向模型切换、命令整体替换、目录保留及配置入口；普通命令和远程终端不显示模型区');
