import { sessionReplayTabKey } from "./sessionHistory";
import type {
	AgentTab,
	ClaudeReplayTab,
	GitChangesTab,
	GitHistoryTab,
	WorkspaceSpecialTab,
} from "../stores/appStore";
import type { TerminalSession } from "../types";

export const sessionTabKey = (id: string) => `session:${id}`;
export const agentChatTabKey = (key: string) => `agent:${key}`;
export const replayTabKey = (tab: Pick<ClaudeReplayTab, "provider" | "sessionId">) =>
	`replay:${sessionReplayTabKey(tab)}`;
export const GIT_CHANGES_TAB_KEY = "special:git-changes";
export const GIT_HISTORY_TAB_KEY = "special:git-history";
export const SCHEDULED_TASKS_TAB_KEY = "special:scheduled-tasks";

export interface SplitSlotSnapshot {
	sessionId: string | null;
	enteredAt: number;
}

export interface TabActivationState {
	sessions?: TerminalSession[];
	activeSessionId?: string | null;
	agentTabs?: AgentTab[];
	activeAgentTabKey?: string | null;
	claudeReplayTabs?: ClaudeReplayTab[];
	claudeReplayTab?: ClaudeReplayTab | null;
	gitChangesTab?: GitChangesTab | null;
	gitHistoryTab?: GitHistoryTab | null;
	scheduledTasksTabOpen?: boolean;
	activeSpecialTab?: WorkspaceSpecialTab;
	splitMode?: "off" | "2x1" | "2x2";
	splitSlots?: SplitSlotSnapshot[];
	tabActivationHistory?: string[];
}

/** 将激活的标签 key 置顶（index 0 表示当前最近激活的标签）。 */
export function recordTabActivation(history: readonly string[] | undefined, key: string): string[] {
	const list = history ?? [];
	if (list[0] === key) return list as string[];
	return [key, ...list.filter((item) => item !== key)];
}

/** 后台新建但未激活的标签追加到末尾，不抢占已激活标签的最近使用顺位。 */
export function appendBackgroundTab(history: readonly string[] | undefined, key: string): string[] {
	const list = history ?? [];
	if (list.includes(key)) return list as string[];
	return [...list, key];
}

/** 占位终端解析为真实 terminalId 时，原地替换历史记录中的 key 并去重。 */
export function replaceTabHistoryKey(
	history: readonly string[] | undefined,
	oldKey: string,
	newKey: string,
): string[] {
	const list = history ?? [];
	if (!list.includes(oldKey)) return list as string[];
	const result: string[] = [];
	let replaced = false;
	for (const item of list) {
		if (item === oldKey) {
			if (!replaced) {
				result.push(newKey);
				replaced = true;
			}
		} else if (item !== newKey) {
			result.push(item);
		}
	}
	return result;
}

/** 从激活历史中移除已关闭的标签 key。 */
export function removeTabHistoryKeys(
	history: readonly string[] | undefined,
	keysToRemove: Iterable<string>,
): string[] {
	const removeSet = keysToRemove instanceof Set ? keysToRemove : new Set(keysToRemove);
	if (removeSet.size === 0) return (history ?? []) as string[];
	return (history ?? []).filter((item) => !removeSet.has(item));
}

/** 返回当前用户可见区域正在激活的标签 key；无激活标签时返回 null。 */
export function getVisibleActiveTabKey(state: TabActivationState): string | null {
	switch (state.activeSpecialTab ?? null) {
		case "agent-chat": {
			const key = state.activeAgentTabKey;
			if (!key) return null;
			return (state.agentTabs ?? []).some((tab) => tab.key === key) ? agentChatTabKey(key) : null;
		}
		case "claude-replay":
			return state.claudeReplayTab ? replayTabKey(state.claudeReplayTab) : null;
		case "git-changes":
			return state.gitChangesTab ? GIT_CHANGES_TAB_KEY : null;
		case "git-history":
			return state.gitHistoryTab ? GIT_HISTORY_TAB_KEY : null;
		case "scheduled-tasks":
			return state.scheduledTasksTabOpen ? SCHEDULED_TASKS_TAB_KEY : null;
		case null: {
			const id = state.activeSessionId;
			if (!id) return null;
			return (state.sessions ?? []).some((session) => session.id === id) ? sessionTabKey(id) : null;
		}
	}
}

function isSessionSelectable(state: TabActivationState, sessionId: string): boolean {
	if (!(state.sessions ?? []).some((session) => session.id === sessionId)) return false;
	if (state.splitMode && state.splitMode !== "off") {
		return (state.splitSlots ?? []).some((slot) => slot.sessionId === sessionId);
	}
	return true;
}

