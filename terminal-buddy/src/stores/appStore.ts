import { create } from 'zustand';
import type { Profile, TerminalSession, CustomTheme, TabGroup } from '../types';
import { getAppSettings } from '../utils/settings';

interface SavedTab {
  profileId: string;
  profileName: string;
  terminalType: string;
  colorTheme: { background: string; foreground: string };
  tabColor: string | null;
  groupId: string;
}

const SAVED_TABS_KEY = 'terminalbuddy_saved_tabs';
const ACTIVE_TAB_KEY = 'terminalbuddy_active_tab';

export function saveTabsToStorage(sessions: TerminalSession[], activeSessionId: string | null) {
  try {
    const tabs: SavedTab[] = sessions.map(s => ({
      profileId: s.profileId,
      profileName: s.profileName,
      terminalType: s.terminalType,
      colorTheme: s.colorTheme,
      tabColor: s.tabColor,
      groupId: s.groupId,
    }));
    localStorage.setItem(SAVED_TABS_KEY, JSON.stringify(tabs));
    if (activeSessionId) {
      const index = sessions.findIndex(s => s.id === activeSessionId);
      localStorage.setItem(ACTIVE_TAB_KEY, String(index));
    } else {
      localStorage.removeItem(ACTIVE_TAB_KEY);
    }
  } catch {}
}

export function loadSavedTabs(): { tabs: SavedTab[]; activeIndex: number } {
  try {
    const raw = localStorage.getItem(SAVED_TABS_KEY);
    const tabs: SavedTab[] = raw ? JSON.parse(raw) : [];
    const activeIndex = parseInt(localStorage.getItem(ACTIVE_TAB_KEY) || '0', 10);
    return { tabs, activeIndex: Math.min(activeIndex, Math.max(tabs.length - 1, 0)) };
  } catch {
    return { tabs: [], activeIndex: 0 };
  }
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
  addSession: (session: TerminalSession) => void;
  removeSession: (id: string) => void;
  setActiveSession: (id: string | null) => void;
  setSessions: (sessions: TerminalSession[]) => void;
  renameSession: (id: string, name: string) => void;
  updateSession: (id: string, updates: Partial<TerminalSession>) => void;
  sessionDirectories: Record<string, string>;
  setSessionDirectory: (sessionId: string, path: string) => void;
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
  configPanelVisible: (() => { try { return getAppSettings().configPanelAutoExpand; } catch { return true; } })(),
  fileTreeVisible: (() => { try { return getAppSettings().fileTreeAutoExpand; } catch { return true; } })(),
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
  bookmarks: (() => {
    try {
      const stored = localStorage.getItem('terminalbuddy_bookmarks');
      if (stored) return JSON.parse(stored);
    } catch {}
    return [
      { name: '主目录', path: 'C:\\Users' },
      { name: '桌面', path: 'C:\\Users\\Public\\Desktop' },
      { name: '文档', path: 'C:\\Users\\Public\\Documents' },
    ];
  })(),
  addBookmark: (name, path) => set((state) => {
    const next = [...state.bookmarks, { name, path }];
    localStorage.setItem('terminalbuddy_bookmarks', JSON.stringify(next));
    return { bookmarks: next };
  }),
  removeBookmark: (path) => set((state) => {
    const next = state.bookmarks.filter(b => b.path !== path);
    localStorage.setItem('terminalbuddy_bookmarks', JSON.stringify(next));
    return { bookmarks: next };
  }),
  renameBookmark: (path, newName) => set((state) => {
    const next = state.bookmarks.map(b => b.path === path ? { ...b, name: newName } : b);
    localStorage.setItem('terminalbuddy_bookmarks', JSON.stringify(next));
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
  addSession: (session) =>
    set((state) => {
      const s = { ...session, groupId: session.groupId || 'default' };
      const sessions = [...state.sessions, s];
      saveTabsToStorage(sessions, s.id);
      return { sessions, activeSessionId: s.id, settingsTabOpen: false };
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
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id ? { ...s, profileName: name } : s
      ),
    })),
  updateSession: (id, updates) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id ? { ...s, ...updates } : s
      ),
    })),
  sessionDirectories: {},
  setSessionDirectory: (sessionId, path) => set((state) => ({
    sessionDirectories: { ...state.sessionDirectories, [sessionId]: path },
  })),
}));
