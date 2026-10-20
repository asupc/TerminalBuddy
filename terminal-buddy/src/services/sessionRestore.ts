import {
  claimWebSessionRestore,
  closeTerminal,
  getClaudeSessionsForTerminals,
  getFileSize,
  listTerminals,
  releaseWebSessionRestore,
  startBlankTerminal,
  startTerminal,
  writeToTerminal,
} from './tauri';
import { loadSavedTabs, saveTabsToStorage, useAppStore } from '../stores/appStore';
import { flushPendingSaveTabsIfAny } from '../stores/slices/sessionsSlice';
import { getAppSettings, isAppSettingsInitialized } from '../utils/settings';
import { containsClaudeRef, isClaudeCommand } from '../utils/claudeLaunch';
import { showAlert } from './dialog';
import { PRESET_THEMES } from '../types';
import type { TerminalSession } from '../types';
import { isBrowserClient, clientTerminalOwner } from './platform';
import { hasUpdatingTerminals } from './browser/updateState';
import { stripResumeArgs } from '../utils/commandParams';

const RESTORE_TERMINAL_CONCURRENCY = 2;

/** Estimate terminal rows/cols from the .terminal-content container size. */
function estimateTerminalSize(): { rows: number; cols: number } {
  const content = document.querySelector('.terminal-content');
  if (!content) return { rows: 0, cols: 0 };
  const w = content.clientWidth;
  const h = content.clientHeight;
  const availW = w - 20; // .xterm padding: 10px each side
  const availH = h - 20;
  const cols = Math.max(2, Math.floor(availW / 8.4));
  const rows = Math.max(1, Math.floor(availH / 17));
  return { rows, cols };
}

function isLocalShellTerminal(terminalType: string): boolean {
  return ['powershell', 'pwsh', 'cmd', 'bash', 'sh', 'zsh'].includes(terminalType);
}

