import type { StoreApi } from "zustand";
import type { AgentTab, AppState } from "../appStore";
import { saveTabsToStorage } from "../appStore";
import {
	agentChatTabKey,
	appendBackgroundTab,
	recordTabActivation,
	resolveCloseTabState,
} from "../../utils/tabActivation";

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
	agentDrafts: {},
	agentDraftImages: {},
	// 只活在内存里：刷新页面后不需要再补焦点。
	pendingAgentInputFocusKey: null,

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
				tabActivationHistory: recordTabActivation(state.tabActivationHistory, agentChatTabKey(tab.key)),
			};
		});
		persistNow(get);
	},

	// 其他端（如手机 App）新建会话时在标签栏补开标签，但不打断电脑端当前操作：
	// activeAgentTabKey / activeSpecialTab 一律不动。
	addAgentTab: (tab) => {
		set((state) => {
			if (state.agentTabs.some((item) => item.key === tab.key)) return state;
			return {
				agentTabs: [...state.agentTabs, tab],
				tabActivationHistory: appendBackgroundTab(state.tabActivationHistory, agentChatTabKey(tab.key)),
			};
		});
		persistNow(get);
	},

	closeAgentTab: (key) => {
		set((state) => {
			if (!state.agentTabs.some((item) => item.key === key)) return state;
			const agentTabs = state.agentTabs.filter((item) => item.key !== key);
			const closeUpdate = resolveCloseTabState(state, { agentTabs }, [agentChatTabKey(key)]);
			// 标签关闭后草稿与待发送图片没有归属，一并清掉，避免内存里残留无主内容。
			const { [key]: _removedDraft, ...agentDrafts } = state.agentDrafts;
			const { [key]: _removedDraftImages, ...agentDraftImages } = state.agentDraftImages;
			return {
				agentTabs,
				...closeUpdate,
				agentDrafts,
				agentDraftImages,
				// 标签已关闭，一次性聚焦标记不该继续留着。
				pendingAgentInputFocusKey:
					state.pendingAgentInputFocusKey === key ? null : state.pendingAgentInputFocusKey,
			};
		});
		persistNow(get);
	},

	setAgentDraft: (key, text) => {
		set((state) => {
			if (state.agentDrafts[key] === text) return state;
			return { agentDrafts: { ...state.agentDrafts, [key]: text } };
		});
	},

	setAgentDraftImages: (key, images) => {
		set((state) => {
			if (state.agentDraftImages[key] === images) return state;
			return { agentDraftImages: { ...state.agentDraftImages, [key]: images } };
		});
	},

	requestAgentInputFocus: (key) => {
		set({ pendingAgentInputFocusKey: key });
	},

	consumeAgentInputFocus: (key) => {
		// 用 getState 而非闭包里的 state：调用方通常在 effect 里读，必须拿最新值。
		if (get().pendingAgentInputFocusKey !== key) return false;
		set({ pendingAgentInputFocusKey: null });
		return true;
	},

	updateAgentTab: (key, patch) => {
		let changed = false;
		set((state) => {
			const index = state.agentTabs.findIndex((item) => item.key === key);
			if (index < 0) return state;
			const target = state.agentTabs[index];
			const targetRecord = target as unknown as Record<string, unknown>;
			const patchRecord = patch as Record<string, unknown>;
			const keys = Object.keys(patchRecord);
			if (keys.every((k) => targetRecord[k] === patchRecord[k])) {
				return state;
			}
			changed = true;
			const next = state.agentTabs.slice();
			next[index] = { ...target, ...patch } as AgentTab;
			return { agentTabs: next };
		});
		if (changed) {
			schedulePersist(get);
		}
	},

	setActiveAgentTab: (key) => {
		set((state) => ({
			activeAgentTabKey: key,
			activeSpecialTab: "agent-chat",
			tabActivationHistory: recordTabActivation(state.tabActivationHistory, agentChatTabKey(key)),
		}));
		schedulePersist(get);
	},
});
