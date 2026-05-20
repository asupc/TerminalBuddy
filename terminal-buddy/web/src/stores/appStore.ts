import { create } from 'zustand';
import type { Profile, WebTerminalSession } from '../types';

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
}

export const useWebAppStore = create<WebAppState>((set) => ({
  token: null,
  username: null,
  profiles: [],
  sessions: [],
  activeSessionId: null,
  sidebarOpen: true,

  setAuth: (token, username) => set({ token, username }),
  logout: () => set({ token: null, username: null, sessions: [], activeSessionId: null }),

  setProfiles: (profiles) => set({ profiles }),
  addProfile: (profile) => set((s) => ({ profiles: [...s.profiles, profile] })),
  updateProfile: (profile) =>
    set((s) => ({ profiles: s.profiles.map((p) => (p.id === profile.id ? profile : p)) })),
  removeProfile: (id) => set((s) => ({ profiles: s.profiles.filter((p) => p.id !== id) })),

  addSession: (session) =>
    set((s) => ({ sessions: [...s.sessions, session], activeSessionId: session.id })),
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
}));
