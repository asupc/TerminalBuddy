import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let storedClientData = {};
let isBrowser = false;
let liveTerminals = [];
let nextTerminalSeq = 0;

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
  new Function('require', 'module', 'exports', 'window', 'document', 'requestAnimationFrame', outputText)(
    (name) => {
      if (Object.hasOwn(mocks, name)) return mocks[name];
      throw new Error(`Unexpected dependency in ${file}: ${name}`);
    },
    module,
    module.exports,
    {
      __settingsListenerRegistered: true,
      addEventListener() {},
      setTimeout: (...args) => setTimeout(...args),
      clearTimeout: (...args) => clearTimeout(...args),
    },
    { querySelector: () => null },
    (cb) => setTimeout(cb, 0),
  );
  return module.exports;
}

const platformMock = {
  isBrowserClient: () => isBrowser,
  isWebBackend: () => isBrowser,
  isDockerClient: () => false,
  clientTerminalOwner: () => (isBrowser ? 'web' : 'pc'),
  defaultShellType: () => 'powershell',
  serverUsesWindowsPaths: () => true,
  supportsSystemExplorerOpen: () => true,
};

const tauriMock = {
  readClientData: async (key) => storedClientData[key] ?? '',
  writeClientData: async (key, value) => { storedClientData[key] = value; },
  deletePath: async () => {},
  ensureDir: async () => {},
  getDataPath: async () => 'D:/data',
  reportSessionDirectory: async () => {},
  updateTerminalDisplayName: async () => {},
  writeFileContent: async () => {},
  getFileSize: async () => 10,
  claimWebSessionRestore: async () => true,
  releaseWebSessionRestore: async () => {},
  closeTerminal: async () => {},
  getAgentSessionsForTerminals: async () => ({}),
  listTerminals: async () => liveTerminals,
  startBlankTerminal: async () => `restored-term-${++nextTerminalSeq}`,
  startTerminal: async () => `restored-term-${++nextTerminalSeq}`,
  writeToTerminal: async () => {},
  aiSessionList: async () => null,
};

const settingsMock = {
  getAppSettings: () => ({ restoreTabsOnStartup: true, autoResumeClaudeSession: false }),
  saveAppSettings: () => {},
  isAppSettingsInitialized: () => true,
};

const sessionHistory = load('src/utils/sessionHistory.ts', {
  './tauri': tauriMock,
  '../types': load('src/types/index.ts'),
  '../components/claude-history/resumeClaudeSession': {},
  '../components/claude-history/resumeCodexSession': {},
});
const tabActivation = load('src/utils/tabActivation.ts', {
  './sessionHistory': sessionHistory,
});
const projectPath = load('src/utils/projectPath.ts', {
  '../services/platform': platformMock,
});
const claudeLaunch = load('src/utils/claudeLaunch.ts');
const codexLaunch = load('src/utils/codexLaunch.ts', { './claudeLaunch': claudeLaunch });
const commandParams = load('src/utils/commandParams.ts');

let state = {};
const storeApi = {
  getState: () => state,
  setState: (patch) => {
    const next = typeof patch === 'function' ? patch(state) : patch;
    if (next && next !== state) {
      state = { ...state, ...next };
    }
  },
};

const appStoreBridge = {
  useAppStore: storeApi,
  saveTabsToStorage: (...args) => realAppStore.saveTabsToStorage(...args),
  loadSavedTabs: (...args) => realAppStore.loadSavedTabs(...args),
};

const { createTabsSlice } = load('src/stores/slices/tabsSlice.ts');
const { createProfilesSlice } = load('src/stores/slices/profilesSlice.ts', {
  '../../utils/sessionHistory': sessionHistory,
  '../../utils/tabActivation': tabActivation,
  '../../utils/settings': settingsMock,
});
const { createSessionsSlice } = load('src/stores/slices/sessionsSlice.ts', {
  '../../utils/projectPath': projectPath,
  '../../services/platform': platformMock,
  '../appStore': appStoreBridge,
  '../../services/tauri': tauriMock,
  '../../utils/terminalResizeEvent': { TERMINAL_SPLIT_TRANSITION_GUARD_MS: 0 },
  '../../utils/tabActivation': tabActivation,
});
const { createAgentChatSlice } = load('src/stores/slices/agentChatSlice.ts', {
  '../appStore': appStoreBridge,
  '../../utils/tabActivation': tabActivation,
  './sessionsSlice': { debouncedSaveTabs: () => {}, flushPendingSaveTabs: async () => {} },
});

