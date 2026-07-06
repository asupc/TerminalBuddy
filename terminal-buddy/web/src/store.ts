import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Profile, TerminalInfo } from './types';

export type View =
  | { screen: 'nav' }
  | { screen: 'terminal'; terminalId: string; profileName: string };

interface AppState {
  // 鉴权（持久化）
  token: string | null;
  username: string | null;
  // 导航数据（不持久化）
  profiles: Profile[];
  sessions: TerminalInfo[];
  metaOnline: boolean;
  // 当前界面
  view: View;

  setAuth: (token: string, username: string) => void;
  logout: () => void;
  setProfiles: (p: Profile[]) => void;
  setSessions: (s: TerminalInfo[]) => void;
  setMetaOnline: (b: boolean) => void;
  setView: (v: View) => void;
}

export const useStore = create<AppState>()(
  persist(
    (set) => ({
      token: null,
      username: null,
      profiles: [],
      sessions: [],
      metaOnline: false,
      view: { screen: 'nav' },
      setAuth: (token, username) => set({ token, username }),
      logout: () =>
        set({ token: null, username: null, profiles: [], sessions: [], view: { screen: 'nav' } }),
      setProfiles: (profiles) => set({ profiles }),
      setSessions: (sessions) => set({ sessions }),
      setMetaOnline: (metaOnline) => set({ metaOnline }),
      setView: (view) => set({ view }),
    }),
    {
      name: 'terminalbuddy_mobile_auth',
      // 只持久化登录态，profiles/sessions/view 每次进入重新获取
      partialize: (s) => ({ token: s.token, username: s.username }),
    },
  ),
);