function isSelectableTabKey(state: TabActivationState, key: string): boolean {
	if (key.startsWith("session:")) {
		return isSessionSelectable(state, key.slice("session:".length));
	}
	if (key.startsWith("agent:")) {
		const agentKey = key.slice("agent:".length);
		return (state.agentTabs ?? []).some((tab) => tab.key === agentKey);
	}
	if (key.startsWith("replay:")) {
		const replayTarget = key.slice("replay:".length);
		return (state.claudeReplayTabs ?? []).some((tab) => sessionReplayTabKey(tab) === replayTarget);
	}
	if (key === GIT_CHANGES_TAB_KEY) return Boolean(state.gitChangesTab);
	if (key === GIT_HISTORY_TAB_KEY) return Boolean(state.gitHistoryTab);
	if (key === SCHEDULED_TASKS_TAB_KEY) return Boolean(state.scheduledTasksTabOpen);
	return false;
}

function findFallbackSessionId(state: TabActivationState, history: readonly string[]): string | null {
	for (const key of history) {
		if (!key.startsWith("session:")) continue;
		const id = key.slice("session:".length);
		if (isSessionSelectable(state, id)) return id;
	}
	const sessions = state.sessions ?? [];
	if (state.splitMode && state.splitMode !== "off") {
		for (const slot of state.splitSlots ?? []) {
			if (slot.sessionId !== null && sessions.some((session) => session.id === slot.sessionId)) {
				return slot.sessionId;
			}
		}
		return null;
	}
	return sessions[0]?.id ?? null;
}

function findFallbackAgentKey(state: TabActivationState, history: readonly string[]): string | null {
	const agentTabs = state.agentTabs ?? [];
	for (const key of history) {
		if (!key.startsWith("agent:")) continue;
		const agentKey = key.slice("agent:".length);
		if (agentTabs.some((tab) => tab.key === agentKey)) return agentKey;
	}
	return agentTabs[agentTabs.length - 1]?.key ?? null;
}

function findFallbackReplayTab(state: TabActivationState, history: readonly string[]): ClaudeReplayTab | null {
	const replayTabs = state.claudeReplayTabs ?? [];
	for (const key of history) {
		if (!key.startsWith("replay:")) continue;
		const target = key.slice("replay:".length);
		const found = replayTabs.find((tab) => sessionReplayTabKey(tab) === target);
		if (found) return found;
	}
	return replayTabs[replayTabs.length - 1] ?? null;
}

/**
 * 计算关闭一个或多个标签后的激活态更新：
 * - 关闭当前激活标签时，按最近激活历史切回上一个仍然打开的标签；
 * - 关闭非当前激活标签时，保持当前激活标签状态不变，仅清理指向被删项的悬空指针。
 */