const realAppStore = load('src/stores/appStore.ts', {
  zustand: { create: () => storeApi },
  '../services/tauri': tauriMock,
  '../utils/tabActivation': tabActivation,
  '../utils/sessionHistory': sessionHistory,
  './slices/profilesSlice': { createProfilesSlice },
  './slices/fileTreeSlice': { createFileTreeSlice: () => ({ currentDirectory: '' }) },
  './slices/sessionsSlice': { createSessionsSlice },
  './slices/tabsSlice': { createTabsSlice },
  './slices/transfersSlice': { createTransfersSlice: () => ({}) },
  './slices/windowSlice': { createWindowSlice: () => ({ terminalLayoutVersion: 0 }) },
  './slices/claudeLaunchSlice': { createClaudeLaunchSlice: () => ({}) },
  './slices/agentChatSlice': { createAgentChatSlice },
});

const restoreModule = load('src/services/sessionRestore.ts', {
  './tauri': tauriMock,
  '../stores/appStore': appStoreBridge,
  '../stores/slices/sessionsSlice': { flushPendingSaveTabsIfAny: async () => {} },
  '../utils/settings': settingsMock,
  '../utils/claudeLaunch': claudeLaunch,
  '../utils/codexLaunch': codexLaunch,
  '../utils/agentCommands': { currentCodexCommand: () => 'codex' },
  './dialog': { showAlert: async () => {} },
  '../types': load('src/types/index.ts'),
  './platform': platformMock,
  '../utils/commandParams': commandParams,
  '../utils/tabActivation': tabActivation,
});

function resetStore() {
  storedClientData = {};
  isBrowser = false;
  liveTerminals = [];
  nextTerminalSeq = 0;
  state = {
    currentDirectory: '',
    terminalLayoutVersion: 0,
    showToast: () => {},
    ...createTabsSlice(storeApi.setState),
    ...createProfilesSlice(storeApi.setState),
    ...createSessionsSlice(storeApi.setState, storeApi.getState),
    ...createAgentChatSlice(storeApi.setState, storeApi.getState),
  };
}

function makeSession(id, extra = {}) {
  return {
    id,
    profileId: `prof-${id}`,
    profileName: `Tab ${id}`,
    terminalType: 'powershell',
    colorTheme: { background: '#1e1e1e', foreground: '#d4d4d4' },
    tabColor: null,
    groupId: 'default',
    ...extra,
  };
}

function makeAgentTab(key, shape = 'native') {
  return shape === 'native'
    ? { key, shape: 'native', sessionId: key, title: `Agent ${key}`, provider: 'claude', projectPath: 'D:/p', openedAt: 1 }
    : { key, shape: 'relay', terminalId: key, title: `Relay ${key}`, provider: 'claude', openedAt: 1 };
}

// 1. 基本终端标签 MRU 切换与关闭行为
resetStore();
state.addSession(makeSession('S1'));
state.addSession(makeSession('S2'));
state.addSession(makeSession('S3'));
assert.equal(state.activeSessionId, 'S3');
state.setActiveSession('S1');
state.setActiveSession('S2');
assert.equal(state.activeSessionId, 'S2');
// 关闭非激活标签 S3：当前激活态 S2 不变
state.removeSession('S3');
assert.equal(state.activeSessionId, 'S2');
assert.equal(state.activeSpecialTab, null);
// 重新添加 S4 后切回 S1 再切到 S4
state.addSession(makeSession('S4'));
state.setActiveSession('S1');
state.setActiveSession('S4');
// 关闭当前激活 S4：自动激活上一个激活的 S1（而非 S2）
state.removeSession('S4');
assert.equal(state.activeSessionId, 'S1');
// 再关闭当前激活 S1：自动激活上一个激活的 S2
state.removeSession('S1');
assert.equal(state.activeSessionId, 'S2');
// 关闭最后一个 S2：清空激活态
state.removeSession('S2');
assert.equal(state.activeSessionId, null);
assert.equal(state.activeSpecialTab, null);
console.log('PASS: 基本终端标签 MRU 激活与关闭非激活标签不变');

// 2. 跨类型标签（终端 + 编辑器 + Agent + 回放 + Git + 定时任务）联动 MRU
resetStore();
state.addSession(makeSession('T1'));
state.addSession(makeSession('T2'));
state.openEditorSession('D:/work/a.ts');
const editorId = state.activeSessionId;
state.openAgentTab(makeAgentTab('agent:a1'));
state.openClaudeReplayTab({ sessionId: 'r1', title: 'Replay 1' });
state.openGitHistoryTab({ repoRoot: 'D:/work', branch: 'main' });
state.openScheduledTasksPage();
assert.equal(state.activeSpecialTab, 'scheduled-tasks');

