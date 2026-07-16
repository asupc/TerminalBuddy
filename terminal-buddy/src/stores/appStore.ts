import { create } from 'zustand';
import type { Profile, TerminalSession, CustomTheme, TabGroup, ExtraParamPreset, RemoteFileEntry, ServerStats, TransferItem } from '../types';
import { readClientData, writeClientData, getDataPath, ensureDir, writeFileContent, deletePath, saveEnableTabNavigation, updateTerminalDisplayName } from '../services/tauri';
import { getAppSettings, saveAppSettings } from '../utils/settings';
import { TERMINAL_SPLIT_TRANSITION_GUARD_MS } from '../utils/terminalResizeEvent';

let _saveTabsTimer: ReturnType<typeof setTimeout> | null = null;
function debouncedSaveTabs(sessions: any[], activeSessionId: string | null) {
  if (_saveTabsTimer) clearTimeout(_saveTabsTimer);
  _saveTabsTimer = setTimeout(() => {
    saveTabsToStorage(sessions, activeSessionId);
  }, 300);
}

interface SavedTab {
  profileId: string;
  profileName: string;
  terminalType: string;
  colorTheme: { background: string; foreground: string };
  tabColor: string | null;
  groupId: string;
  sessionType?: 'terminal' | 'editor';
  isDirty?: boolean;
  owner?: 'pc' | 'web';
  extraParams?: string;
  directory?: string;
  claudeSessionId?: string;
}

export interface GitHistoryTab {
  repoRoot: string;
  branch: string;
}

export type WorkspaceSpecialTab = 'git-history' | null;

export type TerminalRuntimeKind = 'shell' | 'claude';
export type TerminalActivityPhase = 'idle' | 'running' | 'attention' | 'completed' | 'failed';

export interface TerminalActivityState {
  runtimeKind: TerminalRuntimeKind;
  source: 'legacy' | 'hook';
  phase: TerminalActivityPhase;
  updatedAt: number;
  lastHookAt?: number;
}

export function isTerminalWorking(activity: TerminalActivityState | undefined): boolean {
  return activity?.phase === 'running';
}

export function saveTabsToStorage(sessions: TerminalSession[], activeSessionId: string | null) {
  try {
    const dirs = useAppStore.getState().sessionDirectories;
    const claudeIds = useAppStore.getState().claudeSessionIds;
    const tabs: SavedTab[] = sessions.map(s => ({
      profileId: s.profileId,
      profileName: s.profileName,
      terminalType: s.terminalType,
      colorTheme: s.colorTheme,
      tabColor: s.tabColor,
      groupId: s.groupId,
      sessionType: s.sessionType,
      isDirty: s.sessionType === 'editor' ? false : undefined,
      owner: s.owner,
      extraParams: s.extraParams,
      directory: dirs[s.id],
      claudeSessionId: claudeIds[s.id],
    }));
    const activeIndex = activeSessionId
      ? sessions.findIndex(s => s.id === activeSessionId)
      : -1;
    writeClientData('saved_tabs', JSON.stringify({ tabs, activeIndex })).catch(() => {});
  } catch {}
}

export async function loadSavedTabs(): Promise<{ tabs: SavedTab[]; activeIndex: number }> {
  try {
    const raw = await readClientData('saved_tabs');
    if (raw) {
      const data = JSON.parse(raw);
      const tabs: SavedTab[] = data.tabs || [];
      const activeIndex = data.activeIndex ?? 0;
      return { tabs, activeIndex: Math.min(activeIndex, Math.max(tabs.length - 1, 0)) };
    }
  } catch {}
  return { tabs: [], activeIndex: 0 };
}

export async function initExtraParamPresets() {
  try {
    const raw = await readClientData('extra_param_presets');
    if (raw) {
      useAppStore.setState({ extraParamPresets: JSON.parse(raw) });
    }
  } catch {}
}

export async function initFileTreeNav() {
  try {
    const raw = await readClientData('file_nav');
    if (raw) {
      const data = JSON.parse(raw);
      if (Array.isArray(data?.backStack)) {
        useAppStore.setState({ navBackStack: data.backStack.filter((p: unknown) => typeof p === 'string') });
      }
      if (Array.isArray(data?.forwardStack)) {
        useAppStore.setState({ navForwardStack: data.forwardStack.filter((p: unknown) => typeof p === 'string') });
      }
      if (data?.sortBy === 'name' || data?.sortBy === 'size' || data?.sortBy === 'modified') {
        useAppStore.setState({ fileSortBy: data.sortBy });
      }
      if (data?.sortDir === 'asc' || data?.sortDir === 'desc') {
        useAppStore.setState({ fileSortDir: data.sortDir });
      }
      if (Array.isArray(data?.roots)) {
        const fileRoots = data.roots
          .filter((path: unknown): path is string => typeof path === 'string' && path.trim().length > 0)
          .filter((path: string, index: number, paths: string[]) => (
            paths.findIndex(candidate => candidate.toLowerCase() === path.toLowerCase()) === index
          ));
        useAppStore.setState({ fileRoots });
      }
    }
  } catch {}
}

function persistFileTreeNav(state: { navBackStack: string[]; navForwardStack: string[]; fileSortBy: 'name' | 'size' | 'modified'; fileSortDir: 'asc' | 'desc'; fileRoots: string[] }) {
  writeClientData('file_nav', JSON.stringify({
    backStack: state.navBackStack,
    forwardStack: state.navForwardStack,
    sortBy: state.fileSortBy,
    sortDir: state.fileSortDir,
    roots: state.fileRoots,
  })).catch(() => {});
}

