import { closeTerminal, getFileSize, startBlankTerminal, startTerminal, writeToTerminal } from './tauri';
import { loadSavedTabs, saveTabsToStorage, useAppStore } from '../stores/appStore';
import { getAppSettings } from '../utils/settings';
import { showAlert } from './dialog';
import type { TerminalSession } from '../types';

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
  return terminalType === 'powershell' || terminalType === 'pwsh' || terminalType === 'cmd';
}

function waitForNextFrame(): Promise<void> {
  return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

type SavedTab = Awaited<ReturnType<typeof loadSavedTabs>>['tabs'][number];

/** 恢复编辑器页签：文件仍存在则直接建会话，否则跳过。返回会话 id 或 undefined。 */
async function restoreEditorTab(tab: SavedTab): Promise<string | undefined> {
  const store = useAppStore.getState();
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
  // 清理 extraParams 中已有的 --resume 参数（防止历史数据叠加）
  const paramsWithoutResume = (tab.extraParams || '')
    .replace(/--resume\s+[0-9a-fA-F-]+/g, '');
  const baseParams = tab.extraParamMode === 'independent'
    ? paramsWithoutResume.trim()
    : paramsWithoutResume.replace(/\s+/g, ' ').trim();
  // 构建启动参数：临时追加 --resume（不存入 session，避免下次叠加）
  let launchParams = baseParams;
  if (tab.claudeSessionId && tab.profileId) {
    const settings = getAppSettings();
    if (settings.autoResumeClaudeSession) {
      const resumeParam = `--resume ${tab.claudeSessionId}`;
      launchParams = launchParams ? `${launchParams} ${resumeParam}` : resumeParam;
    }
  }
  const startupPath = tab.directory && isLocalShellTerminal(tab.terminalType)
    ? tab.directory
    : undefined;
  const terminalId = tab.profileId
    ? await startTerminal(tab.profileId, launchParams, estRows, estCols, tab.profileName, startupPath, undefined, undefined, tab.extraParamMode)
    : await startBlankTerminal(tab.terminalType as 'powershell' | 'pwsh' | 'cmd' | 'ssh' | 'docker' | 'k8s', estRows, estCols, startupPath, tab.profileName);
  store.addSession({
    id: terminalId,
    profileId: tab.profileId,
    profileName: tab.profileName,
    terminalType: tab.terminalType as any,
    colorTheme: tab.colorTheme,
    tabColor: tab.tabColor,
    groupId: tab.groupId || 'default',
    groupName: tab.groupName,
    owner: 'pc',
    extraParams: baseParams,
    extraParamMode: tab.extraParamMode,
    extraParamTag: tab.extraParamTag,
    extraParamTagColor: tab.extraParamTagColor ?? null,
  }, true);
  // 保存 claudeSessionId 到 store
  if (tab.claudeSessionId) {
    store.setClaudeSessionId(terminalId, tab.claudeSessionId);
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

/** 恢复上次保存的页签：活动页签优先，其余并发池恢复，完成后统一落盘。 */
export async function restoreTabs() {
  const { tabs, activeIndex } = await loadSavedTabs();
  if (tabs.length === 0) return;
  const restoredSessionIds: Array<string | undefined> = new Array(tabs.length);
  // 暂停逐次写入，恢复完后统一写一次
  useAppStore.setState({ _skipSaveTabs: true });
  try {
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
