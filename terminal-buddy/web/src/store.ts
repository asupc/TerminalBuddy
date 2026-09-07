import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { api } from './api';
import type { ExtraParamMode, ExtraParamPreset, Profile, TerminalInfo, TerminalLoadingMode } from './types';

export type View =
  | { screen: 'nav' }
  | {
      screen: 'terminal';
      terminalId: string;
      profileName: string;
      loadingMode: TerminalLoadingMode;
      owner: 'pc' | 'web';
    };

/** 连接的终态：重试耗尽或登录过期后停止自动重连，UI 给出可操作入口。 */
export type ConnectionFatal =
  | { kind: 'expired' }
  | { kind: 'failed'; message: string };

interface AppState {
  // 鉴权（持久化）
  token: string | null;
  username: string | null;
  // 导航数据（不持久化）
  profiles: Profile[];
  sessions: TerminalInfo[];
  metaOnline: boolean;
  /** WS 重试耗尽 / 登录过期的终态；非 null 时 UI 显示重试/重登入口。 */
  connectionFatal: ConnectionFatal | null;
  // 启动参数预设（不持久化，从后端 ClientData 加载，与 PC 端共享）
  extraParamPresets: ExtraParamPreset[];
  presetsLoading: boolean;
  // 当前界面
  view: View;
  // 导航栏折叠状态（持久化；类似 PC 端 configPanelVisible）
  navCollapsed: boolean;
  /** 「立即重试」递增计数；WS hook 监听它强制重建连接。 */
  reconnectNonce: number;

  setAuth: (token: string, username: string) => void;
  logout: () => void;
  setProfiles: (p: Profile[]) => void;
  setSessions: (s: TerminalInfo[]) => void;
  setMetaOnline: (b: boolean) => void;
  setConnectionFatal: (fatal: ConnectionFatal | null) => void;
  /** 清除终态并立即重试连接（「立即重试」按钮）。 */
  retryFailedConnection: () => void;
  setView: (v: View) => void;
  setNavCollapsed: (collapsed: boolean) => void;
  toggleNavCollapsed: () => void;

  loadExtraParamPresets: () => Promise<void>;
  addExtraParamPreset: (name: string, params: string, tagColor: string | null, commandMatch: string | null, mode: ExtraParamMode) => Promise<void>;
  updateExtraParamPreset: (id: string, patch: Partial<Omit<ExtraParamPreset, 'id'>>) => Promise<void>;
  removeExtraParamPreset: (id: string) => Promise<void>;
}

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      token: null,
      username: null,
      profiles: [],
      sessions: [],
      metaOnline: false,
      connectionFatal: null,
      extraParamPresets: [],
      presetsLoading: false,
      view: { screen: 'nav' },
      navCollapsed: false,
      reconnectNonce: 0,
      setAuth: (token, username) => set({ token, username }),
      // 仅供 api.ts 的 401 handler 调用以清除过期 token；UI 已下线
      logout: () =>
        set({ token: null, username: null, profiles: [], sessions: [], extraParamPresets: [], view: { screen: 'nav' }, connectionFatal: null }),
      setProfiles: (profiles) => set({ profiles }),
      setSessions: (sessions) => set({ sessions }),
      setMetaOnline: (metaOnline) => set({ metaOnline }),
      setConnectionFatal: (connectionFatal) => set({ connectionFatal }),
      retryFailedConnection: () => {
        // 清除终态；WS hook 的重试计数同时归零（连接效果由 reconnectNonce 驱动）
        set((s) => ({ connectionFatal: null, reconnectNonce: s.reconnectNonce + 1 }));
      },
      setView: (view) => set({ view }),
      setNavCollapsed: (navCollapsed) => set({ navCollapsed }),
      toggleNavCollapsed: () => set((s) => ({ navCollapsed: !s.navCollapsed })),

      loadExtraParamPresets: async () => {
        set({ presetsLoading: true });
        try {
          const rawPresets = await api.getExtraParamPresets();
          const presets = rawPresets.map((preset) => ({
            ...preset,
            mode: preset.mode === 'independent' ? 'independent' as const : 'append' as const,
          }));
          set({ extraParamPresets: presets });
        } catch {
          /* 静默失败，不影响主流程 */
        } finally {
          set({ presetsLoading: false });
        }
      },
      addExtraParamPreset: async (name, params, tagColor, commandMatch, mode) => {
        const preset: ExtraParamPreset = {
          id: crypto.randomUUID(),
          name,
          params,
          mode,
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
    }),
    {
      name: 'terminalbuddy_mobile_auth',
      // 持久化登录态与导航折叠偏好，profiles/sessions/presets/view 每次进入重新获取
      partialize: (s) => ({ token: s.token, username: s.username, navCollapsed: s.navCollapsed }),
    },
  ),
);