// 在看定时任务时关闭后台标签：定时任务视图保持不变，后台悬空指针被清理
state.removeSession('T2');
assert.equal(state.activeSpecialTab, 'scheduled-tasks');
state.closeAgentTab('agent:a1');
assert.equal(state.activeSpecialTab, 'scheduled-tasks');
assert.equal(state.activeAgentTabKey, null);

// 重新切过 T1 -> Agent a2 -> Replay r1 -> ScheduledTasks
state.setActiveSession('T1');
state.openAgentTab(makeAgentTab('agent:a2'));
state.openScheduledTasksPage();
assert.equal(state.activeSpecialTab, 'scheduled-tasks');

// 关闭当前激活的定时任务 -> 回到上一个激活的 Agent a2
state.closeScheduledTasksPage();
assert.equal(state.activeSpecialTab, 'agent-chat');
assert.equal(state.activeAgentTabKey, 'agent:a2');

// 关闭当前激活的 Agent a2 -> 回到上一个激活的 T1
state.closeAgentTab('agent:a2');
assert.equal(state.activeSpecialTab, null);
assert.equal(state.activeSessionId, 'T1');

// 此时后台有 GitHistory 与 Replay r1：关闭非激活的 GitHistory 与 Replay r1，当前 T1 不受影响
state.closeGitHistoryTab();
state.closeClaudeReplayTab('r1');
assert.equal(state.activeSpecialTab, null);
assert.equal(state.activeSessionId, 'T1');
assert.equal(state.claudeReplayTab, null);

// 关闭当前激活的 T1 -> 回到此前激活的编辑器标签
state.removeSession('T1');
assert.equal(state.activeSpecialTab, null);
assert.equal(state.activeSessionId, editorId);

// closeEditorSession 也遵循同样规则
state.addSession(makeSession('T3'));
state.setActiveSession(editorId);
state.closeEditorSession(editorId);
assert.equal(state.activeSessionId, 'T3');
console.log('PASS: 跨类型标签统一激活历史与后台非激活关闭隔离');

// 3. 后台新增（keepActive=true / addAgentTab）不抢焦点且排在已激活标签之后
resetStore();
state.addSession(makeSession('T1'));
state.addSession(makeSession('T2')); // [T2, T1]
state.addSession(makeSession('T3'), true); // 后台新增
state.addAgentTab(makeAgentTab('agent:bg')); // 后台新增
assert.equal(state.activeSessionId, 'T2');
assert.equal(state.activeSpecialTab, null);
// 关闭 T2 后激活用户之前用过的 T1，而不是后台新增的 T3 或 bg
state.removeSession('T2');
assert.equal(state.activeSessionId, 'T1');
// 接着关闭 T1 后才兜底到后台新增的 T3 -> bg
state.removeSession('T1');
assert.equal(state.activeSessionId, 'T3');
state.removeSession('T3');
assert.equal(state.activeSpecialTab, 'agent-chat');
assert.equal(state.activeAgentTabKey, 'agent:bg');
console.log('PASS: 后台新增标签不插队、不抢焦点');

// 4. resolveStartingSession（含早到 terminal-created 竞态）保持 MRU 顺位
resetStore();
state.addSession(makeSession('S1'));
state.addSession(makeSession('S2'));
state.addSession(makeSession('starting-1', { starting: true }));
// 模拟 terminal-created 在 resolveStartingSession 之前先把真实 ID 作为后台会话写入
state.addSession(makeSession('real-1'), true);
assert.equal(state.resolveStartingSession('starting-1', 'real-1'), true);
assert.equal(state.activeSessionId, 'real-1');
state.setActiveSession('S1');
state.setActiveSession('real-1');
state.removeSession('real-1');
assert.equal(state.activeSessionId, 'S1');
console.log('PASS: resolveStartingSession 原地替换并保持 MRU 顺序');

