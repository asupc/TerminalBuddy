import { create } from 'zustand';
import type { Profile, TerminalSession, CustomTheme, TabGroup, ExtraParamPreset, RemoteFileEntry, ServerStats, TransferItem } from '../types';
import { readClientData, writeClientData, getDataPath, ensureDir, writeFileContent, deletePath } from '../services/tauri';
import { getAppSettings, saveAppSettings } from '../utils/settings';

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
}

export function saveTabsToStorage(sessions: TerminalSession[], activeSessionId: string | null) {
  try {
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

const DEFAULT_BOOKMARKS = [
  { name: '主目录', path: 'C:\\Users' },
  { name: '桌面', path: 'C:\\Users\\Public\\Desktop' },
  { name: '文档', path: 'C:\\Users\\Public\\Documents' },
];

export async function initBookmarks() {
  try {
    const raw = await readClientData('bookmarks');
    if (raw) {
      useAppStore.setState({ bookmarks: JSON.parse(raw) });
    } else {
      useAppStore.setState({ bookmarks: DEFAULT_BOOKMARKS });
    }
  } catch {
    useAppStore.setState({ bookmarks: DEFAULT_BOOKMARKS });
  }
}

export async function initExtraParamPresets() {
  try {
    const raw = await readClientData('extra_param_presets');
    if (raw) {
      useAppStore.setState({ extraParamPresets: JSON.parse(raw) });
    }
  } catch {}
}

export async function initBookmarkHeight() {
  try {
    const raw = await readClientData('bookmark_height');
    if (raw) {
      const height = JSON.parse(raw);
      if (typeof height === 'number' && height >= 32 && height <= 300) {
        useAppStore.setState({ bookmarkHeight: height });
      }
    }
  } catch {}
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

  // Settings tab
  settingsTabOpen: boolean;
  openSettingsTab: () => void;
  closeSettingsTab: () => void;

  // File exclusion patterns
  exclusionPatterns: string[];
  setExclusionPatterns: (patterns: string[]) => void;

  // Directory bookmarks
  bookmarks: { name: string; path: string }[];
  addBookmark: (name: string, path: string) => void;
  removeBookmark: (path: string) => void;
  renameBookmark: (path: string, newName: string) => void;

  // Bookmark section height
  bookmarkHeight: number;
  setBookmarkHeight: (height: number) => void;

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

  // Working state (yellow dot when command is running)
  workingSessions: Record<string, boolean>;
  setSessionWorking: (sessionId: string, working: boolean) => void;

  // Settings version (incremented when settings change, triggers re-render in subscribers)
  settingsVersion: number;
  incrementSettingsVersion: () => void;

  // Internal drag paths (from FileTree to terminal)
  dragPaths: string[] | null;
  setDragPaths: (paths: string[] | null) => void;

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
  setShowTransferPanel: (terminalId: string, show: boolean) => void;
}

export const useAppStore = create<AppState>((set) => ({
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

  settingsTabOpen: false,
  openSettingsTab: () => set({ settingsTabOpen: true, activeSessionId: 'settings' }),
  closeSettingsTab: () => set({ settingsTabOpen: false, activeSessionId: '' }),

  exclusionPatterns: ['node_modules', '.git'],
  setExclusionPatterns: (patterns) => set({ exclusionPatterns: patterns }),

  // Directory bookmarks
  bookmarks: [],
  addBookmark: (name, path) => set((state) => {
    const next = [...state.bookmarks, { name, path }];
    writeClientData('bookmarks', JSON.stringify(next)).catch(() => {});
    return { bookmarks: next };
  }),
  removeBookmark: (path) => set((state) => {
    const next = state.bookmarks.filter(b => b.path !== path);
    writeClientData('bookmarks', JSON.stringify(next)).catch(() => {});
    return { bookmarks: next };
  }),
  renameBookmark: (path, newName) => set((state) => {
    const next = state.bookmarks.map(b => b.path === path ? { ...b, name: newName } : b);
    writeClientData('bookmarks', JSON.stringify(next)).catch(() => {});
    return { bookmarks: next };
  }),

  // Bookmark section height
  bookmarkHeight: 60,
  setBookmarkHeight: (height) => {
    writeClientData('bookmark_height', JSON.stringify(height)).catch(() => {});
    set({ bookmarkHeight: height });
  },

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
      const s = { ...session, groupId: session.groupId || 'default' };
      const sessions = [...state.sessions, s];
      if (!state._skipSaveTabs) {
        debouncedSaveTabs(sessions, s.id);
      }
      return {
        sessions,
        activeSessionId: keepActive ? state.activeSessionId : s.id,
        settingsTabOpen: false,
      };
    }),
  removeSession: (id) =>
    set((state) => {
      const sessions = state.sessions.filter((s) => s.id !== id);
      const activeSessionId =
        state.activeSessionId === id
          ? sessions[0]?.id ?? null
          : state.activeSessionId;
      const { [id]: _, ...restCache } = state.remoteFileCache;
      debouncedSaveTabs(sessions, activeSessionId);
      return { sessions, activeSessionId, remoteFileCache: restCache };
    }),
  setSessions: (sessions) => {
    const activeSessionId = sessions[0]?.id ?? null;
    saveTabsToStorage(sessions, activeSessionId);
    set({ sessions, activeSessionId });
  },
  setActiveSession: (id) => set((state) => {
    const currentDirectory = (id && state.sessionDirectories[id]) ? state.sessionDirectories[id] : state.currentDirectory;
    debouncedSaveTabs(state.sessions, id);
    return { activeSessionId: id, currentDirectory, settingsTabOpen: false };
  }),
  renameSession: (id, name) =>
    set((state) => {
      const newSessions = state.sessions.map((s) =>
        s.id === id ? { ...s, profileName: name } : s
      );
      debouncedSaveTabs(newSessions, state.activeSessionId);
      return { sessions: newSessions };
    }),
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
  openEditorSession: (filePath, sshRemotePath?, sshTerminalId?) => set((state) => {
    const existing = state.sessions.find(s => s.sessionType === 'editor' && s.profileId === filePath);
    if (existing) {
      saveTabsToStorage(state.sessions, existing.id);
      return { activeSessionId: existing.id, settingsTabOpen: false };
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
    return { sessions, activeSessionId: id, settingsTabOpen: false, groups };
  }),
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
    set({ sessions, activeSessionId: id, settingsTabOpen: false, groups });
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
  })),
  workingSessions: {},
  setSessionWorking: (sessionId, working) => set((state) => ({
    workingSessions: { ...state.workingSessions, [sessionId]: working },
  })),

  settingsVersion: 0,
  incrementSettingsVersion: () => set((state) => ({ settingsVersion: state.settingsVersion + 1 })),

  dragPaths: null,
  setDragPaths: (paths) => set({ dragPaths: paths }),

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
  transfers: [],
  showTransferPanel: {},
  addTransfer: (item) => set((state) => ({ transfers: [...state.transfers, item] })),
  updateTransferProgress: (id, transferred, total, percent) =>
    set((state) => ({
      transfers: state.transfers.map((t) =>
        t.id === id ? { ...t, transferred, total, percent } : t
      ),
    })),
  completeTransfer: (id) =>
    set((state) => ({
      transfers: state.transfers.map((t) =>
        t.id === id ? { ...t, status: 'completed' as const, percent: 100 } : t
      ),
    })),
  failTransfer: (id, error) =>
    set((state) => ({
      transfers: state.transfers.map((t) =>
        t.id === id ? { ...t, status: 'failed' as const, error } : t
      ),
    })),
  removeTransfer: (id) =>
    set((state) => ({ transfers: state.transfers.filter((t) => t.id !== id) })),
  clearCompletedTransfers: (terminalId) =>
    set((state) => ({
      transfers: state.transfers.filter(
        (t) => t.terminalId !== terminalId || t.status !== 'completed'
      ),
    })),
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
