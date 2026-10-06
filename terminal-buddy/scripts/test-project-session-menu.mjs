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
  readClientData: async () => storedTabs,
  writeClientData: async (_key, value) => { storedTabs = value; },
};
function load(file, mocks = {}) {
  const filename = path.join(root, file);
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
    fileName: filename,
  });
  const module = { exports: {} };
  const mockedRequire = name => {
    if (Object.hasOwn(mocks, name)) return mocks[name];
    if (name.startsWith('.')) throw new Error('Missing mock: ' + name);
    return require(name);
  };
  new Function('require', 'module', 'exports', 'document', 'window', outputText)(
    mockedRequire, module, module.exports,
    { querySelector: () => null }, { __settingsListenerRegistered: true },
  );
  return module.exports;
}
const startupPresets = load('src/utils/startupPresets.ts');
const openTerminal = load('src/utils/openTerminalInDir.ts', {
  '../stores/appStore': { useAppStore: store }, '../services/tauri': tauri, './startupPresets': startupPresets,
});
const { TabContextMenu } = load('src/components/shell/TabContextMenu.tsx', {
  '../../stores/appStore': { useAppStore: store },
  '../../utils/projectPath': load('src/utils/projectPath.ts'),
  '../../utils/openTerminalInDir': openTerminal,
  '../../utils/startupPresets': startupPresets,
  '../../services/tauri': tauri,
});
const sliceMocks = Object.fromEntries(
  ['profiles', 'fileTree', 'sessions', 'tabs', 'transfers', 'window'].map(name => ['./slices/' + name + 'Slice', {}]),
);
const appStore = load('src/stores/appStore.ts', {
  zustand: { create: () => store }, '../services/tauri': tauri, ...sliceMocks,
});
const restore = load('src/services/sessionRestore.ts', {
  './tauri': tauri, '../stores/appStore': appStore,
  '../utils/settings': { getAppSettings: () => ({ autoResumeClaudeSession: false }) },
  './dialog': {}, '../types': load('src/types/index.ts'),
});
function reset() {
  calls = [];
  failStart = false;
  state = {
    projects: [], extraParamPresets: [], sessions: [], sessionDirectories: {}, claudeSessionIds: {},
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
const preset = { id: 'preset', name: '开发', params: '--model sonnet', mode: 'append', tagColor: '#123456', enabled: true };
for (const [command, selectedPreset, expected] of [
  ['claude', undefined, 'claude'],
  ['claude', preset, 'claude --model sonnet'],
  ['claude', { ...preset, mode: 'independent', params: 'other-cli --flag' }, 'other-cli --flag'],
  ['claude', { ...preset, mode: 'independent', params: '' }, ''],
  ['', undefined, ''],
]) {
  reset();
  await openTerminal.openProjectTerminal({ ...project, startupCommand: command }, selectedPreset);
  const original = state.sessions[0];
  assert.equal(original.startupPath, project.path);
  assert.equal(original.extraParams, expected);
  assert.equal(original.extraParamMode, 'independent');
  // 项目/预设已删除、终端已 cd 并重命名时，仍按原启动快照重建。
  state.sessionDirectories[original.id] = 'D:\\other';
  original.profileName = '重命名会话';
  await recreate(original);
  assert.deepEqual(calls[1], ['powershell', 0, 0, project.path, '重命名会话', expected]);
  const duplicate = state.sessions[1];
  assert.equal(duplicate.profileId, '');
  assert.equal(duplicate.groupName, project.name);
  assert.equal(duplicate.extraParamTag, selectedPreset?.name);
  assert.equal(duplicate.extraParamTagColor, selectedPreset?.tagColor);
  assert.equal(duplicate.extraParams, expected);
}
console.log('PASS: 项目启动、追加/独立预设、空命令及已删除项目/预设的启动快照');
reset();
state.projects = [project];
state.extraParamPresets = [preset];
const legacy = { id: 'legacy', profileId: '', profileName: '旧会话', groupName: project.name, terminalType: 'powershell', extraParamTag: preset.name, extraParamTagColor: preset.tagColor };
await recreate(legacy);
assert.deepEqual(calls[0], ['powershell', 0, 0, project.path, legacy.profileName, 'claude --model sonnet']);
console.log('PASS: 无快照旧项目会话兼容');
const profile = { id: 'profile', terminalType: 'powershell', startupPath: '', group: project.name };
const configured = { ...legacy, profileId: profile.id, extraParams: '--verbose', extraParamMode: 'append' };
let configuredArgs;
await recreate(configured, [profile], (...args) => { configuredArgs = args; });
assert.deepEqual(configuredArgs, [profile, '--verbose', preset.name, legacy.profileName, preset.name, preset.tagColor, 'append']);
for (const session of [
  { ...legacy, sessionType: 'editor' }, { ...legacy, terminalType: 'ssh' },
  { ...legacy, groupName: undefined }, { ...legacy, profileId: 'missing-profile' },
]) assert.equal(menuItem(session).item, undefined);
console.log('PASS: 原配置会话保持行为，编辑器及非项目会话不误显示');
reset();
await openTerminal.openProjectTerminal(project, preset);
const original = state.sessions[0];
state.sessionDirectories[original.id] = 'D:\\other';
await appStore.saveTabsToStorage([original], original.id);
const saved = (await appStore.loadSavedTabs()).tabs[0];
assert.equal(saved.startupPath, project.path);
assert.equal(saved.extraParams, 'claude --model sonnet');
assert.equal(saved.directory, 'D:\\other');
reset();
await restore.restoreTabs();
assert.equal(state.sessions[0].startupPath, project.path);
assert.equal(state.sessions[0].extraParams, saved.extraParams);
await recreate(state.sessions[0]);
assert.equal(calls[1][3], project.path);
assert.equal(calls[1][5], saved.extraParams);
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