// --- Draft management ---

export interface DraftEntry {
  filePath: string;
  createdAt: number;
}

async function loadDraftIndex(): Promise<DraftEntry[]> {
  try {
    const raw = await readClientData('drafts_index');
    if (raw) {
      const data = JSON.parse(raw);
      return Array.isArray(data) ? data : [];
    }
  } catch {}
  return [];
}

async function saveDraftIndex(drafts: DraftEntry[]): Promise<void> {
  await writeClientData('drafts_index', JSON.stringify(drafts));
}

async function ensureDraftsDir(): Promise<string> {
  const dataPath = await getDataPath();
  const draftsDir = dataPath + '\\ClientData\\drafts';
  await ensureDir(draftsDir);
  return draftsDir;
}

interface AppState {
  // Profiles
  profiles: Profile[];
  selectedProfileId: string | null;
  setProfiles: (profiles: Profile[]) => void;
  addProfile: (profile: Profile) => void;
  updateProfile: (profile: Profile) => void;
  removeProfile: (id: string) => void;
  selectProfile: (id: string | null) => void;

  // UI State
  configPanelVisible: boolean;
  fileTreeVisible: boolean;
  toggleConfigPanel: () => void;
  toggleFileTree: () => void;

  // Config panel search & sort
  configSearchQuery: string;
  configSortBy: 'name-asc' | 'name-desc' | 'recent' | 'oldest' | 'created-new' | 'created-old';
  setConfigSearchQuery: (query: string) => void;
  setConfigSortBy: (sortBy: AppState['configSortBy']) => void;

  // Settings dialog and workspace special tabs
  settingsDialogOpen: boolean;
  openSettingsDialog: () => void;
  closeSettingsDialog: () => void;
  gitHistoryTab: GitHistoryTab | null;
  openGitHistoryTab: (tab: GitHistoryTab) => void;
  closeGitHistoryTab: () => void;
  activeSpecialTab: WorkspaceSpecialTab;
  setActiveSpecialTab: (tab: WorkspaceSpecialTab) => void;

  // File exclusion patterns
  exclusionPatterns: string[];
  setExclusionPatterns: (patterns: string[]) => void;

  // File tree navigation history (back/forward across directories)
  navBackStack: string[];
  navForwardStack: string[];
  navigateWithHistory: (path: string) => void;
  navBack: () => string | null;
  navForward: () => string | null;

  // File tree sort preference
  fileSortBy: 'name' | 'size' | 'modified';
  fileSortDir: 'asc' | 'desc';
  setFileSort: (by: 'name' | 'size' | 'modified', dir: 'asc' | 'desc') => void;
  fileRoots: string[];
  addFileRoot: (path: string) => void;
  removeFileRoot: (path: string) => void;

  // Custom themes
  customThemes: CustomTheme[];
  setCustomThemes: (themes: CustomTheme[]) => void;
  addCustomTheme: (theme: CustomTheme) => void;
  updateCustomTheme: (theme: CustomTheme) => void;
  removeCustomTheme: (id: string) => void;

  // Tab Groups
  groups: TabGroup[];
  addGroup: (name: string, color?: string) => void;
  removeGroup: (id: string) => void;
  renameGroup: (id: string, name: string) => void;
  setGroupColor: (id: string, color: string) => void;
  toggleGroupCollapse: (id: string) => void;
  moveSessionToGroup: (sessionId: string, groupId: string) => void;

  // Workspace
  currentWorkspaceId: string | null;
  workspaceModified: boolean;
  setCurrentWorkspace: (id: string | null) => void;
  setWorkspaceModified: (modified: boolean) => void;

  // Terminal Sessions
  sessions: TerminalSession[];
  activeSessionId: string | null;
  currentDirectory: string;
  setCurrentDirectory: (path: string) => void;
  _skipSaveTabs: boolean;
  addSession: (session: TerminalSession, keepActive?: boolean) => void;
  removeSession: (id: string) => void;
  setActiveSession: (id: string | null) => void;
  setSessions: (sessions: TerminalSession[]) => void;
  renameSession: (id: string, name: string) => void;
  updateSession: (id: string, updates: Partial<TerminalSession>) => void;
  ensureEditorGroup: () => void;
  openEditorSession: (filePath: string, sshRemotePath?: string, sshTerminalId?: string) => void;
  closeEditorSession: (id: string) => void;
  openDraftSession: () => Promise<void>;
  removeDraftFile: (draftPath: string) => Promise<void>;
  restoreDraftTabs: () => Promise<void>;
  sessionDirectories: Record<string, string>;
  setSessionDirectory: (sessionId: string, path: string) => void;

  // Claude Code session IDs
  claudeSessionIds: Record<string, string>;
  setClaudeSessionId: (sessionId: string, claudeSessionId: string) => void;

  // Unified terminal activity. Claude Hook becomes authoritative after first valid event.
  terminalActivities: Record<string, TerminalActivityState>;
  terminalWebTakeovers: Record<string, boolean>;
  setTerminalWebTakeover: (sessionId: string, active: boolean) => void;
  setTerminalFallbackWorking: (sessionId: string, working: boolean) => void;
  applyClaudeHookActivity: (sessionId: string, phase: TerminalActivityPhase, updatedAt: number) => boolean;
  endClaudeHookSession: (sessionId: string, updatedAt: number) => boolean;
  expireClaudeHookActivity: (sessionId: string, expectedUpdatedAt: number) => void;
  handleTerminalInputActivity: (sessionId: string) => void;