// 5. 批量关闭（关闭左侧 / 关闭右侧 / 关闭其他）
resetStore();
state.addSession(makeSession('A'));
state.addSession(makeSession('B'));
state.addSession(makeSession('C'));
state.addSession(makeSession('D'));
// 激活顺序 A -> C -> B -> D (当前 D)
state.setActiveSession('A');
state.setActiveSession('C');
state.setActiveSession('B');
state.setActiveSession('D');
// 关闭非激活组 [A, B]，当前 D 保持激活
state.removeSessions(['A', 'B']);
assert.equal(state.activeSessionId, 'D');
// 关闭 D，激活上一个激活的 C
state.removeSession('D');
assert.equal(state.activeSessionId, 'C');
// 多标签批量关闭含当前激活态时，激活剩余中最晚使用过的
resetStore();
state.addSession(makeSession('A'));
state.addSession(makeSession('B'));
state.addSession(makeSession('C'));
state.addSession(makeSession('D'));
state.setActiveSession('C');
state.setActiveSession('B');
state.setActiveSession('D');
state.removeSessions(['B', 'D']); // B 和 D 都被关闭 -> 剩余 A、C 中 C 更近激活
assert.equal(state.activeSessionId, 'C');
console.log('PASS: 批量关闭保持非激活不变及回退 MRU');

// 6. 分屏模式下的激活与关闭规则
resetStore();
state.addSession(makeSession('P1'));
state.addSession(makeSession('P2'));
state.addSession(makeSession('P3'));
// 3 个会话时进入 2x1 产生两个空位，手动落位 P1、P2，P3 在隐藏池
state.cycleSplitMode();
assert.equal(state.splitMode, '2x1');
state.placeSessionInSplitSlot('P1');
state.placeSessionInSplitSlot('P2');
assert.equal(state.activeSessionId, 'P2');
// 访问隐藏的 P3 会替换最旧的 P1，此时分屏槽位为 [P3, P2]（P1 成为隐藏页签）
state.placeSessionInSplitSlot('P3');
assert.equal(state.activeSessionId, 'P3');
// 关闭 P3：跳过已隐藏的 P1，聚焦分屏内剩余的 P2
state.removeSession('P3');
assert.equal(state.activeSessionId, 'P2');
// 关闭最后一个分屏 P2：保持分屏模式并将 activeSessionId 置空
state.removeSession('P2');
assert.equal(state.splitMode, '2x1');
assert.equal(state.activeSessionId, null);

// 2x2 多分屏聚焦历史
resetStore();
state.addSession(makeSession('Q1'));
state.addSession(makeSession('Q2'));
state.cycleSplitMode(); // 2x1: [Q1, Q2]
state.cycleSplitMode(); // 2x2: [Q1, Q2, null, null]
state.addSession(makeSession('Q3'));
state.placeSessionInSplitSlot('Q3');
state.addSession(makeSession('Q4'));
state.placeSessionInSplitSlot('Q4');
state.setActiveSession('Q1');
state.setActiveSession('Q4');
state.setActiveSession('Q2');
state.removeSession('Q2'); // 上一个聚焦的分屏是 Q4
assert.equal(state.activeSessionId, 'Q4');
console.log('PASS: 分屏模式聚焦历史与隐藏会话跳过');

// 7. 持久化往返（桌面端重启恢复 & 浏览器刷新恢复）
resetStore();
state.addSession(makeSession('D0'));
state.addSession(makeSession('D1'));
state.addSession(makeSession('D2'));
state.openAgentTab(makeAgentTab('agent:na1'));
// 最近激活顺序：D1 -> agent:na1 -> D2 -> D0
state.setActiveSession('D0');
state.setActiveSession('D2');
state.setActiveAgentTab('agent:na1');
state.setActiveSession('D1');
await realAppStore.saveTabsToStorage(state.sessions, state.activeSessionId);
const savedPayload = await realAppStore.loadSavedTabs();
assert.deepEqual(savedPayload.recentTabs, ['s:1', 'a:agent:na1', 's:2', 's:0']);

// 模拟桌面端冷启动恢复
state = {
  currentDirectory: '',
  terminalLayoutVersion: 0,
  showToast: () => {},
  ...createTabsSlice(storeApi.setState),
  ...createProfilesSlice(storeApi.setState),
  ...createSessionsSlice(storeApi.setState, storeApi.getState),
  ...createAgentChatSlice(storeApi.setState, storeApi.getState),
};
await restoreModule.restoreTabs();
const [r0, r1, r2] = state.sessions.map(s => s.id);
assert.equal(state.activeSessionId, r1);
assert.equal(state.activeSpecialTab, null);
state.removeSession(r1);
assert.equal(state.activeSpecialTab, 'agent-chat');
assert.equal(state.activeAgentTabKey, 'agent:na1');
state.closeAgentTab('agent:na1');
assert.equal(state.activeSpecialTab, null);
assert.equal(state.activeSessionId, r2);
state.removeSession(r2);
assert.equal(state.activeSessionId, r0);
console.log('PASS: 桌面端重启恢复激活历史顺序');

