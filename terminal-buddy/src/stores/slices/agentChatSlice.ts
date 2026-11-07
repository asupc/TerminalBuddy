import type { StoreApi } from "zustand";
import type { AgentTab, AppState } from "../appStore";
import { saveTabsToStorage } from "../appStore";

/** 聊天标签的落盘：打开/关闭立即写；标题/状态更新走防抖，避免每个流式帧都写 ClientData。 */
let saveTimer: number | null = null;
const persistNow = (get: () => AppState) => {
	if (saveTimer !== null) { window.clearTimeout(saveTimer); saveTimer = null; }
	const state = get();
	void saveTabsToStorage(state.sessions, state.activeSessionId);
};
const schedulePersist = (get: () => AppState) => {
	if (saveTimer !== null) window.clearTimeout(saveTimer);
	saveTimer = window.setTimeout(() => {
		saveTimer = null;
		const state = get();
		void saveTabsToStorage(state.sessions, state.activeSessionId);
	}, 400);
};

/**
 * 会话式聊天标签：原生会话与终端接力共用一组标签，`shape` 区分形态。
 * 形态在创建时固定，不随设置变化（决策 2 / 3）。
 */
export const createAgentChatSlice = (
	set: StoreApi<AppState>["setState"],
	get: () => AppState,
): Partial<AppState> => ({
	agentTabs: [],
	activeAgentTabKey: null,

	openAgentTab: (tab) => {
		set((state) => {
			const exists = state.agentTabs.some((item) => item.key === tab.key);
			const agentTabs = exists
				? state.agentTabs.map((item) => (item.key === tab.key ? ({ ...item, ...tab } as AgentTab) : item))
				: [...state.agentTabs, tab];
			return {
				agentTabs,
				activeAgentTabKey: tab.key,
				activeSpecialTab: "agent-chat",
			};
		});
		persistNow(get);
	},

	closeAgentTab: (key) => {
		set((state) => {
			const agentTabs = state.agentTabs.filter((item) => item.key !== key);
			const wasActive = state.activeAgentTabKey === key;
			// 关闭当前标签后回到最后一个仍打开的会话；没有则回到终端区。
			const nextActive = wasActive ? (agentTabs[agentTabs.length - 1]?.key ?? null) : state.activeAgentTabKey;
			return {
				agentTabs,
				activeAgentTabKey: nextActive,
				activeSpecialTab:
					state.activeSpecialTab === "agent-chat" && wasActive && nextActive === null
						? null
						: state.activeSpecialTab,
			};
		});
		persistNow(get);
	},

	updateAgentTab: (key, patch) => {
		set((state) => ({
			agentTabs: state.agentTabs.map((item) => (item.key === key ? ({ ...item, ...patch } as AgentTab) : item)),
		}));
		schedulePersist(get);
	},

	setActiveAgentTab: (key) => {
		set({ activeAgentTabKey: key, activeSpecialTab: "agent-chat" });
		schedulePersist(get);
	},
});