  // Split Screen mode
  splitMode: 'off' | '2x1' | '2x2';
  splitSlots: { sessionId: string | null; enteredAt: number }[];
  terminalLayoutVersion: number;
  splitTransitionUntil: number;
  cycleSplitMode: () => void;
  closeSplitPane: (slotIndex: number) => void;
  swapSplitSlots: (i: number, j: number) => void;
  placeSessionInSplitSlot: (sessionId: string) => void;

  // Window mode (F11 cycle)
  windowMode: 'normal' | 'panels-hidden';
  previousPanelState: { configPanelVisible: boolean; fileTreeVisible: boolean; enableTabNavigation: boolean } | null;
  cycleWindowMode: () => void;

  // Toast (transient notifications, e.g. "split grid full")
  toast: { id: number; message: string; type: 'info' | 'success' | 'error' } | null;
  showToast: (message: string, type?: 'info' | 'success' | 'error') => void;
  dismissToast: (id: number) => void;

  // Settings version (incremented when settings change, triggers re-render in subscribers)
  settingsVersion: number;
  incrementSettingsVersion: () => void;

  // Internal drag paths (from FileTree to terminal)
  dragPaths: string[] | null;
  setDragPaths: (paths: string[] | null) => void;

  // 拖拽中的 profile id（ConfigNav → TabNav 启动终端）
  dragProfileId: string | null;
  setDragProfileId: (id: string | null) => void;

  // Extra param presets
  extraParamPresets: ExtraParamPreset[];
  addExtraParamPreset: (name: string, params: string) => void;
  removeExtraParamPreset: (id: string) => void;

  // Last click region for F2 routing
  lastClickRegion: 'config' | 'tab' | null;
  setLastClickRegion: (region: 'config' | 'tab' | null) => void;

  // Remote file cache (per session)
  remoteFileCache: Record<string, { files: RemoteFileEntry[]; currentPath: string }>;
  setRemoteFileCache: (terminalId: string, cache: { files: RemoteFileEntry[]; currentPath: string }) => void;
  clearRemoteFileCache: (terminalId: string) => void;

  // Remote clipboard
  remoteClipboard: { items: string[]; operation: 'copy' | 'move' } | null;
  setRemoteClipboard: (clipboard: { items: string[]; operation: 'copy' | 'move' } | null) => void;

  // Server stats
  serverStats: ServerStats | null;
  setServerStats: (stats: ServerStats | null) => void;

  // Transfer state
  transfers: TransferItem[];
  showTransferPanel: Record<string, boolean>;
  addTransfer: (item: TransferItem) => void;
  updateTransferProgress: (id: string, transferred: number, total: number, percent: number) => void;
  completeTransfer: (id: string) => void;
  failTransfer: (id: string, error: string) => void;
  removeTransfer: (id: string) => void;
  clearCompletedTransfers: (terminalId: string) => void;
  clearCompletedTransfersByProfile: (profileId: string) => void;
  setShowTransferPanel: (terminalId: string, show: boolean) => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  // Profiles
  profiles: [],
  selectedProfileId: null,
  setProfiles: (profiles) => set({ profiles }),
  addProfile: (profile) =>
    set((state) => ({ profiles: [...state.profiles, profile] })),
  updateProfile: (profile) =>
    set((state) => ({
      profiles: state.profiles.map((p) => (p.id === profile.id ? profile : p)),
    })),
  removeProfile: (id) =>
    set((state) => ({
      profiles: state.profiles.filter((p) => p.id !== id),
    })),
  selectProfile: (id) => set({ selectedProfileId: id }),

  // UI State
  configPanelVisible: true,
  fileTreeVisible: true,
  toggleConfigPanel: () => set((state) => {
    const next = !state.configPanelVisible;
    const s = getAppSettings();
    saveAppSettings({ ...s, configPanelAutoExpand: next });
    return { configPanelVisible: next };
  }),
  toggleFileTree: () => set((state) => {
    const next = !state.fileTreeVisible;
    const s = getAppSettings();
    saveAppSettings({ ...s, fileTreeAutoExpand: next });
    return { fileTreeVisible: next };
  }),
  configSearchQuery: '',
  configSortBy: 'name-asc',
  setConfigSearchQuery: (query) => set({ configSearchQuery: query }),
  setConfigSortBy: (sortBy) => set({ configSortBy: sortBy }),

  settingsDialogOpen: false,
  gitHistoryTab: null,
  activeSpecialTab: null,
  openSettingsDialog: () => set({ settingsDialogOpen: true }),
  closeSettingsDialog: () => set({ settingsDialogOpen: false }),
  openGitHistoryTab: (tab) => set({ gitHistoryTab: tab, activeSpecialTab: 'git-history' }),
  closeGitHistoryTab: () => set((state) => ({
    gitHistoryTab: null,
    activeSpecialTab: state.activeSpecialTab === 'git-history' ? null : state.activeSpecialTab,
  })),
  setActiveSpecialTab: (tab) => set({ activeSpecialTab: tab }),

  exclusionPatterns: ['node_modules', '.git'],
  setExclusionPatterns: (patterns) => set({ exclusionPatterns: patterns }),

