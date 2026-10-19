import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { api } from './api';
import type { ExtraParamMode, ExtraParamPreset, Profile, Project, TerminalInfo, TerminalLoadingMode, TerminalTaskSummary } from './types';

export type View =
  | { screen: 'nav' }
  | {
      screen: 'terminal';
      terminalId: string;
      profileName: string;
      loadingMode: TerminalLoadingMode;
      owner: 'pc' | 'web';
    }
  | { screen: 'claudeHistory' }
  | {
      screen: 'claudeReplay';
      sessionId: string;
      title?: string;
      /** 全文检索命中锚定跳转的消息 seq */
      focusSeq?: number;
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
  /** 项目列表（项目与命令 / Claude 历史分组共用） */
  projects: Project[];
  sessions: TerminalInfo[];
  showTaskSummary: boolean;
  taskSummaries: Record<string, TerminalTaskSummary>;
  taskSummarySaving: boolean;
  taskSummaryError: string | null;
  refreshTaskSummaries: (terminalIds: string[]) => Promise<void>;
  setShowTaskSummary: (enabled: boolean) => Promise<void>;
  metaOnline: boolean;
  /** WS 重试耗尽 / 登录过期的终态；非 null 时 UI 显示重试/重登入口。 */
  connectionFatal: ConnectionFatal | null;
  // 启动参数预设（不持久化，从后端 ClientData 加载，与 PC 端共享）
  extraParamPresets: ExtraParamPreset[];
  presetsLoading: boolean;
  presetsError: string | null;
  // 当前界面
  view: View;
  // 导航栏折叠状态（持久化；类似 PC 端 configPanelVisible）
  navCollapsed: boolean;
  /** 「立即重试」递增计数；WS hook 监听它强制重建连接。 */
  reconnectNonce: number;

  setAuth: (token: string, username: string) => void;
  logout: () => void;
  setProfiles: (p: Profile[]) => void;
  setProjects: (p: Project[]) => void;
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
  moveExtraParamPreset: (id: string, delta: number) => Promise<void>;
}

let taskSettingsRevision = 0;

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      token: null,
      username: null,
      profiles: [],
      projects: [],
      sessions: [],
      showTaskSummary: false,
      taskSummaries: {},
      taskSummarySaving: false,
      taskSummaryError: null,
      refreshTaskSummaries: async (terminalIds) => {
        const revision = taskSettingsRevision;
        const token = get().token;
        const result = await api.getTerminalTaskSummaries(terminalIds);
        if (get().token !== token || revision !== taskSettingsRevision || get().taskSummarySaving) return;
        if (get().showTaskSummary !== result.enabled || JSON.stringify(get().taskSummaries) !== JSON.stringify(result.summaries)) {
          set({ showTaskSummary: result.enabled, taskSummaries: result.enabled ? result.summaries : {} });
        }
      },
      setShowTaskSummary: async (enabled) => {
        if (get().taskSummarySaving) return;
        taskSettingsRevision += 1;
        set({ taskSummarySaving: true, taskSummaryError: null });
        try {
          await api.setShowTaskSummary(enabled);
          taskSettingsRevision += 1;
          set({ showTaskSummary: enabled, ...(!enabled ? { taskSummaries: {} } : {}) });
              } catch (error) {
          set({ taskSummaryError: `保存任务摘要设置失败：${String(error)}` });
        } finally {
          set({ taskSummarySaving: false });
          window.dispatchEvent(new Event('terminal-task-summary-changed'));
        }
      },
      metaOnline: false,
      connectionFatal: null,
      extraParamPresets: [],
      presetsLoading: false,
      presetsError: null,
      view: { screen: 'nav' },
      navCollapsed: false,
      reconnectNonce: 0,
      setAuth: (token, username) => set({ token, username }),
      // 仅供 api.ts 的 401 handler 调用以清除过期 token；UI 已下线
      logout: () =>
        set({ token: null, username: null, profiles: [], projects: [], sessions: [], showTaskSummary: false, taskSummaries: {}, extraParamPresets: [], presetsError: null, view: { screen: 'nav' }, connectionFatal: null }),
      setProfiles: (profiles) => set({ profiles }),
      setProjects: (projects) => set({ projects }),
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
        set({ presetsLoading: true, presetsError: null });
        try {
          const rawPresets = await api.getExtraParamPresets();
          const presets = rawPresets.map((preset) => ({
            ...preset,
            mode: preset.mode === 'independent' ? 'independent' as const : 'append' as const,
          }));
          set({ extraParamPresets: presets });
        } catch (error) {
          set({ presetsError: error instanceof Error ? error.message : '加载启动参数失败' });
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
          enabled: true,
        };
        const next = [...get().extraParamPresets, preset];
        const saved = await api.replaceExtraParamPresets(next);
        set({ extraParamPresets: saved });
      },
      updateExtraParamPreset: async (id, patch) => {
        const next = get().extraParamPresets.map((p) =>
          p.id === id ? { ...p, ...patch } : p,
        );
        const saved = await api.replaceExtraParamPresets(next);
        set({ extraParamPresets: saved });
      },
      moveExtraParamPreset: async (id, delta) => {
        const next = [...get().extraParamPresets];
        const index = next.findIndex(p => p.id === id), target = index + delta;
        if (index < 0 || target < 0 || target >= next.length) return;
        [next[index], next[target]] = [next[target], next[index]];
        set({ extraParamPresets: await api.replaceExtraParamPresets(next) });
      },
      removeExtraParamPreset: async (id) => {
        const next = get().extraParamPresets.filter((p) => p.id !== id);
        const saved = await api.replaceExtraParamPresets(next);
        set({ extraParamPresets: saved });
      },
    }),
    {
      name: 'terminalbuddy_mobile_auth',
      // 持久化登录态与导航折叠偏好，profiles/sessions/presets/view 每次进入重新获取
      partialize: (s) => ({ token: s.token, username: s.username, navCollapsed: s.navCollapsed }),
    },
  ),
);
