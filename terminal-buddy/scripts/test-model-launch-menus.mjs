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
function text(node) {
  if (Array.isArray(node)) return node.map(text).join('');
  return typeof node === 'object' && node ? text(node.props?.children) : String(node ?? '');
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const claude = load('src/utils/claudeLaunch.ts');
const codex = load('src/utils/codexLaunch.ts', { './claudeLaunch': claude });
const claudeRef = load('src/services/tauri/claudeEnhance.ts', { '@tauri-apps/api/core': {} });
const projectPath = load('src/utils/projectPath.ts', { '../services/platform': { serverUsesWindowsPaths: () => false } });
const startupPresets = load('src/utils/startupPresets.ts');
const TreeView = () => null;
const ClaudeModelMenuSection = () => null;
const ProjectContextMenu = () => null;
const CodexProvidersPanel = () => null;
const LlmProvidersDialog = () => null;
const event = { preventDefault() {}, stopPropagation() {}, clientX: 30, clientY: 40,
  currentTarget: { getBoundingClientRect: () => ({ left: 30, bottom: 40 }) } };

function desktop(command, kind = 'profile', terminalType = 'cmd') {
  const react = hooks(), launches = [], settings = [];
  const project = { name: '测试项目', path: '/test/project', startupCommand: command };
  const profile = { id: 'profile', name: '测试命令', group: project.name, terminalType, startupPath: '', startupCommands: [command] };
  const state = {
    profiles: [profile], projects: [project], extraParamPresets: [], configSearchQuery: '',
    selectProfile() {}, setProviderSettingsTab: source => settings.push(source), openSettingsDialog() {},
  };
  const useAppStore = selector => selector(state);
  useAppStore.getState = () => state;
  const { ConfigNav } = load('src/components/profile-config/ConfigNav.tsx', {
    react, '../../stores/appStore': { useAppStore }, '../../services/tauri': claudeRef,
    '../../utils/openTerminalInDir': { openTerminalInDir: async (...args) => launches.push(args) },
    '../../utils/startupPresets': startupPresets, '../../utils/contextMenu': {}, '../../utils/terminalResizeEvent': {},
    '../../utils/codexLaunch': codex, '../../utils/claudeLaunch': claude,
    '../file-explorer/TreeView': { TreeView }, '../shared/Dialog': {},
    '../shared/ClaudeModelMenuSection': { ClaudeModelMenuSection }, '@tauri-apps/plugin-dialog': {},
    '../../utils/projectPath': projectPath, '../../services/platform': { isDockerClient: () => false },
  });
  function render() {
    react.begin();
    return ConfigNav({ isActive: true, isSidebarMode: true, onStartTerminal: (...args) => launches.push(args) });
  }
  const tree = nodes(render()).find(node => node.type === TreeView);
  tree.props.onContextMenu(event, kind === 'profile' ? { data: profile } : { isGroup: true, id: project.name });
  const menu = nodes(render()).find(node => node.props.className === 'context-menu');
  const sections = nodes(menu).filter(node => node.type === ClaudeModelMenuSection);
  if (sections.length) {
    const contents = nodes(menu);
    assert.ok(contents.indexOf(sections[0]) > contents.findIndex(node => node.props.children === '命令行'));
  }
  return { sections, launches, settings, profile, project };
}

async function web(command, kind = 'profile', terminalType = 'bash') {
  const react = hooks(), launches = [];
  const project = { name: '服务器工作区', path: '/test/project', startupCommand: command };
  const profile = { id: 'profile', name: '测试命令', group: project.name, terminalType, startupPath: '', startupCommands: [command] };
  const state = { profiles: [profile], projects: [project], extraParamPresets: [], setView() {} };
  const useStore = selector => selector(state);
  useStore.getState = () => state;
  useStore.setState = next => Object.assign(state, next);
  const api = {
    getProfiles: async () => [profile], getProjects: async () => [project], getRuntime: async () => ({ platform: 'linux' }),
    getLlmLaunchTargets: async () => [{ providerId: 'claude-provider', providerName: 'Claude 供应商', isDefault: true,
      models: [{ id: 'claude-model', effort: 'high' }] }],
    getCodexProviderState: async () => ({ activeProviderId: 'codex-provider', providers: [{ id: 'codex-provider',
      name: 'Codex 供应商', models: ['codex-model'], modelReasoningEfforts: { 'codex-model': 'max' } }] }),
    createTerminal: async (...args) => { launches.push(args); return { id: 'terminal' }; },
  };
  const Projects = load('web/src/screens/Projects.tsx', {
    react, '../api': { api }, '../store': { useStore },
    '../components/Dialog': {}, '../components/ExtraParamsDialog': {},
    '../components/CodexProvidersPanel': { CodexProvidersPanel }, '../components/LlmProvidersDialog': { LlmProvidersDialog },
    '../components/ProfileEditorDialog': {}, '../components/ProjectContextMenu': { ProjectContextMenu },
    '../components/ProjectEditorDialog': {}, '../hooks/useLongPressMenu': { useLongPressMenu: () => () => ({}) },
    '../hooks/useMediaQuery': { useHasHover: () => true },
    '../utils/projects': load('web/src/utils/projects.ts', { '../api': { api } }),
    '../utils/codexLaunch': load('web/src/utils/codexLaunch.ts'),
  }).default;
  function render() { react.begin(); return Projects({ onOpenFiles() {} }); }
  render();
  await react.mount();
  const label = kind === 'profile' ? `配置操作 ${profile.name}` : `项目操作 ${project.name}`;
  nodes(render()).find(node => node.props['aria-label'] === label).props.onClick(event);
  const menu = nodes(render()).find(node => node.type === ProjectContextMenu);
  const sections = nodes(menu).filter(node => node.type === React.Fragment && ['claude', 'codex'].includes(node.key));
  if (sections.length) {
    const contents = nodes(menu);
    assert.ok(contents.indexOf(sections[0]) > contents.findIndex(node => node.props.children === '命令行'));
  }
  return { sections, launches, render, profile, project };
}

for (const kind of ['profile', 'group']) {
  for (const [command, order] of [
    ['claude --model old --verbose', ['claude', 'codex']],
    ['codex --model old --sandbox read-only', ['codex', 'claude']],
    ['CLAUDE.CMD --resume session', ['claude', 'codex']],
    ['"codex.exe" --sandbox read-only', ['codex', 'claude']],
  ]) {
    const d = desktop(command, kind);
    const w = await web(command, kind);
    assert.deepEqual(d.sections.map(section => section.props.source), order);
    assert.deepEqual(w.sections.map(section => section.key), order);
    for (const source of ['claude', 'codex']) {
      const expected = source === 'claude'
        ? claudeRef.buildClaudeRefCommand('provider', 'model', claude.inheritableClaudeArgs(command, claude.DEFAULT_CLAUDE_COMMAND))
        : codex.buildCodexRefCommand('provider', 'model', command);
      const ds = d.sections.find(section => section.props.source === source);
      ds.props.onPickModel('provider', 'model');
      await tick();
      const dc = d.launches.at(-1);
      if (kind === 'profile') {
        assert.equal(dc[0], d.profile);
        assert.equal(dc[1], expected);
        assert.equal(dc[6], 'independent', '配置模型启动应替换整条原命令');
      } else {
        assert.equal(dc[0], d.project.path);
        assert.deepEqual(dc[1], { command: expected, name: d.project.name, groupName: d.project.name });
      }
      ds.props.onGotoProviders();
      assert.equal(d.settings.at(-1), source);
      const ws = w.sections.find(section => section.key === source);
      const model = `${source}-model`;
      nodes(ws).find(node => node.type === 'button' && text(node).startsWith(model)).props.onClick();
      await tick();
      const wc = w.launches.at(-1);
      const webExpected = expected.replace('provider:model', `${source}-provider:${model}`);
      assert.equal(wc[0], kind === 'profile' ? w.profile.id : '');
      if (kind === 'profile') {
        assert.deepEqual(wc[1], { extraStartupParams: webExpected, extraStartupMode: 'independent' });
      } else {
        assert.deepEqual(wc[1], { displayName: w.project.name, startupPath: w.project.path,
          startupGroup: w.project.name, startupCommand: webExpected });
      }
      nodes(ws).find(node => text(node) === '配置模型供应商…').props.onClick();
      const dialogType = source === 'claude' ? LlmProvidersDialog : CodexProvidersPanel;
      assert.ok(nodes(w.render()).some(node => node.type === dialogType), '配置入口应打开对应工具供应商');
    }
  }
}
for (const command of ['', 'npm run dev']) {
  for (const kind of ['profile', 'group']) {
    assert.equal(desktop(command, kind).sections.length, 0);
    assert.equal((await web(command, kind)).sections.length, 0);
  }
}
for (const terminalType of ['ssh', 'docker', 'k8s']) {
  assert.equal(desktop('claude', 'profile', terminalType).sections.length, 0);
  assert.equal((await web('codex', 'profile', terminalType)).sections.length, 0);
}
console.log('PASS: 双端项目/配置菜单排序、双向模型切换、命令整体替换、目录保留及配置入口；普通命令和远程终端不显示模型区');
