import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// 只替换 Tauri / 浏览器环境，不启动真实终端，也不读写用户数据。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
let state, storedTabs = '', calls = [], failStart = false, nextId = 0;
const store = {
  getState: () => state,
  setState: update => Object.assign(state, typeof update === 'function' ? update(state) : update),
};
const tauri = {
  startBlankTerminal: async (...args) => {
    calls.push(args);
    if (failStart) throw new Error('mock startup failure');
    return 'terminal-' + ++nextId;
  },
  writeToTerminal: async () => {},
  readClientData: async () => storedTabs,
  writeClientData: async (_key, value) => { storedTabs = value; },
};
function load(file, mocks = {}) {
  const filename = path.join(root, file);
  // import.meta 是 ESM 语法，new Function（CJS 语境）里直接语法错误；
  // 测试一律按生产构建看待（DEV=false），其余 env 字段替换为空对象。
  const source = fs.readFileSync(filename, 'utf8')
    .replace(/import\.meta\.env\.DEV/g, 'false')
    .replace(/import\.meta\.env/g, '({})');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
    fileName: filename,
  });
  const module = { exports: {} };
  const mockedRequire = name => {
    if (Object.hasOwn(mocks, name)) return mocks[name];
    if (name.endsWith('utils/commandParams')) return commandParams;
    if (name.endsWith('utils/sessionHistory')) return sessionHistory;
    if (name.endsWith('utils/tabActivation')) return tabActivation;
    if (name.endsWith('utils/claudeLaunch')) return claudeLaunch;
    if (name.endsWith('utils/codexLaunch')) return codexLaunch;
    // 不同文件引用 slice 的相对前缀不同（./slices/… 与 ../stores/slices/…），
    // 统一按后缀兜底；store 的 create 被 mock 后 slice 工厂不会被真正调用。
    if (/(^|\/)slices\/\w+Slice$/.test(name)) return {};
    // platform 模块会连锁 import Tauri 运行时，node 里只能整包替身；
    // 各文件用相对路径引用它（./platform、../services/platform），统一按后缀兜底。
    if (name.endsWith('services/platform')) return {
      isBrowserClient: () => false,
      isDockerClient: () => false,
      clientTerminalOwner: () => 'pc',
      defaultShellType: () => 'powershell',
      serverUsesWindowsPaths: () => true,
      supportsSystemExplorerOpen: () => true,
    };
    if (name.startsWith('.')) throw new Error('Missing mock: ' + name);
    return require(name);
  };
  new Function('require', 'module', 'exports', 'document', 'window', outputText)(
    mockedRequire, module, module.exports,
    { querySelector: () => null }, { __settingsListenerRegistered: true },
  );
  return module.exports;
}
// 纯工具模块可直接真加载：剥 --resume 参数、判断 claude 命令等无运行时依赖。
const claudeLaunch = load('src/utils/claudeLaunch.ts');
const codexLaunch = load('src/utils/codexLaunch.ts', { './claudeLaunch': claudeLaunch });
const antigravityLaunch = load('src/utils/antigravityLaunch.ts');
const commandParams = load('src/utils/commandParams.ts');
const agentCommands = load('src/utils/agentCommands.ts', {
  './claudeLaunch': claudeLaunch, './codexLaunch': codexLaunch, './antigravityLaunch': antigravityLaunch,
  '../stores/appStore': { useAppStore: store },
});
const sessionHistory = load('src/utils/sessionHistory.ts', {
  './tauri': tauri, '../types': load('src/types/index.ts'),
  '../components/claude-history/resumeClaudeSession': { pickClaudeProfile: () => undefined, resumeClaudeSession: async () => {} },
  '../components/claude-history/resumeCodexSession': { pickCodexProfile: () => undefined, resumeCodexSession: async () => {} },
});
const tabActivation = load('src/utils/tabActivation.ts', { './sessionHistory': sessionHistory });
const openTerminal = load('src/utils/openTerminalInDir.ts', {
  '../stores/appStore': { useAppStore: store }, '../services/tauri': tauri, './agentCommands': agentCommands,
  '../services/platform': { defaultShellType: () => 'powershell' },
  './projectPath': load('src/utils/projectPath.ts', { '../services/platform': { serverUsesWindowsPaths: () => false } }),
  './claudeLaunch': claudeLaunch, './codexLaunch': codexLaunch, './antigravityLaunch': antigravityLaunch,
});
const { TabContextMenu } = load('src/components/shell/TabContextMenu.tsx', {
  '../../stores/appStore': { useAppStore: store },
  '../../utils/projectPath': load('src/utils/projectPath.ts'),
  '../../utils/openTerminalInDir': openTerminal,
  '../../services/tauri': tauri,
  '../../services/platform': { supportsSystemExplorerOpen: () => true },
});
const sliceMocks = Object.fromEntries(
  ['profiles', 'fileTree', 'sessions', 'tabs', 'transfers', 'window', 'claudeLaunch'].map(name => ['./slices/' + name + 'Slice', {}]),
);
const appStore = load('src/stores/appStore.ts', {
  zustand: { create: () => store }, '../services/tauri': tauri, ...sliceMocks,
});
const restore = load('src/services/sessionRestore.ts', {
  './tauri': tauri, '../stores/appStore': appStore,
  '../utils/settings': { getAppSettings: () => ({ autoResumeClaudeSession: false }) },
  '../utils/agentCommands': agentCommands,
  './dialog': {}, '../types': load('src/types/index.ts'), './agentCommands': agentCommands,
  './platform': { isBrowserClient: () => false, clientTerminalOwner: () => 'pc', defaultShellType: () => 'powershell' },
});
function reset() {
  calls = [];
  failStart = false;
  state = {
    projects: [], sessions: [], sessionDirectories: {}, claudeSessionIds: {}, agentSessionBindings: {},
    agentTabs: [], activeAgentTabKey: null, activeSpecialTab: null,
    splitMode: 'off', splitSlots: [], activeSessionId: null, toasts: [],
    addSession: session => state.sessions.push(session),
    setSessionDirectory: (id, directory) => { state.sessionDirectories[id] = directory; },
    setActiveSession: id => { state.activeSessionId = id; },
    showToast: (...args) => state.toasts.push(args),
  };
}
function menuItem(session, profiles = [], onStartTerminal = () => {}) {
  let closed = 0;
  const tree = TabContextMenu({
    x: 0, y: 0, sessionId: session.id, sessions: [session], profiles,
    onStartTerminal, onClose: () => { closed++; }, onRename: () => {}, onCloseSession: () => {}, onCloseOthers: () => {},
  });
  const find = node => {
    if (Array.isArray(node)) return node.map(find).find(Boolean);
    if (!node || typeof node !== 'object') return undefined;
    return node.props?.children === '以此配置新建终端' ? node : find(node.props?.children);
  };
  return { item: find(tree), closed: () => closed };
}
async function recreate(session, profiles, onStartTerminal) {
  const menu = menuItem(session, profiles, onStartTerminal);
  assert.ok(menu.item, '项目会话应显示「以此配置新建终端」');
  menu.item.props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(menu.closed(), 1);
}
const project = { name: '测试项目', path: 'D:\\work\\project', startupCommand: 'claude' };
// 825f2da 起项目启动是纯空白终端（命令由 Agent 命令行注入），
// 启动命令快照会话改为手工构造，覆盖追加/独立参数的重建链路。
for (const [extraParams, expected] of [
  ['claude', 'claude'],
  ['claude --model sonnet', 'claude --model sonnet'],
  ['other-cli --flag', 'other-cli --flag'],
]) {
  reset();
  const original = { id: 'session-1', profileId: '', profileName: '重命名会话', groupName: project.name, startupPath: project.path, terminalType: 'powershell', extraParams, extraParamMode: 'independent' };
  state.sessions.push(original);
  // 项目已删除、终端已 cd 时，仍按原启动快照重建。
  state.sessionDirectories[original.id] = 'D:\\other';
  await recreate(original);
  assert.deepEqual(calls[0], ['powershell', 0, 0, project.path, original.profileName, expected, project.name]);
  const duplicate = state.sessions[1];
  assert.equal(duplicate.profileId, '');
  assert.equal(duplicate.groupName, project.name);
  assert.equal(duplicate.extraParams, expected);
}
console.log('PASS: 项目启动快照与已删除项目的重建');
reset();
state.projects = [project];
const legacy = { id: 'legacy', profileId: '', profileName: '旧会话', groupName: project.name, terminalType: 'powershell' };
await recreate(legacy);
// 无快照的旧项目会话仍从项目路径重建空白终端。
assert.deepEqual(calls[0], ['powershell', 0, 0, project.path, legacy.profileName, undefined, project.name]);
console.log('PASS: 无快照旧项目会话兼容');
const profile = { id: 'profile', terminalType: 'powershell', startupPath: '', group: project.name };
const configured = { ...legacy, profileId: profile.id, extraParams: '--verbose', extraParamMode: 'append' };
let configuredArgs;
await recreate(configured, [profile], (...args) => { configuredArgs = args; });
assert.deepEqual(configuredArgs, [profile, '--verbose', '旧会话', 'append']);
for (const session of [
  { ...legacy, sessionType: 'editor' }, { ...legacy, terminalType: 'ssh' },
  { ...legacy, groupName: undefined }, { ...legacy, profileId: 'missing-profile' },
]) assert.equal(menuItem(session).item, undefined);
console.log('PASS: 原配置会话保持行为，编辑器及非项目会话不误显示');
reset();
await openTerminal.openProjectTerminal(project);
const original = state.sessions[0];
// 模拟旧版后端广播的空 terminalType 快照（空白终端曾广播空串）
original.terminalType = '';
state.sessionDirectories[original.id] = 'D:\\other';
await appStore.saveTabsToStorage([original], original.id);
const saved = (await appStore.loadSavedTabs()).tabs[0];
assert.equal(saved.startupPath, project.path);
assert.equal(saved.directory, 'D:\\other');
reset();
await restore.restoreTabs();
assert.equal(state.sessions[0].startupPath, project.path);
// 空 terminalType 的旧快照恢复后应归一化为本地默认 Shell（回归）
assert.equal(state.sessions[0].terminalType, 'powershell');
await recreate(state.sessions[0]);
assert.equal(calls[1][3], project.path);
// 归一化同样作用于重建终端的基座 Shell，否则空值传给后端会落到兜底类型
assert.equal(calls[1][0], 'powershell');
storedTabs = JSON.stringify({ tabs: [{ ...saved, startupPath: 123 }], activeIndex: 0 });
assert.equal((await appStore.loadSavedTabs()).tabs[0].startupPath, undefined);
console.log('PASS: 保存/恢复启动快照，畸形数据归一化');
reset();
state.projects = [project];
failStart = true;
await recreate(legacy);
assert.equal(state.sessions.length, 0);
assert.match(state.toasts[0][0], /启动终端失败/);
failStart = false;
state.toasts = [];
state.splitMode = 'vertical';
state.splitSlots = [{ sessionId: 'occupied' }];
await recreate(legacy);
assert.equal(state.sessions.length, 0);
assert.match(state.toasts[0][0], /分屏模式已满/);
console.log('PASS: 启动失败提示及分屏容量保护');
assert.equal(
  commandParams.withoutResumeArgs('agy --dangerously-skip-permissions --model gemini-3-pro --effort high --conversation conv-123'),
  'agy --dangerously-skip-permissions --model gemini-3-pro --effort high',
);
assert.equal(
  commandParams.withoutResumeArgs('agy.exe -c --continue'),
  'agy.exe',
);
console.log('PASS: 剥离 Antigravity --conversation / -c 恢复参数');
