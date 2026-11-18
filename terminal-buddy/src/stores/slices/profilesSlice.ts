import { sessionReplayTabKey } from '../../utils/sessionHistory';
import {
	getVisibleActiveTabKey,
	GIT_CHANGES_TAB_KEY,
	GIT_HISTORY_TAB_KEY,
	recordTabActivation,
	replayTabKey,
	resolveCloseTabState,
	SCHEDULED_TASKS_TAB_KEY,
} from '../../utils/tabActivation';
import type { StoreApi } from "zustand";
import type { AppState } from "../appStore";
import { getAppSettings, saveAppSettings } from "../../utils/settings";

export const createProfilesSlice = (
	set: StoreApi<AppState>["setState"],
): Partial<AppState> => ({
	// Profiles
	profiles: [],
	projects: [],
	setProjects: (projects) => set({ projects }),
	selectedProfileId: null,
	setProfiles: (profiles) => set({ profiles }),
	addProfile: (profile) => set((state) => ({ profiles: [...state.profiles, profile] })),
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
	historyPanelVisible: true,
	// 从状态栏 Agent 历史入口等位置请求打开会话历史时，指定要展示的来源；
	// focusToken 每次请求自增，侧栏风格据此把隐藏的历史面板切到前台。
	historyPanelProvider: null,
	historyPanelFocusToken: 0,
	openHistoryPanel: (provider) =>
		set((state) => {
			const willOpen = !state.historyPanelVisible;
			if (willOpen) {
				const s = getAppSettings();
				saveAppSettings({ ...s, historyPanelAutoExpand: true });
			}
			return {
				historyPanelVisible: true,
				historyPanelProvider: provider ?? state.historyPanelProvider,
				historyPanelFocusToken: state.historyPanelFocusToken + 1,
				terminalLayoutVersion: willOpen
					? state.terminalLayoutVersion + 1
					: state.terminalLayoutVersion,
			};
		}),
	toggleConfigPanel: () =>
		set((state) => {
			const next = !state.configPanelVisible;
			const s = getAppSettings();
			saveAppSettings({ ...s, configPanelAutoExpand: next });
			// bump 布局版本，驱动 TerminalPanel 派发 TERMINAL_RESIZE_EVENT 强制 fit：
			// 面板显隐会改变终端区宽度，但 ResizeObserver 走 force=false，TUI 下会被
			// alt-buffer 守卫拦下不重排，故这里走与 F11 同款的确定性修复链路。
			return { configPanelVisible: next, terminalLayoutVersion: state.terminalLayoutVersion + 1 };
		}),
	toggleFileTree: () =>
		set((state) => {
			const next = !state.fileTreeVisible;
			const s = getAppSettings();
			saveAppSettings({ ...s, fileTreeAutoExpand: next });
			return { fileTreeVisible: next, terminalLayoutVersion: state.terminalLayoutVersion + 1 };
		}),
	toggleHistoryPanel: () =>
		set((state) => {
			const next = !state.historyPanelVisible;
			const s = getAppSettings();
			saveAppSettings({ ...s, historyPanelAutoExpand: next });
			return { historyPanelVisible: next, terminalLayoutVersion: state.terminalLayoutVersion + 1 };
		}),
	configSearchQuery: "",
	setConfigSearchQuery: (query) => set({ configSearchQuery: query }),

	settingsDialogOpen: false,
	settingsDialogSection: null,
	gitHistoryTab: null,
	gitChangesTab: null,
	claudeReplayTab: null,
	claudeReplayTabs: [],
	activeSpecialTab: null,
	scheduledTasksTabOpen: false,
	openSettingsDialog: (section) => set({ settingsDialogOpen: true, settingsDialogSection: section ?? null }),
	closeSettingsDialog: () => set({ settingsDialogOpen: false, settingsDialogSection: null }),
	openGitHistoryTab: (tab) =>
		set((state) => ({
			gitHistoryTab: tab,
			activeSpecialTab: "git-history",
			tabActivationHistory: recordTabActivation(state.tabActivationHistory, GIT_HISTORY_TAB_KEY),
		})),
	closeGitHistoryTab: () =>
		set((state) => ({
			gitHistoryTab: null,
			...resolveCloseTabState(state, { gitHistoryTab: null }, [GIT_HISTORY_TAB_KEY]),
		})),
	openGitChangesTab: (tab) =>
		set((state) => ({
			gitChangesTab: tab,
			activeSpecialTab: "git-changes",
			tabActivationHistory: recordTabActivation(state.tabActivationHistory, GIT_CHANGES_TAB_KEY),
		})),
	closeGitChangesTab: () =>
		set((state) => ({
			gitChangesTab: null,
			...resolveCloseTabState(state, { gitChangesTab: null }, [GIT_CHANGES_TAB_KEY]),
		})),
	openClaudeReplayTab: (tab) =>
		set((state) => ({
			claudeReplayTabs: state.claudeReplayTabs.some(item => sessionReplayTabKey(item) === sessionReplayTabKey(tab))
				? state.claudeReplayTabs.map(item => sessionReplayTabKey(item) === sessionReplayTabKey(tab) ? tab : item)
				: [...state.claudeReplayTabs, tab],
			claudeReplayTab: tab,
			activeSpecialTab: "claude-replay",
			tabActivationHistory: recordTabActivation(state.tabActivationHistory, replayTabKey(tab)),
		})),
	closeClaudeReplayTab: (sessionId, provider) =>
		set((state) => {
			const target = sessionId ? sessionReplayTabKey({ sessionId, provider })
				: state.claudeReplayTab ? sessionReplayTabKey(state.claudeReplayTab) : undefined;
			const remaining = state.claudeReplayTabs.filter(item => sessionReplayTabKey(item) !== target);
			const removedKeys = target ? [`replay:${target}`] : [];
			return {
				claudeReplayTabs: remaining,
				...resolveCloseTabState(state, { claudeReplayTabs: remaining }, removedKeys),
			};
		}),
	setActiveSpecialTab: (tab) =>
		set((state) => {
			const nextKey = getVisibleActiveTabKey({ ...state, activeSpecialTab: tab });
			return {
				activeSpecialTab: tab,
				...(nextKey ? { tabActivationHistory: recordTabActivation(state.tabActivationHistory, nextKey) } : {}),
			};
		}),
	// 定时任务页面：打开时激活；切到其他标签时保持打开状态，关闭时才消失。
	openScheduledTasksPage: () =>
		set((state) => ({
			scheduledTasksTabOpen: true,
			activeSpecialTab: "scheduled-tasks",
			tabActivationHistory: recordTabActivation(state.tabActivationHistory, SCHEDULED_TASKS_TAB_KEY),
		})),
	closeScheduledTasksPage: () =>
		set((state) => ({
			scheduledTasksTabOpen: false,
			...resolveCloseTabState(state, { scheduledTasksTabOpen: false }, [SCHEDULED_TASKS_TAB_KEY]),
		})),

	exclusionPatterns: ["node_modules", ".git"],
	setExclusionPatterns: (patterns) => {
		set({ exclusionPatterns: patterns });
		// 排除规则持久化到后端（审查 H-9）：此前只写内存，重启即丢。
		// 失败不阻断 UI（与主题等其他客户端数据一致的降级策略）。
		import("../../services/tauri").then(({ writeClientData }) =>
			writeClientData("exclusion_patterns", JSON.stringify(patterns))
		).catch(e => console.error("保存排除规则失败:", e));
	},

	// 拖拽中的 profile id（ConfigNav → TabNav 启动终端）
	dragProfileId: null,
	setDragProfileId: (id) => set({ dragProfileId: id }),
});