// 模拟页面重载（切换本地 / 远程工作区）：本机 Rust 进程未退出，PTY 仍存活
// 命中 terminalId 的页签必须直接接回，不能按快照重复创建终端。
resetStore();
storedClientData.saved_tabs = JSON.stringify({
  tabs: [
    { profileId: 'p0', profileName: 'R0', terminalType: 'powershell', colorTheme: { background: '#1e1e1e', foreground: '#d4d4d4' }, tabColor: null, groupId: 'proj', groupName: '项目 A', owner: 'pc', terminalId: 'live-r0', directory: 'D:/saved' },
    { profileId: 'p1', profileName: 'R1', terminalType: 'powershell', colorTheme: { background: '#1e1e1e', foreground: '#d4d4d4' }, tabColor: null, groupId: 'default', owner: 'pc', terminalId: 'live-r1' },
  ],
  activeIndex: 1,
  agentTabs: [],
  activeAgentTabKey: null,
  agentChatActive: false,
  recentTabs: ['s:0', 's:1'],
});
liveTerminals = [
  { id: 'live-r0', profileId: 'p0', profileName: 'R0', group: '项目 A', terminalType: 'powershell', loadingMode: 'default', owner: 'pc', directory: 'D:/live' },
  { id: 'live-r1', profileId: 'p1', profileName: 'R1', group: '', terminalType: 'powershell', loadingMode: 'default', owner: 'pc' },
];
state = {
  currentDirectory: '',
  terminalLayoutVersion: 0,
  showToast: () => {},
  ...createTabsSlice(storeApi.setState),
  ...createProfilesSlice(storeApi.setState),
  ...createSessionsSlice(storeApi.setState, storeApi.getState),
  ...createAgentChatSlice(storeApi.setState, storeApi.getState),
};
const startsBeforeReload = nextTerminalSeq;
await restoreModule.restoreTabs();
assert.deepEqual(state.sessions.map(s => s.id), ['live-r0', 'live-r1']);
assert.equal(nextTerminalSeq, startsBeforeReload, '存活终端不应被重复创建');
assert.equal(state.activeSessionId, 'live-r1');
assert.equal(state.sessions[0].groupName, '项目 A');
assert.equal(state.sessionDirectories['live-r0'], 'D:/live');
console.log('PASS: 页面重载按存活终端接回，不重复创建 PTY');

// 模拟浏览器刷新（后端终端仍存活，reconcileBackendSessions 接回）
resetStore();
isBrowser = true;
storedClientData.saved_tabs = JSON.stringify({
  tabs: [
    { profileId: 'p0', profileName: 'B0', terminalType: 'bash', colorTheme: { background: '#1e1e1e', foreground: '#d4d4d4' }, tabColor: null, groupId: 'default', owner: 'web', terminalId: 'live-0' },
    { profileId: 'p1', profileName: 'B1', terminalType: 'bash', colorTheme: { background: '#1e1e1e', foreground: '#d4d4d4' }, tabColor: null, groupId: 'default', owner: 'web', terminalId: 'live-1' },
    { profileId: 'p2', profileName: 'B2', terminalType: 'bash', colorTheme: { background: '#1e1e1e', foreground: '#d4d4d4' }, tabColor: null, groupId: 'default', owner: 'web', terminalId: 'live-2' },
  ],
  activeIndex: 0,
  agentTabs: [],
  activeAgentTabKey: null,
  agentChatActive: false,
  recentTabs: ['s:0', 's:2', 's:1'],
});
liveTerminals = [
  { id: 'live-0', profileId: 'p0', profileName: 'B0', terminalType: 'bash', owner: 'web' },
  { id: 'live-1', profileId: 'p1', profileName: 'B1', terminalType: 'bash', owner: 'web' },
  { id: 'live-2', profileId: 'p2', profileName: 'B2', terminalType: 'bash', owner: 'web' },
];
await restoreModule.restoreTabs();
assert.equal(state.activeSessionId, 'live-0');
state.removeSession('live-0');
assert.equal(state.activeSessionId, 'live-2');
state.removeSession('live-2');
assert.equal(state.activeSessionId, 'live-1');
console.log('PASS: 浏览器刷新保留激活历史顺序');

console.log('\nALL TAB ACTIVATION CHECKS PASSED!');
