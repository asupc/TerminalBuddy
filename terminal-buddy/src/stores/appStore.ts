import { create } from 'zustand';
import type { Profile, TerminalSession, CustomTheme, TabGroup, ExtraParamPreset } from '../types';
import { readClientData, writeClientData } from '../services/tauri';

interface SavedTab {
  profileId: string;
  profileName: string;
  terminalType: string;
  colorTheme: { background: string; foreground: string };
  tabColor: string | null;
  groupId: string;
  sessionType?: 'terminal' | 'editor';
  isDirty?: boolean;
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
  openEditorSession: (filePath: string) => void;
  closeEditorSession: (id: string) => void;
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
  toggleConfigPanel: () => set((state) => ({ configPanelVisible: !state.configPanelVisible })),
  toggleFileTree: () => set((state) => ({ fileTreeVisible: !state.fileTreeVisible })),
  configSearchQuery: '',
  configSortBy: 'name-asc',
  setConfigSearchQuery: (query) => set({ configSearchQuery: query }),
  setConfigSortBy: (sortBy) => set({ configSortBy: sortBy }),

  settingsTabOpen: false,
  openSettingsTab: () => set({ settingsTabOpen: true }),
  closeSettingsTab: () => set({ settingsTabOpen: false }),

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
        saveTabsToStorage(sessions, s.id);
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
      saveTabsToStorage(sessions, activeSessionId);
      return { sessions, activeSessionId };
    }),
  setSessions: (sessions) => {
    const activeSessionId = sessions[0]?.id ?? null;
    saveTabsToStorage(sessions, activeSessionId);
    set({ sessions, activeSessionId });
  },
  setActiveSession: (id) => set((state) => {
    const currentDirectory = (id && state.sessionDirectories[id]) ? state.sessionDirectories[id] : state.currentDirectory;
    saveTabsToStorage(state.sessions, id);
    return { activeSessionId: id, currentDirectory, settingsTabOpen: false };
  }),
  renameSession: (id, name) =>
    set((state) => {
      const newSessions = state.sessions.map((s) =>
        s.id === id ? { ...s, profileName: name } : s
      );
      saveTabsToStorage(newSessions, state.activeSessionId);
      return { sessions: newSessions };
    }),
  updateSession: (id, updates) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id ? { ...s, ...updates } : s
      ),
    })),
  ensureEditorGroup: () => set((state) => {
    if (state.groups.some(g => g.id === 'editor-group')) return state;
    return { groups: [...state.groups, { id: 'editor-group', name: '文本编辑', collapsed: false }] };
  }),
  openEditorSession: (filePath) => set((state) => {
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
}));

// Listen for app-settings-changed events and increment version to trigger re-renders
window.addEventListener('app-settings-changed', () => {
  useAppStore.getState().incrementSettingsVersion();
});