  // File tree navigation history
  navBackStack: [],
  navForwardStack: [],
  navigateWithHistory: (path) => set((state) => {
    const current = state.currentDirectory;
    if (!current || current === path) return state;
    const back = [...state.navBackStack, current].slice(-50);
    persistFileTreeNav({ ...state, navBackStack: back, navForwardStack: [] });
    return { currentDirectory: path, navBackStack: back, navForwardStack: [] };
  }),
  navBack: () => {
    const state = get();
    if (state.navBackStack.length === 0) return null;
    const target = state.navBackStack[state.navBackStack.length - 1];
    const back = state.navBackStack.slice(0, -1);
    const forward = state.currentDirectory ? [...state.navForwardStack, state.currentDirectory].slice(-50) : state.navForwardStack;
    persistFileTreeNav({ ...state, navBackStack: back, navForwardStack: forward });
    set({ currentDirectory: target, navBackStack: back, navForwardStack: forward });
    return target;
  },
  navForward: () => {
    const state = get();
    if (state.navForwardStack.length === 0) return null;
    const target = state.navForwardStack[state.navForwardStack.length - 1];
    const forward = state.navForwardStack.slice(0, -1);
    const back = state.currentDirectory ? [...state.navBackStack, state.currentDirectory].slice(-50) : state.navBackStack;
    persistFileTreeNav({ ...state, navBackStack: back, navForwardStack: forward });
    set({ currentDirectory: target, navBackStack: back, navForwardStack: forward });
    return target;
  },

  // File tree sort
  fileSortBy: 'name',
  fileSortDir: 'asc',
  setFileSort: (by, dir) => set((state) => {
    persistFileTreeNav({ ...state, fileSortBy: by, fileSortDir: dir });
    return { fileSortBy: by, fileSortDir: dir };
  }),
  fileRoots: [],
  addFileRoot: (path) => set((state) => {
    const pathKey = path.toLowerCase();
    if (state.fileRoots.some(candidate => candidate.toLowerCase() === pathKey)) return state;
    const fileRoots = [...state.fileRoots, path];
    persistFileTreeNav({ ...state, fileRoots });
    return { fileRoots };
  }),
  removeFileRoot: (path) => set((state) => {
    const pathKey = path.toLowerCase();
    const fileRoots = state.fileRoots.filter(candidate => candidate.toLowerCase() !== pathKey);
    persistFileTreeNav({ ...state, fileRoots });
    return { fileRoots };
  }),

  // Custom themes
  customThemes: [],
  setCustomThemes: (themes) => set({ customThemes: themes }),
  addCustomTheme: (theme) =>
    set((state) => ({ customThemes: [...state.customThemes, theme] })),
  updateCustomTheme: (theme) =>
    set((state) => ({
      customThemes: state.customThemes.map((t) => (t.id === theme.id ? theme : t)),
    })),
  removeCustomTheme: (id) =>
    set((state) => ({
      customThemes: state.customThemes.filter((t) => t.id !== id),
    })),

  // Tab Groups
  groups: [{ id: 'default', name: '默认', collapsed: false }],
  addGroup: (name, color) => set((state) => ({
    groups: [...state.groups, { id: crypto.randomUUID(), name, color, collapsed: false }],
  })),
  removeGroup: (id) => set((state) => {
    if (id === 'default') return state;
    return {
      groups: state.groups.filter((g) => g.id !== id),
      sessions: state.sessions.map((s) =>
        s.groupId === id ? { ...s, groupId: 'default' } : s
      ),
    };
  }),
  renameGroup: (id, name) => set((state) => ({
    groups: state.groups.map((g) => g.id === id ? { ...g, name } : g),
  })),
  setGroupColor: (id, color) => set((state) => ({
    groups: state.groups.map((g) => g.id === id ? { ...g, color } : g),
  })),
  toggleGroupCollapse: (id) => set((state) => ({
    groups: state.groups.map((g) => g.id === id ? { ...g, collapsed: !g.collapsed } : g),
  })),
  moveSessionToGroup: (sessionId, groupId) => set((state) => ({
    sessions: state.sessions.map((s) =>
      s.id === sessionId ? { ...s, groupId } : s
    ),
  })),

  // Workspace
  currentWorkspaceId: null,
  workspaceModified: false,
  setCurrentWorkspace: (id) => set({ currentWorkspaceId: id, workspaceModified: false }),
  setWorkspaceModified: (modified) => set({ workspaceModified: modified }),

