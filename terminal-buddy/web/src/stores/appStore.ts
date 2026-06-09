import { create } from 'zustand';
import type { Profile, WebTerminalSession } from '../types';

const AUTH_KEY = 'terminalbuddy_web_auth';

function loadAuth(): { token: string | null; username: string | null } {
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return { token: null, username: null };
}

function saveAuth(token: string | null, username: string | null) {
  try {
    if (token && username) {
      localStorage.setItem(AUTH_KEY, JSON.stringify({ token, username }));
    } else {
      localStorage.removeItem(AUTH_KEY);
    }
  } catch {}
}

interface WebAppState {
  token: string | null;
  username: string | null;
  profiles: Profile[];
  sessions: WebTerminalSession[];
  activeSessionId: string | null;
  sidebarOpen: boolean;

  setAuth: (token: string, username: string) => void;
  logout: () => void;
  setProfiles: (profiles: Profile[]) => void;
  addProfile: (profile: Profile) => void;
  updateProfile: (profile: Profile) => void;
  removeProfile: (id: string) => void;
  addSession: (session: WebTerminalSession) => void;
  removeSession: (id: string) => void;
  setActiveSession: (id: string | null) => void;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  isMobile: boolean;
  setIsMobile: (v: boolean) => void;
}

const initialAuth = loadAuth();

export const useWebAppStore = create<WebAppState>((set) => ({
  token: initialAuth.token,
  username: initialAuth.username,
  profiles: [],
  sessions: [],
  activeSessionId: null,
  sidebarOpen: true,
  isMobile: false,

  setAuth: (token, username) => {
    saveAuth(token, username);
    set({ token, username });
  },
  logout: () => {
    saveAuth(null, null);
    set({ token: null, username: null, sessions: [], activeSessionId: null });
  },

  setProfiles: (profiles) => set({ profiles }),
  addProfile: (profile) => set((s) => ({ profiles: [...s.profiles, profile] })),
  updateProfile: (profile) =>
    set((s) => ({ profiles: s.profiles.map((p) => (p.id === profile.id ? profile : p)) })),
  removeProfile: (id) => set((s) => ({ profiles: s.profiles.filter((p) => p.id !== id) })),

  addSession: (session) =>
    set((s) => {
      const exists = s.sessions.find((ss) => ss.id === session.id);
      if (exists) {
        return { sessions: s.sessions.map((ss) => ss.id === session.id ? { ...ss, ...session } : ss) };
      }
      return { sessions: [...s.sessions, session], activeSessionId: session.id };
    }),
  removeSession: (id) =>
    set((s) => {
      const sessions = s.sessions.filter((t) => t.id !== id);
      return {
        sessions,
        activeSessionId: s.activeSessionId === id ? sessions[0]?.id ?? null : s.activeSessionId,
      };
    }),
  setActiveSession: (id) => set({ activeSessionId: id }),

  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  setIsMobile: (v) => set({ isMobile: v }),
}));
