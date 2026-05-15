import { create } from 'zustand';
import type { Profile, TerminalSession, CustomTheme } from '../types';
import { getAppSettings } from '../components/SettingsDialog';

interface SavedTab {
  profileId: string;
  profileName: string;
  terminalType: 'powershell' | 'cmd';
  colorTheme: { background: string; foreground: string };
  tabColor: string | null;
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

  // Terminal Sessions
  sessions: TerminalSession[];
  activeSessionId: string | null;
  currentDirectory: string;
  setCurrentDirectory: (path: string) => void;
  addSession: (session: TerminalSession) => void;
  removeSession: (id: string) => void;
  setActiveSession: (id: string | null) => void;
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

  // Terminal Sessions
  sessions: [],
  activeSessionId: null,
  currentDirectory: '',
  setCurrentDirectory: (path) => set({ currentDirectory: path }),
  addSession: (session) =>
    set((state) => {
      const sessions = [...state.sessions, session];
      saveTabsToStorage(sessions, session.id);
      return { sessions, activeSessionId: session.id };
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
  setActiveSession: (id) => set((state) => {
    const currentDirectory = (id && state.sessionDirectories[id]) ? state.sessionDirectories[id] : state.currentDirectory;
    saveTabsToStorage(state.sessions, id);
    return { activeSessionId: id, currentDirectory };
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
