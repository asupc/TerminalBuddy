import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { api } from './api';
import type { ExtraParamPreset, HistoryEntry, Profile, TerminalInfo } from './types';

export type View =
  | { screen: 'nav' }
  | { screen: 'terminal'; terminalId: string; profileName: string; owner: 'pc' | 'web' };

interface AppState {
  // 鉴权（持久化）
  token: string | null;
  username: string | null;
  // 导航数据（不持久化）
  profiles: Profile[];
  sessions: TerminalInfo[];
  metaOnline: boolean;
  // 启动参数预设（不持久化，从后端 ClientData 加载，与 PC 端共享）
  extraParamPresets: ExtraParamPreset[];
  presetsLoading: boolean;
  // 命令历史（不持久化，从后端 ClientData 加载，与 PC 端共享）
  commandHistory: HistoryEntry[];
  // 当前界面
  view: View;

  setAuth: (token: string, username: string) => void;
  logout: () => void;
  setProfiles: (p: Profile[]) => void;
  setSessions: (s: TerminalInfo[]) => void;
  setMetaOnline: (b: boolean) => void;
  setView: (v: View) => void;

  loadExtraParamPresets: () => Promise<void>;
  addExtraParamPreset: (name: string, params: string, tagColor: string | null, commandMatch: string | null) => Promise<void>;
  updateExtraParamPreset: (id: string, patch: Partial<Omit<ExtraParamPreset, 'id'>>) => Promise<void>;
  removeExtraParamPreset: (id: string) => Promise<void>;
  loadCommandHistory: () => Promise<void>;
  appendCommandHistory: (command: string) => Promise<void>;
}

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      token: null,
      username: null,
      profiles: [],
      sessions: [],
      metaOnline: false,
      extraParamPresets: [],
      presetsLoading: false,
      commandHistory: [],
      view: { screen: 'nav' },
      setAuth: (token, username) => set({ token, username }),
      logout: () =>
        set({ token: null, username: null, profiles: [], sessions: [], extraParamPresets: [], commandHistory: [], view: { screen: 'nav' } }),
      setProfiles: (profiles) => set({ profiles }),
      setSessions: (sessions) => set({ sessions }),
      setMetaOnline: (metaOnline) => set({ metaOnline }),
      setView: (view) => set({ view }),

      loadExtraParamPresets: async () => {
        set({ presetsLoading: true });
        try {
          const presets = await api.getExtraParamPresets();
          set({ extraParamPresets: presets });
        } catch {
          /* 静默失败，不影响主流程 */
        } finally {
          set({ presetsLoading: false });
        }
      },
      addExtraParamPreset: async (name, params, tagColor, commandMatch) => {
        const preset: ExtraParamPreset = {
          id: crypto.randomUUID(),
          name,
          params,
          tagColor,
          commandMatch,
        };
        const next = [...get().extraParamPresets, preset];
        set({ extraParamPresets: next });
        await api.replaceExtraParamPresets(next);
      },
      updateExtraParamPreset: async (id, patch) => {
        const next = get().extraParamPresets.map((p) =>
          p.id === id ? { ...p, ...patch } : p,
        );
        set({ extraParamPresets: next });
        await api.replaceExtraParamPresets(next);
      },
      removeExtraParamPreset: async (id) => {
        const next = get().extraParamPresets.filter((p) => p.id !== id);
        set({ extraParamPresets: next });
        await api.replaceExtraParamPresets(next);
      },
      loadCommandHistory: async () => {
        try {
          const entries = await api.getCommandHistory();
          set({ commandHistory: entries });
        } catch {
          /* 静默失败，命令历史不影响主流程 */
        }
      },
      appendCommandHistory: async (command) => {
        const trimmed = command.trim();
        if (!trimmed) return;
        const current = get().commandHistory;
        // 去重：相同命令移到队尾
        const next = [...current.filter((h) => h.command !== trimmed), { command: trimmed }];
        // 上限 500 条防止文件无限膨胀
        const trimmed500 = next.slice(-500);
        set({ commandHistory: trimmed500 });
        try {
          await api.replaceCommandHistory(trimmed500);
        } catch {
          /* 本地状态已更新，下次重新加载时再同步 */
        }
      },
    }),
    {
      name: 'terminalbuddy_mobile_auth',
      // 只持久化登录态，profiles/sessions/presets/view 每次进入重新获取
      partialize: (s) => ({ token: s.token, username: s.username }),
    },
  ),
);