function waitForNextFrame(): Promise<void> {
  return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

type SavedTab = Awaited<ReturnType<typeof loadSavedTabs>>['tabs'][number];

/** 恢复编辑器页签：文件仍存在则直接建会话，否则跳过。返回会话 id 或 undefined。 */
async function restoreEditorTab(tab: SavedTab): Promise<string | undefined> {
  const store = useAppStore.getState();
  // 浏览器刷新与容器重启恢复可能先后走到这里，已存在的 editor 会话直接复用。
  const existing = store.sessions.find(
    session => session.sessionType === 'editor' && session.profileId === tab.profileId,
  );
  if (existing) return existing.id;
  store.ensureEditorGroup();
  try {
    await getFileSize(tab.profileId);
    const session: TerminalSession = {
      id: crypto.randomUUID(),
      profileId: tab.profileId,
      profileName: tab.profileName,
      terminalType: 'editor',
      colorTheme: tab.colorTheme,
      tabColor: tab.tabColor,
      groupId: 'editor-group',
      sessionType: 'editor',
      isDirty: false,
    };
    store.addSession(session, true);
    return session.id;
  } catch {
    // File no longer exists, skip this tab
    return undefined;
  }
}

/** 恢复终端页签：重建 PTY 并回填会话（含 --resume 参数与目录记录）。返回终端 id 或 undefined。 */
async function restoreTerminalTab(tab: SavedTab): Promise<string | undefined> {
  const store = useAppStore.getState();
  const { rows: estRows, cols: estCols } = estimateTerminalSize();
  const rawParams = tab.extraParams || '';
  // 旧数据可能把 --resume 直接存进 extraParams（例如从历史会话恢复出来的页签）。
  // 先取出 ID 再剥除：既避免重复拼接，也避免 claudeSessionId 缺失时丢失恢复意图。
  const { params: paramsWithoutResume, resumeId: savedResumeId } = stripResumeArgs(rawParams);
  const baseParams = tab.extraParamMode === 'independent'
    ? paramsWithoutResume.trim()
    : paramsWithoutResume.replace(/\s+/g, ' ').trim();
  const resumeId = tab.claudeSessionId || savedResumeId;
  // 构建启动参数：临时追加 --resume（不存入 session，避免下次叠加）
  let launchParams = baseParams;
  if (resumeId) {
    const settings = getAppSettings();
    if (settings.autoResumeClaudeSession) {
      const resumeParam = `--resume ${resumeId}`;
      launchParams = launchParams ? `${launchParams} ${resumeParam}` : resumeParam;
    }
  }
  const startupPath = tab.directory && isLocalShellTerminal(tab.terminalType)
    ? tab.directory
    : undefined;
  // 空白终端（项目右键启动等）的 extraParams 保存的是完整启动命令，恢复时重跑：
  // - 命令跑 claude（含模型引用标记）→ 连同 --resume 一起恢复会话
  // - 命令不含 claude 但记录了会话（当时手动敲的 claude）→ 只重跑原命令，
  //   追加 --resume 会把原命令拼坏
  // - 没保存命令（纯手动敲 claude 的空白终端）→ 直接 claude --resume
  const blankCommand = !tab.profileId
    ? (baseParams
      ? ((isClaudeCommand(baseParams) || containsClaudeRef(baseParams)) ? launchParams : baseParams)
      : (launchParams ? `claude ${launchParams}` : undefined))
    : undefined;
  const terminalId = tab.profileId
    ? await startTerminal(tab.profileId, launchParams, estRows, estCols, tab.profileName, startupPath, undefined, undefined, tab.extraParamMode)
    : await startBlankTerminal(
      tab.terminalType as 'powershell' | 'pwsh' | 'cmd' | 'bash' | 'sh' | 'zsh' | 'ssh' | 'docker' | 'k8s',
      estRows,
      estCols,
      startupPath,
      tab.profileName,
      blankCommand,
      undefined,
      undefined,
      // 项目启动的空白终端依靠分组名归位；不传的话容器重启后会掉进“默认”。
      tab.groupName,
    );
  store.addSession({
    id: terminalId,
    profileId: tab.profileId,
    profileName: tab.profileName,
    terminalType: tab.terminalType as any,
    colorTheme: tab.colorTheme,
    tabColor: tab.tabColor,
    groupId: tab.groupId || 'default',
    groupName: tab.groupName,
    owner: clientTerminalOwner(),
    startupPath: tab.startupPath,
    extraParams: tab.profileId ? baseParams : tab.extraParams,
    extraParamMode: tab.extraParamMode,
    extraParamTag: tab.extraParamTag,
    extraParamTagColor: tab.extraParamTagColor ?? null,
  }, true);
  // 保存 claudeSessionId 到 store
  if (resumeId) {
    store.setClaudeSessionId(terminalId, resumeId);
  }
  // 恢复上次记录的目录：本地 shell 直接用启动 cwd，避免恢复时额外写入
  // 可见的 cd 命令与后端启动命令（powershell/claude）发生竞态。
  if (tab.directory) {
    store.setSessionDirectory(terminalId, tab.directory);
    if (!startupPath) {
      writeToTerminal(terminalId, `cd "${tab.directory}"\r`).catch(() => {});
    }
  }
  return terminalId;
}

interface RestoreSavedTabsOptions {
  /** 浏览器重启恢复：先移除后端已不存在的前端会话，避免新旧页签并存。 */
  dropStaleSessions?: boolean;
}

/**
 * 恢复页签集合：活动页签优先，其余并发池恢复，完成后统一落盘。
 * 返回成功恢复的会话 id；空数组表示一个都没恢复（调用方可据此回滚一次性恢复锁）。
 */
async function restoreSavedTabs(
  tabs: SavedTab[],
  activeIndex: number,
  options: RestoreSavedTabsOptions = {},
): Promise<string[]> {
  if (tabs.length === 0) return [];
  const restoredSessionIds: Array<string | undefined> = new Array(tabs.length);
  // 暂停逐次写入，恢复完后统一写一次
  useAppStore.setState({ _skipSaveTabs: true });
  try {
    if (options.dropStaleSessions) {
      // 容器重启后旧 PTY 已消失；先清掉前端残留，避免恢复期间新旧页签并存。
      // removeSessions 已遵守 _skipSaveTabs，不会把中间状态写盘。
      const staleIds = useAppStore.getState().sessions
        .filter(session => session.sessionType !== 'editor')
        .map(session => session.id);
      if (staleIds.length > 0) useAppStore.getState().removeSessions(staleIds);
    }
    const restoreTab = async (i: number) => {
      const tab = tabs[i];
      try {
        if (tab.sessionType === 'editor') {
          restoredSessionIds[i] = await restoreEditorTab(tab);
        } else {
          restoredSessionIds[i] = await restoreTerminalTab(tab);
        }
        if (i === activeIndex || useAppStore.getState().activeSessionId === null) {
          const id = restoredSessionIds[i];
          if (id) useAppStore.getState().setActiveSession(id);
        }
      } catch (err) {
        console.error('Failed to restore tab:', tab.profileName, err);
        // 单页签失败不中断其余恢复（并发池隔离），但必须明确提示：
        // 引用展开失败（供应商被删）时用户需要知道去重新选择模型。
        useAppStore.getState().showToast(`恢复页签「${tab.profileName}」失败：${String(err)}`, 'error');
      }
    };

    // 优先恢复并展示上次活动标签，避免等待全部终端启动后才出现可操作界面。
    await restoreTab(activeIndex);

    const pendingIndexes = tabs
      .map((_, index) => index)
      .filter(index => index !== activeIndex);
    let nextPendingIndex = 0;
    const worker = async () => {
      while (nextPendingIndex < pendingIndexes.length) {
        const index = pendingIndexes[nextPendingIndex++];
        // 启动下一项前先让出一帧，并用 worker 上限控制重型组件的初始化峰值。
        await waitForNextFrame();
        await restoreTab(index);
      }
    };
    const workerCount = Math.min(RESTORE_TERMINAL_CONCURRENCY, pendingIndexes.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  } finally {
    // 并发完成顺序不稳定，恢复为保存时的标签顺序，同时保留恢复期间外部新建的会话。
    const restoredIdSet = new Set(restoredSessionIds.filter((id): id is string => id !== undefined));
    useAppStore.setState(state => {
      const sessionsById = new Map(state.sessions.map(session => [session.id, session]));
      const restoredSessions = restoredSessionIds
        .map(id => id ? sessionsById.get(id) : undefined)
        .filter((session): session is TerminalSession => session !== undefined);
      const otherSessions = state.sessions.filter(session => !restoredIdSet.has(session.id));
      return { sessions: [...restoredSessions, ...otherSessions] };
    });
    const store = useAppStore.getState();
    const restoredActiveId = restoredSessionIds[activeIndex]
      ?? restoredSessionIds.find((id): id is string => id !== undefined)
      ?? null;
    store.setActiveSession(restoredActiveId);
    useAppStore.setState({ _skipSaveTabs: false });
    const { sessions, activeSessionId } = useAppStore.getState();
    saveTabsToStorage(sessions, activeSessionId);
  }
  return restoredSessionIds.filter((id): id is string => id !== undefined);
}

/**
 * 从服务端持久化登记表回填旧页签的 Claude 会话 ID。
 * 容器重启后旧 terminalId 已不存在，只能按 ID 回查（登记表由服务端后台任务维护）。
 */
async function backfillClaudeSessionIds(tabs: SavedTab[]): Promise<void> {
  const ids = [...new Set(tabs
    .filter(tab => tab.sessionType !== 'editor' && tab.terminalId && !tab.claudeSessionId)
    .map(tab => tab.terminalId!))];
  if (ids.length === 0) return;
  try {
    const persisted = await getClaudeSessionsForTerminals(ids);
    for (const tab of tabs) {
      if (!tab.claudeSessionId && tab.terminalId && persisted[tab.terminalId]) {
        tab.claudeSessionId = persisted[tab.terminalId];
      }
    }
  } catch (error) {
    console.error('回查 Claude 会话 ID 失败:', error);
  }
}

export type BrowserSessionRestoreOutcome = 'not-needed' | 'restored' | 'claimed-elsewhere' | 'failed';

let browserRestoreInFlight: Promise<BrowserSessionRestoreOutcome> | null = null;

/**
 * 浏览器端在「后端没有任何存活终端」时恢复上次页签（容器重启后的主路径）。
 * 服务端一次性租约保证多个浏览器同时打开时只有一份 PTY / 一份 claude --resume。
 */
export function ensureBrowserSessionsRestored(afterUpdate = false): Promise<BrowserSessionRestoreOutcome> {
  if (!browserRestoreInFlight) {
    browserRestoreInFlight = runBrowserSessionRestore(afterUpdate)
      .finally(() => { browserRestoreInFlight = null; });
  }
  return browserRestoreInFlight;
}

async function runBrowserSessionRestore(afterUpdate: boolean): Promise<BrowserSessionRestoreOutcome> {
  if (!isBrowserClient() || !isAppSettingsInitialized()) return 'not-needed';
  const settings = getAppSettings();
  // dev 下 Vite 重启频繁，自动拉起 claude --resume 会很吵；与启动恢复保持一致。
  if (!afterUpdate && (hasUpdatingTerminals() || !settings.restoreTabsOnStartup || import.meta.env.DEV)) return 'not-needed';

  let live;
  try {
    live = await listTerminals();
  } catch (error) {
    console.error('列出后端终端失败:', error);
    return 'failed';
  }
  // 服务端仍存活：普通刷新只接回，不重复创建 PTY。
  if (live.length > 0) return 'not-needed';

  // 用户刚关闭会话时页签保存可能还在防抖窗口内。先落盘，避免恢复读到旧列表，
  // 把刚关掉的会话重新创建出来。
  await flushPendingSaveTabsIfAny();
  const { tabs, activeIndex } = await loadSavedTabs();
  // PC 端页签由桌面端负责恢复，浏览器不越权重建。
  const terminalTabs = tabs.filter(tab => tab.sessionType !== 'editor' && tab.owner !== 'pc');
  if (terminalTabs.length === 0) {
    // 没有可恢复的 Web 页签时，顺手清掉前端残留的失效会话，避免一直显示“正在重连”。
    await clearStaleBrowserSessions();
    return 'not-needed';
  }

  let claimed = false;
  try {
    claimed = await claimWebSessionRestore();
  } catch (error) {
    console.error('申请恢复锁失败:', error);
    return 'failed';
  }
  if (!claimed) return 'claimed-elsewhere';

  try {
    // 抢到锁后二次确认：另一个客户端可能刚恢复完成并释放租约。
    if ((await listTerminals()).length > 0) return 'not-needed';
    await backfillClaudeSessionIds(terminalTabs);
    const savedActiveTab = tabs[activeIndex];
    let activeTerminalIndex = savedActiveTab ? terminalTabs.indexOf(savedActiveTab) : -1;
    if (activeTerminalIndex < 0) activeTerminalIndex = 0;
    const restored = await restoreSavedTabs(terminalTabs, activeTerminalIndex, { dropStaleSessions: true });
    if (restored.length === 0) {
      console.error('浏览器页签恢复失败：没有任何页签恢复成功');
      return 'failed';
    }
    return 'restored';
  } catch (error) {
    console.error('浏览器页签恢复失败:', error);
    return 'failed';
  } finally {
    // 成功或失败都释放；服务端租约另有 TTL 兜底，防止客户端断线后永久占用。
    await releaseWebSessionRestore().catch(() => {});
  }
}

/** 显式自更新后恢复当前网页连接，不刷新页面，也不依赖启动恢复开关。 */
export async function reconnectBrowserAfterUpdate(): Promise<boolean> {
  await resyncChain;
  const outcome = await ensureBrowserSessionsRestored(true);
  if (outcome === 'failed' || outcome === 'claimed-elsewhere') return false;
  await reconcileBackendSessions(true);
  return (await listTerminals()).length > 0;
}

/** 关闭恢复开关但页面跨容器重启时，清掉前端残留的失效页签。 */
async function clearStaleBrowserSessions(): Promise<void> {
  if (!isBrowserClient() || hasUpdatingTerminals()) return;
  const terminals = await listTerminals().catch(() => null);
  if (!terminals || terminals.length > 0) return;
  const stale = useAppStore.getState().sessions.filter(session => session.sessionType !== 'editor');
  if (stale.length > 0) {
    useAppStore.getState().removeSessions(stale.map(session => session.id));
  }
}

let resyncChain: Promise<void> = Promise.resolve();
let startupRestoreComplete = false;

/** 启动流程（含初始恢复与对账）结束后才允许 web-resync 走重启恢复逻辑。 */
export function markStartupRestoreComplete(): void {
  startupRestoreComplete = true;
}

interface BrowserResyncOptions {
  /**
   * 是否允许「后端无存活终端 → 按保存的页签重建」。
   * 只有事件连接（重新）建立时才允许：这可能是容器重启，旧 PTY 已消失。
   * 终端增删也会触发 web-resync，此时若允许恢复，用户关闭最后一个会话后会被立刻重建。
   */
  allowRestore?: boolean;
}

/**
 * web-resync 在 socket 打开、终端增删和事件丢包时都会触发，可能连续多次到达。
 * 串行处理，避免同一客户端并发执行恢复/对账。
 */
export function scheduleBrowserResync(options: BrowserResyncOptions = {}): void {
  if (!isBrowserClient()) return;
  resyncChain = resyncChain.then(async () => {
    if (!startupRestoreComplete || hasUpdatingTerminals()) return;
    const settings = getAppSettings();
    if (settings.restoreTabsOnStartup && !import.meta.env.DEV) {
      if (options.allowRestore) await ensureBrowserSessionsRestored();
    } else {
      await clearStaleBrowserSessions();
    }
    await reconcileBackendSessions();
  }).catch(error => {
    console.error('网页会话重同步失败:', error);
  });
}

/** 恢复上次保存的页签：活动页签优先，其余并发池恢复，完成后统一落盘。 */
export async function restoreTabs() {
  const { tabs, activeIndex } = await loadSavedTabs();
  if (isBrowserClient()) {
    // 每次页面加载都恢复 editor 页签（幂等）；终端页签只在服务端重启后重建。
    for (const tab of tabs) {
      if (tab.sessionType === 'editor') await restoreEditorTab(tab);
    }
    await ensureBrowserSessionsRestored();
    await reconcileBackendSessions();
    return;
  }
  await restoreSavedTabs(tabs, activeIndex);
}

/**
 * 与后端存活会话对账，补建前端缺失的页签。
 *
 * 桌面端建页签只由 `terminal-created` 事件驱动，而默认终端 handoff 会话往往建得更早：
 * COM 类在 setup 里注册，OpenConsole 的激活调用（约 rust+340ms）可以早于 WebView
 * 加载完成（约 rust+415ms）。事件发进还没有监听器的窗口就被丢弃，双击的 bat 于是
 * 在一间看不见的会话里跑完。启动流程末尾按后端真实存活列表补一次账。
 */
export async function reconcileBackendSessions(afterUpdate = false) {
  if (hasUpdatingTerminals() && !afterUpdate) return;
  let terminals;
  try {
    terminals = await listTerminals();
  } catch (error) {
    console.error('Failed to list backend terminals:', error);
    return;
  }
  // 浏览器端只有拿到非空列表才能判断“哪些会话已失效”。容器重启窗口里后端可能
  // 暂时为 0，此时按空列表清空会触发保存，把 web_saved_tabs 覆盖成空文件，
  // 必须等恢复流程先跑完。
  if (isBrowserClient() && terminals.length > 0) {
    const ids = new Set(terminals.map(terminal => terminal.id));
    useAppStore.getState().removeSessions(useAppStore.getState().sessions
      .filter(session => session.sessionType !== 'editor' && !session.starting && !ids.has(session.id)).map(session => session.id));
  }
  for (const terminal of terminals) {
    const store = useAppStore.getState();
    // 占位会话还没回填成真实 terminalId，此时补建会和它撞成两个页签。
    if (store.sessions.some(session => session.starting)) return;
    const existingSession = store.sessions.find(session => session.id === terminal.id);
    if (existingSession) {
      store.updateSession(terminal.id, {
        profileName: terminal.profileName,
        owner: terminal.owner,
        groupName: existingSession.groupName || terminal.group || undefined,
        extraParams: terminal.extraStartupParams ?? existingSession.extraParams,
        extraParamMode: terminal.extraStartupMode ?? existingSession.extraParamMode,
        extraParamTag: terminal.extraParamTag ?? existingSession.extraParamTag,
        extraParamTagColor: terminal.extraParamTagColor ?? existingSession.extraParamTagColor,
      });
      continue;
    }
    const profile = store.profiles.find(item => item.id === terminal.profileId);
    const theme = PRESET_THEMES.find(item => item.id === profile?.colorTheme) || PRESET_THEMES[0];
    // 无活动页签时必须把补建的页签选上，否则用户看到的还是空窗口（与 handoff
    // 事件路径 activate=true 的语义一致）；已有活动页签则不抢焦点。
    const keepActive = store.activeSessionId !== null;
    store.addSession({
      id: terminal.id,
      profileId: terminal.profileId,
      profileName: terminal.profileName,
      terminalType: terminal.terminalType as TerminalSession['terminalType'],
      colorTheme: { background: theme.background, foreground: theme.foreground },
      tabColor: profile?.tabColor || null,
      groupId: 'default',
      groupName: terminal.group || undefined,
      owner: terminal.owner,
      extraParams: terminal.extraStartupParams,
      extraParamMode: terminal.extraStartupMode,
      extraParamTag: terminal.extraParamTag,
      extraParamTagColor: terminal.extraParamTagColor,
    }, keepActive);
  }
}

export interface LaunchTerminalSessionOptions {
  addSession: (session: TerminalSession, keepActive?: boolean) => void;
  resolveStartingSession: (startingId: string, terminalId: string) => boolean;
  /** 构造占位会话（starting: true 由本函数补齐）。 */
  makeSession: (startingId: string) => TerminalSession;
  /** 启动后端 PTY，返回 terminalId。 */
  start: (rows: number, cols: number) => Promise<string>;
  /** 启动成功后的收尾（记录最后使用、同步目录等）。 */
  onStarted?: (terminalId: string) => void;
  /** 失败日志前缀（区分「启动终端」/「启动空白终端」）。 */
  errorLogPrefix: string;
}

/**
 * 终端启动公共流程：占位会话 → 分屏落位 → 启动 PTY → 解析回填，
 * 失败时清理占位并弹窗。handleStartTerminal / handleStartBlankTerminal 共用。
 */
export async function launchTerminalSession(opts: LaunchTerminalSessionOptions): Promise<void> {
  let startingId: string | null = null;
  try {
    const { rows, cols } = estimateTerminalSize();
    startingId = crypto.randomUUID();
    opts.addSession({ ...opts.makeSession(startingId), id: startingId, starting: true });
    const pendingStore = useAppStore.getState();
    if (pendingStore.splitMode !== 'off') pendingStore.placeSessionInSplitSlot(startingId);

    const terminalId = await opts.start(rows, cols);
    if (!opts.resolveStartingSession(startingId, terminalId)) {
      void closeTerminal(terminalId).catch(() => {});
      return;
    }
    opts.onStarted?.(terminalId);
  } catch (err) {
    console.error(opts.errorLogPrefix, err);
    const startingSessionVisible = startingId !== null
      && useAppStore.getState().sessions.some(session => session.id === startingId);
    if (startingId) useAppStore.getState().removeSession(startingId);
    if (startingSessionVisible) void showAlert('启动终端失败: ' + String(err), '启动失败');
  }
}