  // Terminal Sessions
  sessions: [],
  activeSessionId: null,
  currentDirectory: '',
  setCurrentDirectory: (path) => set({ currentDirectory: path }),
  _skipSaveTabs: false,
  addSession: (session, keepActive) =>
    set((state) => {
      const s = {
        ...session,
        groupId: session.groupId || 'default',
        createdAt: session.createdAt ?? Date.now(),
      };
      const sessions = [...state.sessions, s];
      if (!state._skipSaveTabs) {
        debouncedSaveTabs(sessions, s.id);
      }
      return {
        sessions,
        activeSessionId: keepActive ? state.activeSessionId : s.id,
        activeSpecialTab: null,
      };
    }),
  removeSession: (id) =>
    set((state) => {
      const sessions = state.sessions.filter((s) => s.id !== id);
      let activeSessionId =
        state.activeSessionId === id
          ? sessions[0]?.id ?? null
          : state.activeSessionId;
      const { [id]: _, ...restCache } = state.remoteFileCache;
      const { [id]: _activity, ...terminalActivities } = state.terminalActivities;
      const { [id]: _claudeSession, ...claudeSessionIds } = state.claudeSessionIds;
      const { [id]: _directory, ...sessionDirectories } = state.sessionDirectories;
      const terminalWebTakeovers = { ...state.terminalWebTakeovers };
      delete terminalWebTakeovers[id];
      // Split-slot cleanup: free any slot referencing the closed session.
      // If the closed pane was focused, refocus the first remaining filled slot
      // (split mode is preserved even if all slots become blank).
      let splitSlots = state.splitSlots;
      if (state.splitMode !== 'off' && splitSlots.some(s => s.sessionId === id)) {
        splitSlots = splitSlots.map(s => s.sessionId === id ? { sessionId: null, enteredAt: 0 } : s);
        if (state.activeSessionId === id) {
          activeSessionId = splitSlots.find(s => s.sessionId !== null)?.sessionId ?? null;
        }
      }
      debouncedSaveTabs(sessions, activeSessionId);
      return {
        sessions,
        activeSessionId,
        remoteFileCache: restCache,
        terminalActivities,
        terminalWebTakeovers,
        claudeSessionIds,
        sessionDirectories,
        splitSlots,
        terminalLayoutVersion: splitSlots !== state.splitSlots
          ? state.terminalLayoutVersion + 1
          : state.terminalLayoutVersion,
      };
    }),
  setSessions: (sessions) => {
    const normalized = sessions.map(s => ({ ...s, createdAt: s.createdAt ?? Date.now() }));
    const activeSessionId = normalized[0]?.id ?? null;
    saveTabsToStorage(normalized, activeSessionId);
    set({ sessions: normalized, activeSessionId, terminalActivities: {}, terminalWebTakeovers: {} });
  },
  setActiveSession: (id) => set((state) => {
    // 文件导航跟随当前连接：优先使用会话内已记录的目录（用户浏览或 cd 过的）；
    // 若无记录，则回退到 profile 设置的启动目录（startupPath）。
    let currentDirectory = state.currentDirectory;
    if (id) {
      if (state.sessionDirectories[id]) {
        currentDirectory = state.sessionDirectories[id];
      } else {
        const session = state.sessions.find(s => s.id === id);
        if (session) {
          const profile = state.profiles.find(p => p.id === session.profileId);
          if (profile?.startupPath) {
            currentDirectory = profile.startupPath;
          }
        }
      }
    }
    if (!state._skipSaveTabs) {
      debouncedSaveTabs(state.sessions, id);
    }
    return { activeSessionId: id, currentDirectory, activeSpecialTab: null };
  }),
  renameSession: (id, name) => {
    const session = get().sessions.find((item) => item.id === id);
    if (session && session.sessionType !== 'editor') {
      void updateTerminalDisplayName(id, name).catch((error) => {
        console.error('Failed to sync terminal display name:', error);
      });
    }
    set((state) => {
      const newSessions = state.sessions.map((s) =>
        s.id === id ? { ...s, profileName: name } : s
      );
      debouncedSaveTabs(newSessions, state.activeSessionId);
      return { sessions: newSessions };
    });
  },
  updateSession: (id, updates) =>
    set((state) => {
      const newSessions = state.sessions.map((s) =>
        s.id === id ? { ...s, ...updates } : s
      );
      debouncedSaveTabs(newSessions, state.activeSessionId);
      return { sessions: newSessions };
    }),
  ensureEditorGroup: () => set((state) => {
    if (state.groups.some(g => g.id === 'editor-group')) return state;
    return { groups: [...state.groups, { id: 'editor-group', name: '文本编辑', collapsed: false }] };
  }),
  openEditorSession: (filePath, sshRemotePath?, sshTerminalId?) => {
    if (get().splitMode !== 'off') {
      get().showToast('请先退出分屏模式再编辑文件', 'info');
      return;
    }
    set((state) => {
    const existing = state.sessions.find(s => s.sessionType === 'editor' && s.profileId === filePath);
    if (existing) {
      saveTabsToStorage(state.sessions, existing.id);
      return { activeSessionId: existing.id, activeSpecialTab: null };
    }
    const fileName = filePath.split(/[\\/]/).pop() || filePath;
    const id = crypto.randomUUID();
    const session: TerminalSession = {
      id,
      profileId: filePath,
      profileName: fileName,
      terminalType: 'editor',
      colorTheme: { background: '#1e1e1e', foreground: '#d4d4d4' },
      tabColor: null,
      groupId: 'editor-group',
      sessionType: 'editor',
      isDirty: false,
      sshRemotePath,
      sshTerminalId,
    };
    const groups = state.groups.some(g => g.id === 'editor-group')
      ? state.groups
      : [...state.groups, { id: 'editor-group', name: '文本编辑', collapsed: false }];
    const sessions = [...state.sessions, session];
    saveTabsToStorage(sessions, id);
    return { sessions, activeSessionId: id, activeSpecialTab: null, groups };
    });
  },
  closeEditorSession: (id) =>
    set((state) => {
      const sessions = state.sessions.filter((s) => s.id !== id);
      const activeSessionId =
        state.activeSessionId === id
          ? sessions[0]?.id ?? null
          : state.activeSessionId;
      saveTabsToStorage(sessions, activeSessionId);
      return { sessions, activeSessionId };
    }),
  openDraftSession: async () => {
    if (get().splitMode !== 'off') {
      get().showToast('请先退出分屏模式再编辑文件', 'info');
      return;
    }
    const draftsDir = await ensureDraftsDir();
    const draftId = `draft_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const filePath = draftsDir + '\\' + draftId + '.txt';
    await writeFileContent(filePath, '');
    const drafts = await loadDraftIndex();
    drafts.push({ filePath, createdAt: Date.now() });
    await saveDraftIndex(drafts);

    const state = useAppStore.getState();
    const id = crypto.randomUUID();
    const session: TerminalSession = {
      id,
      profileId: filePath,
      profileName: '未命名',
      terminalType: 'editor',
      colorTheme: { background: '#1e1e1e', foreground: '#d4d4d4' },
      tabColor: null,
      groupId: 'editor-group',
      sessionType: 'editor',
      isDirty: false,
    };
    const groups = state.groups.some(g => g.id === 'editor-group')
      ? state.groups
      : [...state.groups, { id: 'editor-group', name: '文本编辑', collapsed: false }];
    const sessions = [...state.sessions, session];
    saveTabsToStorage(sessions, id);
    set({ sessions, activeSessionId: id, activeSpecialTab: null, groups });
  },
  removeDraftFile: async (draftPath: string) => {
    try { await deletePath(draftPath); } catch {}
    const drafts = await loadDraftIndex();
    const next = drafts.filter(d => d.filePath !== draftPath);
    await saveDraftIndex(next);
  },
  restoreDraftTabs: async () => {
    const drafts = await loadDraftIndex();
    if (drafts.length === 0) return;
    const state = useAppStore.getState();
    useAppStore.setState({ _skipSaveTabs: true });
    try {
      for (const draft of drafts) {
        // Skip if already restored (e.g. by restoreTabs)
        const existing = useAppStore.getState().sessions.find(
          s => s.sessionType === 'editor' && s.profileId === draft.filePath
        );
        if (existing) continue;
        try {
          const { getFileSize } = await import('../services/tauri');
          await getFileSize(draft.filePath);
          state.ensureEditorGroup();
          const id = crypto.randomUUID();
          const session: TerminalSession = {
            id,
            profileId: draft.filePath,
            profileName: '未命名',
            terminalType: 'editor',
            colorTheme: { background: '#1e1e1e', foreground: '#d4d4d4' },
            tabColor: null,
            groupId: 'editor-group',
            sessionType: 'editor',
            isDirty: false,
          };
          state.addSession(session, true);
        } catch {
          // Draft file no longer exists, remove from index
          const remaining = (await loadDraftIndex()).filter(d => d.filePath !== draft.filePath);
          await saveDraftIndex(remaining);
        }
      }
    } finally {
      useAppStore.setState({ _skipSaveTabs: false });
      const { sessions, activeSessionId } = useAppStore.getState();
      saveTabsToStorage(sessions, activeSessionId);
    }
  },
  sessionDirectories: {},
  setSessionDirectory: (sessionId, path) => set((state) => ({
    sessionDirectories: { ...state.sessionDirectories, [sessionId]: path },
    ...(state.activeSessionId === sessionId ? { currentDirectory: path } : {}),
  })),
  claudeSessionIds: {},
  setClaudeSessionId: (sessionId, claudeSessionId) => set((state) => ({
    claudeSessionIds: { ...state.claudeSessionIds, [sessionId]: claudeSessionId },
  })),
  terminalActivities: {},
  terminalWebTakeovers: {},
  setTerminalWebTakeover: (sessionId, active) => set((state) => {
    const isActive = Boolean(state.terminalWebTakeovers[sessionId]);
    if (isActive === active) return state;
    if (active) {
      return {
        terminalWebTakeovers: {
          ...state.terminalWebTakeovers,
          [sessionId]: true,
        },
      };
    }
    const terminalWebTakeovers = { ...state.terminalWebTakeovers };
    delete terminalWebTakeovers[sessionId];
    return { terminalWebTakeovers };
  }),
  setTerminalFallbackWorking: (sessionId, working) => set((state) => {
    const current = state.terminalActivities[sessionId];
    if (current?.runtimeKind === 'claude') return state;
    const phase: TerminalActivityPhase = working ? 'running' : 'idle';
    if (current?.source === 'legacy' && current.phase === phase) return state;
    return {
      terminalActivities: {
        ...state.terminalActivities,
        [sessionId]: { runtimeKind: 'shell', source: 'legacy', phase, updatedAt: Date.now(), lastHookAt: current?.lastHookAt },
      },
    };
  }),
  applyClaudeHookActivity: (sessionId, phase, updatedAt) => {
    let applied = false;
    set((state) => {
      const current = state.terminalActivities[sessionId];
      if (current?.lastHookAt !== undefined && current.lastHookAt >= updatedAt) return state;
      applied = true;
      return {
        terminalActivities: {
          ...state.terminalActivities,
          [sessionId]: { runtimeKind: 'claude', source: 'hook', phase, updatedAt, lastHookAt: updatedAt },
        },
      };
    });
    return applied;
  },
  endClaudeHookSession: (sessionId, updatedAt) => {
    let applied = false;
    set((state) => {
      const current = state.terminalActivities[sessionId];
      if (current?.lastHookAt !== undefined && current.lastHookAt >= updatedAt) return state;
      applied = true;
      return {
        terminalActivities: {
          ...state.terminalActivities,
          [sessionId]: { runtimeKind: 'shell', source: 'legacy', phase: 'idle', updatedAt, lastHookAt: updatedAt },
        },
      };
    });
    return applied;
  },
  expireClaudeHookActivity: (sessionId, expectedUpdatedAt) => set((state) => {
    const current = state.terminalActivities[sessionId];
    if (current?.runtimeKind !== 'claude' || current.phase !== 'running' || current.updatedAt !== expectedUpdatedAt) {
      return state;
    }
    return {
      terminalActivities: {
        ...state.terminalActivities,
        [sessionId]: {
          ...current,
          runtimeKind: 'shell',
          source: 'legacy',
          phase: 'idle',
          updatedAt: Date.now(),
        },
      },
    };
  }),
  handleTerminalInputActivity: (sessionId) => set((state) => {
    const current = state.terminalActivities[sessionId];
    if (current?.runtimeKind === 'claude') {
      if (current.phase !== 'attention') return state;
      return {
        terminalActivities: {
          ...state.terminalActivities,
          [sessionId]: { ...current, phase: 'running', updatedAt: Date.now() },
        },
      };
    }
    return {
      terminalActivities: {
        ...state.terminalActivities,
        [sessionId]: {
          runtimeKind: 'shell',
          source: 'legacy',
          phase: 'running',
          updatedAt: Date.now(),
          lastHookAt: current?.lastHookAt,
        },
      },
    };
  }),

  // --- Split Screen ---
  splitMode: 'off',
  splitSlots: [],
  terminalLayoutVersion: 0,
  splitTransitionUntil: 0,
  cycleSplitMode: () => set((state) => {
    const nowMs = Date.now();
    const splitTransitionUntil = nowMs + TERMINAL_SPLIT_TRANSITION_GUARD_MS;
    if (state.splitTransitionUntil > nowMs) return state;

    const cur = state.splitMode;
    if (cur === 'off') {
      // Entry: populate from terminal-session count (editors & web sessions excluded).
      const N = 2;
      const terms = state.sessions.filter(s => s.sessionType !== 'editor' && s.owner !== 'web');
      const now = Date.now();
      let slots: { sessionId: string | null; enteredAt: number }[];
      if (terms.length <= N) {
        slots = terms.slice(0, N).map(s => ({ sessionId: s.id, enteredAt: now }));
        while (slots.length < N) slots.push({ sessionId: null, enteredAt: 0 });
      } else {
        slots = new Array(N).fill(null).map(() => ({ sessionId: null, enteredAt: 0 }));
      }
      // Focus: keep current active if it ended up in a slot; else first filled slot; else unchanged.
      let activeSessionId = state.activeSessionId;
      if (activeSessionId && !slots.some(s => s.sessionId === activeSessionId)) {
        activeSessionId = slots.find(s => s.sessionId !== null)?.sessionId ?? activeSessionId;
      }
      return {
        splitMode: '2x1' as const,
        splitSlots: slots,
        activeSessionId,
        terminalLayoutVersion: state.terminalLayoutVersion + 1,
        splitTransitionUntil,
      };
    }
    if (cur === '2x1') {
      // Grow: preserve existing slot contents in place, append blank slots.
      return {
        splitMode: '2x2' as const,
        splitSlots: [...state.splitSlots, { sessionId: null, enteredAt: 0 }, { sessionId: null, enteredAt: 0 }],
        terminalLayoutVersion: state.terminalLayoutVersion + 1,
        splitTransitionUntil,
      };
    }
    // 2x2 -> off: exit. Sessions become normal tabs; activeSessionId (focused pane) stays, shown full-screen.
    return {
      splitMode: 'off' as const,
      splitSlots: [],
      terminalLayoutVersion: state.terminalLayoutVersion + 1,
      splitTransitionUntil,
    };
  }),
  closeSplitPane: (slotIndex) => {
    const slot = get().splitSlots[slotIndex];
    if (slot?.sessionId) get().removeSession(slot.sessionId);
  },
  swapSplitSlots: (i, j) => set((state) => {
    const slots = [...state.splitSlots];
    if (i < 0 || j < 0 || i >= slots.length || j >= slots.length) return state;
    [slots[i], slots[j]] = [slots[j], slots[i]];
    return { splitSlots: slots, terminalLayoutVersion: state.terminalLayoutVersion + 1 };
  }),
  placeSessionInSplitSlot: (sessionId) => set((state) => {
    if (state.splitMode === 'off') return state;
    const slots = state.splitSlots;

    // 1. 找空位
    const emptyIdx = slots.findIndex(s => s.sessionId === null);
    if (emptyIdx !== -1) {
      const splitSlots = [...slots];
      splitSlots[emptyIdx] = { sessionId, enteredAt: Date.now() };
      return {
        splitSlots,
        activeSessionId: sessionId,
        terminalLayoutVersion: state.terminalLayoutVersion + 1,
      };
    }

    // 2. 无空位，替换最旧的
    let oldestIdx = 0;
    let oldestTime = slots[0].enteredAt;
    for (let i = 1; i < slots.length; i++) {
      if (slots[i].enteredAt < oldestTime) {
        oldestTime = slots[i].enteredAt;
        oldestIdx = i;
      }
    }
    const splitSlots = [...slots];
    splitSlots[oldestIdx] = { sessionId, enteredAt: Date.now() };
    return {
      splitSlots,
      activeSessionId: sessionId,
      terminalLayoutVersion: state.terminalLayoutVersion + 1,
    };
  }),

  // --- Window Mode (F11 cycle) ---
  windowMode: 'normal',
  previousPanelState: null,
  cycleWindowMode: () => set((state) => {
    const cur = state.windowMode;

    if (cur === 'normal') {
      // normal → panels-hidden: 保存当前面板状态
      const settings = getAppSettings();
      return {
        windowMode: 'panels-hidden' as const,
        terminalLayoutVersion: state.terminalLayoutVersion + 1,
        previousPanelState: {
          configPanelVisible: state.configPanelVisible,
          fileTreeVisible: state.fileTreeVisible,
          enableTabNavigation: settings.enableTabNavigation,
        },
      };
    }

    // panels-hidden → normal: 恢复之前的面板状态
    const prev = state.previousPanelState;
    if (prev) {
      const settings = getAppSettings();
      saveAppSettings({ ...settings, enableTabNavigation: prev.enableTabNavigation });
      saveEnableTabNavigation(prev.enableTabNavigation).catch(() => {});
      window.dispatchEvent(new CustomEvent('tab-navigation-changed'));
    }
    return {
      windowMode: 'normal' as const,
      terminalLayoutVersion: state.terminalLayoutVersion + 1,
      previousPanelState: null,
      configPanelVisible: prev?.configPanelVisible ?? state.configPanelVisible,
      fileTreeVisible: prev?.fileTreeVisible ?? state.fileTreeVisible,
    };
  }),

  // --- Toast ---
  toast: null,
  showToast: (message, type = 'info') => set({
    toast: { id: Date.now() + Math.random(), message, type },
  }),
  dismissToast: (id) => set((state) => (state.toast?.id === id ? { toast: null } : {})),

  settingsVersion: 0,
  incrementSettingsVersion: () => set((state) => ({ settingsVersion: state.settingsVersion + 1 })),

  dragPaths: null,
  setDragPaths: (paths) => set({ dragPaths: paths }),

  dragProfileId: null,
  setDragProfileId: (id) => set({ dragProfileId: id }),

  // Extra param presets
  extraParamPresets: [],
  addExtraParamPreset: (name, params) => set((state) => {
    const next = [...state.extraParamPresets, { id: crypto.randomUUID(), name, params }];
    writeClientData('extra_param_presets', JSON.stringify(next)).catch(() => {});
    return { extraParamPresets: next };
  }),
  removeExtraParamPreset: (id) => set((state) => {
    const next = state.extraParamPresets.filter(p => p.id !== id);
    writeClientData('extra_param_presets', JSON.stringify(next)).catch(() => {});
    return { extraParamPresets: next };
  }),
  lastClickRegion: null,
  setLastClickRegion: (region) => set({ lastClickRegion: region }),

  // Remote file cache
  remoteFileCache: {},
  setRemoteFileCache: (terminalId, cache) => set((state) => ({
    remoteFileCache: { ...state.remoteFileCache, [terminalId]: cache },
  })),
  clearRemoteFileCache: (terminalId) => set((state) => {
    const { [terminalId]: _, ...rest } = state.remoteFileCache;
    return { remoteFileCache: rest };
  }),

  // Remote clipboard
  remoteClipboard: null,
  setRemoteClipboard: (clipboard) => set({ remoteClipboard: clipboard }),

  // Server stats
  serverStats: null,
  setServerStats: (stats) => set({ serverStats: stats }),

  // Transfer state
  transfers: (() => {
    try {
      const saved = localStorage.getItem('terminalbuddy_transfers');
      if (!saved) return [];
      const items: TransferItem[] = JSON.parse(saved);
      return items.map((t) =>
        t.status === 'active' ? { ...t, status: 'failed' as const, error: '应用重启' } : t
      );
    } catch { return []; }
  })(),
  showTransferPanel: {},
  addTransfer: (item) => set((state) => {
    const transfers = [...state.transfers, item];
    localStorage.setItem('terminalbuddy_transfers', JSON.stringify(transfers));
    return { transfers };
  }),
  updateTransferProgress: (id, transferred, total, percent) =>
    set((state) => {
      const transfers = state.transfers.map((t) =>
        t.id === id ? { ...t, transferred, total, percent } : t
      );
      localStorage.setItem('terminalbuddy_transfers', JSON.stringify(transfers));
      return { transfers };
    }),
  completeTransfer: (id) =>
    set((state) => {
      const transfers = state.transfers.map((t) =>
        t.id === id ? { ...t, status: 'completed' as const, percent: 100 } : t
      );
      localStorage.setItem('terminalbuddy_transfers', JSON.stringify(transfers));
      return { transfers };
    }),
  failTransfer: (id, error) =>
    set((state) => {
      const transfers = state.transfers.map((t) =>
        t.id === id ? { ...t, status: 'failed' as const, error } : t
      );
      localStorage.setItem('terminalbuddy_transfers', JSON.stringify(transfers));
      return { transfers };
    }),
  removeTransfer: (id) =>
    set((state) => {
      const transfers = state.transfers.filter((t) => t.id !== id);
      localStorage.setItem('terminalbuddy_transfers', JSON.stringify(transfers));
      return { transfers };
    }),
  clearCompletedTransfers: (terminalId) =>
    set((state) => {
      const transfers = state.transfers.filter(
        (t) => t.terminalId !== terminalId || t.status !== 'completed'
      );
      localStorage.setItem('terminalbuddy_transfers', JSON.stringify(transfers));
      return { transfers };
    }),
  clearCompletedTransfersByProfile: (profileId) =>
    set((state) => {
      const transfers = state.transfers.filter(
        (t) => t.profileId !== profileId || t.status !== 'completed'
      );
      localStorage.setItem('terminalbuddy_transfers', JSON.stringify(transfers));
      return { transfers };
    }),
  setShowTransferPanel: (terminalId, show) =>
    set((state) => ({ showTransferPanel: { ...state.showTransferPanel, [terminalId]: show } })),
}));

// Listen for app-settings-changed events and increment version to trigger re-renders
if (!(window as any).__settingsListenerRegistered) {
  (window as any).__settingsListenerRegistered = true;
  window.addEventListener('app-settings-changed', () => {
    useAppStore.getState().incrementSettingsVersion();
  });
}