export function resolveCloseTabState(
	prevState: TabActivationState,
	nextPatch: Partial<TabActivationState>,
	removedKeys: readonly string[],
): Partial<TabActivationState> {
	const nextState: TabActivationState = { ...prevState, ...nextPatch };
	const removedSet = new Set(removedKeys);
	const nextHistory = removeTabHistoryKeys(prevState.tabActivationHistory, removedSet);
	const prevVisibleKey = getVisibleActiveTabKey(prevState);
	const wasVisibleActive = prevVisibleKey !== null && removedSet.has(prevVisibleKey);

	const updates: Partial<TabActivationState> = {
		tabActivationHistory: nextHistory,
	};

	const prevSessionId = prevState.activeSessionId ?? null;
	const prevAgentKey = prevState.activeAgentTabKey ?? null;
	const prevReplayTab = prevState.claudeReplayTab ?? null;
	const prevSpecialTab = prevState.activeSpecialTab ?? null;

	const cleanSessionId = () =>
		prevSessionId && removedSet.has(sessionTabKey(prevSessionId))
			? findFallbackSessionId(nextState, nextHistory)
			: prevSessionId;

	const cleanAgentKey = () =>
		prevAgentKey && removedSet.has(agentChatTabKey(prevAgentKey))
			? findFallbackAgentKey(nextState, nextHistory)
			: prevAgentKey;

	const cleanReplayTab = () =>
		prevReplayTab && removedSet.has(replayTabKey(prevReplayTab))
			? findFallbackReplayTab(nextState, nextHistory)
			: prevReplayTab;

	if (!wasVisibleActive) {
		const nextSessionId = cleanSessionId();
		if (nextSessionId !== prevSessionId) updates.activeSessionId = nextSessionId;
		const nextAgentKey = cleanAgentKey();
		if (nextAgentKey !== prevAgentKey) updates.activeAgentTabKey = nextAgentKey;
		const nextReplayTab = cleanReplayTab();
		if (nextReplayTab !== prevReplayTab) updates.claudeReplayTab = nextReplayTab;
		return updates;
	}

	// 分屏模式下关闭当前聚焦分屏：留在分屏视图并聚焦最近使用过的其余分屏；若均为空则保持空白分屏位。
	if (nextState.splitMode && nextState.splitMode !== "off" && prevSpecialTab === null) {
		const nextSlotSessionId = findFallbackSessionId(nextState, nextHistory);
		if (nextSlotSessionId !== prevSessionId) updates.activeSessionId = nextSlotSessionId;
		if (nextSlotSessionId) {
			updates.tabActivationHistory = recordTabActivation(nextHistory, sessionTabKey(nextSlotSessionId));
		}
		return updates;
	}

	let targetKey: string | null = null;
	for (const candidate of nextHistory) {
		if (isSelectableTabKey(nextState, candidate)) {
			targetKey = candidate;
			break;
		}
	}
	if (!targetKey) {
		const fallbackSession = findFallbackSessionId(nextState, nextHistory);
		const agentTabs = nextState.agentTabs ?? [];
		const replayTabs = nextState.claudeReplayTabs ?? [];
		if (fallbackSession) targetKey = sessionTabKey(fallbackSession);
		else if (agentTabs.length > 0) {
			targetKey = agentChatTabKey(agentTabs[agentTabs.length - 1].key);
		} else if (replayTabs.length > 0) {
			targetKey = replayTabKey(replayTabs[replayTabs.length - 1]);
		} else if (nextState.gitChangesTab) targetKey = GIT_CHANGES_TAB_KEY;
		else if (nextState.gitHistoryTab) targetKey = GIT_HISTORY_TAB_KEY;
		else if (nextState.scheduledTasksTabOpen) targetKey = SCHEDULED_TASKS_TAB_KEY;
	}

	let nextActiveSessionId = cleanSessionId();
	let nextActiveAgentTabKey = cleanAgentKey();
	let nextClaudeReplayTab = cleanReplayTab();
	let nextActiveSpecialTab: WorkspaceSpecialTab = null;

	if (targetKey === null) {
		nextActiveSpecialTab = null;
		if (nextState.splitMode && nextState.splitMode !== "off") {
			nextActiveSessionId = findFallbackSessionId(nextState, nextHistory);
		}
	} else if (targetKey.startsWith("session:")) {
		nextActiveSpecialTab = null;
		nextActiveSessionId = targetKey.slice("session:".length);
	} else if (targetKey.startsWith("agent:")) {
		nextActiveSpecialTab = "agent-chat";
		nextActiveAgentTabKey = targetKey.slice("agent:".length);
	} else if (targetKey.startsWith("replay:")) {
		const replayTarget = targetKey.slice("replay:".length);
		const found =
			(nextState.claudeReplayTabs ?? []).find((tab) => sessionReplayTabKey(tab) === replayTarget) ?? null;
		nextActiveSpecialTab = found ? "claude-replay" : null;
		nextClaudeReplayTab = found;
	} else if (targetKey === GIT_CHANGES_TAB_KEY) {
		nextActiveSpecialTab = "git-changes";
	} else if (targetKey === GIT_HISTORY_TAB_KEY) {
		nextActiveSpecialTab = "git-history";
	} else if (targetKey === SCHEDULED_TASKS_TAB_KEY) {
		nextActiveSpecialTab = "scheduled-tasks";
	}

	if (nextActiveSessionId !== prevSessionId) updates.activeSessionId = nextActiveSessionId;
	if (nextActiveAgentTabKey !== prevAgentKey) updates.activeAgentTabKey = nextActiveAgentTabKey;
	if (nextClaudeReplayTab !== prevReplayTab) updates.claudeReplayTab = nextClaudeReplayTab;
	if (nextActiveSpecialTab !== prevSpecialTab) updates.activeSpecialTab = nextActiveSpecialTab;
	if (targetKey) {
		updates.tabActivationHistory = recordTabActivation(nextHistory, targetKey);
	}
	return updates;
}

/** 将激活历史序列化为与持久化工件匹配的 token 列表（s:<index> / a:<agentKey>）。 */
export function serializeRecentTabs(
	history: readonly string[] | undefined,
	persistedSessions: readonly Pick<TerminalSession, "id">[],
	persistedAgentTabs: readonly Pick<AgentTab, "key">[],
): string[] {
	const list = history ?? [];
	const sessionIndexById = new Map<string, number>();
	persistedSessions.forEach((session, index) => {
		sessionIndexById.set(session.id, index);
	});
	const agentKeySet = new Set(persistedAgentTabs.map((tab) => tab.key));
	const result: string[] = [];
	const seen = new Set<string>();
	for (const key of list) {
		let token: string | null = null;
		if (key.startsWith("session:")) {
			const idx = sessionIndexById.get(key.slice("session:".length));
			if (idx !== undefined) token = `s:${idx}`;
		} else if (key.startsWith("agent:")) {
			const agentKey = key.slice("agent:".length);
			if (agentKeySet.has(agentKey)) token = `a:${agentKey}`;
		}
		if (token && !seen.has(token)) {
			seen.add(token);
			result.push(token);
		}
	}
	return result;
}
