import type { StoreApi } from "zustand";
import type { AppState, TerminalActivityPhase } from "../appStore";
import { saveTabsToStorage, useAppStore } from "../appStore";
import type { TabGroup, TerminalSession } from "../../types";
import { deletePath, ensureDir, getDataPath, readClientData, updateTerminalDisplayName, writeClientData, writeFileContent } from "../../services/tauri";
import { TERMINAL_SPLIT_TRANSITION_GUARD_MS } from "../../utils/terminalResizeEvent";

let _saveTabsTimer: ReturnType<typeof setTimeout> | null = null;
/** 进行中的写入 promise：flush 时 await 它，保证退出前最后一次保存真正落盘。 */
let _saveTabsInFlight: Promise<void> = Promise.resolve();

function debouncedSaveTabs() {
	if (_saveTabsTimer) clearTimeout(_saveTabsTimer);
	_saveTabsTimer = setTimeout(() => {
		_saveTabsTimer = null;
		flushPendingSaveTabs();
	}, 300);
}

/**
 * 取消未触发的定时保存并立刻用**当前 store 快照**落盘。
 * 退出路径必须 await 本函数：闭包里的旧 sessions 会漏掉最后一次变更。
 */
export function flushPendingSaveTabs(): Promise<void> {
	if (_saveTabsTimer) {
		clearTimeout(_saveTabsTimer);
		_saveTabsTimer = null;
	}
	const { sessions, activeSessionId } = useAppStore.getState();
	_saveTabsInFlight = _saveTabsInFlight.then(() => saveTabsToStorage(sessions, activeSessionId));
	return _saveTabsInFlight;
}

// --- Draft management ---

export interface DraftEntry {
	filePath: string;
	createdAt: number;
}

async function loadDraftIndex(): Promise<DraftEntry[]> {
	try {
		const raw = await readClientData("drafts_index");
		if (raw) {
			const data = JSON.parse(raw);
			return Array.isArray(data) ? data : [];
		}
	} catch {}
	return [];
}

async function saveDraftIndex(drafts: DraftEntry[]): Promise<void> {
	await writeClientData("drafts_index", JSON.stringify(drafts));
}

async function ensureDraftsDir(): Promise<string> {
	const dataPath = await getDataPath();
	const draftsDir = dataPath + "\\ClientData\\drafts";
	await ensureDir(draftsDir);
	return draftsDir;
}

/** 构造 editor 会话（openEditorSession / openDraftSession / restoreDraftTabs 共用）。 */
function makeEditorSession(
	id: string,
	filePath: string,
	profileName: string,
	ssh?: { sshRemotePath?: string; sshTerminalId?: string },
): TerminalSession {
	return {
		id,
		profileId: filePath,
		profileName,
		terminalType: "editor",
		colorTheme: { background: "#1e1e1e", foreground: "#d4d4d4" },
		tabColor: null,
		groupId: "editor-group",
		sessionType: "editor",
		isDirty: false,
		sshRemotePath: ssh?.sshRemotePath,
		sshTerminalId: ssh?.sshTerminalId,
	};
}

/** 确保 editor 分组存在（不存在则追加，存在则原样返回）。 */
function withEditorGroup(groups: TabGroup[]): TabGroup[] {
	return groups.some((g) => g.id === "editor-group")
		? groups
		: [...groups, { id: "editor-group", name: "文本编辑", collapsed: false }];
}

export const createSessionsSlice = (
	set: StoreApi<AppState>["setState"],
	get: StoreApi<AppState>["getState"],
): Partial<AppState> => ({
	// Terminal Sessions
	sessions: [],
	activeSessionId: null,
	_skipSaveTabs: false,
	addSession: (session, keepActive) =>
		set((state) => {
			const s = {
				...session,
				groupId: session.groupId || "default",
				createdAt: session.createdAt ?? Date.now(),
			};
			const sessions = [...state.sessions, s];
			if (!state._skipSaveTabs && !s.starting) {
				debouncedSaveTabs();
			}
			return {
				sessions,
				activeSessionId: keepActive ? state.activeSessionId : s.id,
				activeSpecialTab: null,
			};
		}),
	resolveStartingSession: (startingId, terminalId) => {
		let resolved = false;
		set((state) => {
			if (!state.sessions.some((session) => session.id === startingId && session.starting)) {
				return state;
			}
			resolved = true;
			const sessions = state.sessions.map((session) => (session.id === startingId ? { ...session, id: terminalId, starting: false } : session));
			const activeSessionId = state.activeSessionId === startingId ? terminalId : state.activeSessionId;
			const splitSlots = state.splitSlots.map((slot) => (slot.sessionId === startingId ? { ...slot, sessionId: terminalId } : slot));
			if (!state._skipSaveTabs) {
				debouncedSaveTabs();
			}
			return {
				sessions,
				activeSessionId,
				splitSlots,
				terminalLayoutVersion: splitSlots.some((slot, index) => slot !== state.splitSlots[index]) ? state.terminalLayoutVersion + 1 : state.terminalLayoutVersion,
			};
		});
		return resolved;
	},
	removeSession: (id) => get().removeSessions([id]),
	removeSessions: (ids) =>
		set((state) => {
			const idsToRemove = new Set(ids);
			if (idsToRemove.size === 0 || !state.sessions.some((session) => idsToRemove.has(session.id))) {
				return state;
			}
			const sessions = state.sessions.filter((session) => !idsToRemove.has(session.id));
			let activeSessionId = state.activeSessionId !== null && idsToRemove.has(state.activeSessionId) ? (sessions[0]?.id ?? null) : state.activeSessionId;
			const restCache = { ...state.remoteFileCache };
			const terminalActivities = { ...state.terminalActivities };
			const claudeSessionIds = { ...state.claudeSessionIds };
			const sessionDirectories = { ...state.sessionDirectories };
			const terminalWebTakeovers = { ...state.terminalWebTakeovers };
			for (const id of idsToRemove) {
				delete restCache[id];
				delete terminalActivities[id];
				delete claudeSessionIds[id];
				delete sessionDirectories[id];
				delete terminalWebTakeovers[id];
			}
			// Split-slot cleanup: free any slot referencing the closed session.
			// If the closed pane was focused, refocus the first remaining filled slot
			// (split mode is preserved even if all slots become blank).
			let splitSlots = state.splitSlots;
			if (state.splitMode !== "off" && splitSlots.some((slot) => slot.sessionId !== null && idsToRemove.has(slot.sessionId))) {
				splitSlots = splitSlots.map((slot) => (slot.sessionId !== null && idsToRemove.has(slot.sessionId) ? { sessionId: null, enteredAt: 0 } : slot));
				if (state.activeSessionId !== null && idsToRemove.has(state.activeSessionId)) {
					activeSessionId = splitSlots.find((s) => s.sessionId !== null)?.sessionId ?? null;
				}
			}
			debouncedSaveTabs();
			return {
				sessions,
				activeSessionId,
				remoteFileCache: restCache,
				terminalActivities,
				terminalWebTakeovers,
				claudeSessionIds,
				sessionDirectories,
				splitSlots,
				terminalLayoutVersion: splitSlots !== state.splitSlots ? state.terminalLayoutVersion + 1 : state.terminalLayoutVersion,
			};
		}),
	setSessions: (sessions) => {
		const normalized = sessions.map((s) => ({ ...s, createdAt: s.createdAt ?? Date.now() }));
		const activeSessionId = normalized[0]?.id ?? null;
		saveTabsToStorage(normalized, activeSessionId);
		set({ sessions: normalized, activeSessionId, terminalActivities: {}, terminalWebTakeovers: {} });
	},
	setActiveSession: (id) =>
		set((state) => {
			// 文件导航跟随当前连接：优先使用会话内已记录的目录（用户浏览或 cd 过的）；
			// 若无记录，则回退到 profile 设置的启动目录（startupPath）。
			let currentDirectory = state.currentDirectory;
			if (id) {
				if (state.sessionDirectories[id]) {
					currentDirectory = state.sessionDirectories[id];
				} else {
					const session = state.sessions.find((s) => s.id === id);
					if (session) {
						const profile = state.profiles.find((p) => p.id === session.profileId);
						if (profile?.startupPath) {
							currentDirectory = profile.startupPath;
						}
					}
				}
			}
			if (!state._skipSaveTabs) {
				debouncedSaveTabs();
			}
			return { activeSessionId: id, currentDirectory, activeSpecialTab: null };
		}),
	renameSession: (id, name) => {
		const session = get().sessions.find((item) => item.id === id);
		if (session && session.sessionType !== "editor" && !session.starting) {
			void updateTerminalDisplayName(id, name).catch((error) => {
				console.error("Failed to sync terminal display name:", error);
			});
		}
		set((state) => {
			const newSessions = state.sessions.map((s) => (s.id === id ? { ...s, profileName: name } : s));
			debouncedSaveTabs();
			return { sessions: newSessions };
		});
	},
	updateSession: (id, updates) =>
		set((state) => {
			const newSessions = state.sessions.map((s) => (s.id === id ? { ...s, ...updates } : s));
			debouncedSaveTabs();
			return { sessions: newSessions };
		}),
	ensureEditorGroup: () =>
		set((state) => {
			const groups = withEditorGroup(state.groups);
			if (groups === state.groups) return state;
			return { groups };
		}),
	openEditorSession: (filePath, sshRemotePath?, sshTerminalId?) => {
		if (get().splitMode !== "off") {
			get().showToast("请先退出分屏模式再编辑文件", "info");
			return;
		}
		set((state) => {
			const existing = state.sessions.find((s) => s.sessionType === "editor" && s.profileId === filePath);
			if (existing) {
				saveTabsToStorage(state.sessions, existing.id);
				return { activeSessionId: existing.id, activeSpecialTab: null };
			}
			const fileName = filePath.split(/[\\/]/).pop() || filePath;
			const id = crypto.randomUUID();
			const session = makeEditorSession(id, filePath, fileName, { sshRemotePath, sshTerminalId });
			const sessions = [...state.sessions, session];
			saveTabsToStorage(sessions, id);
			return { sessions, activeSessionId: id, activeSpecialTab: null, groups: withEditorGroup(state.groups) };
		});
	},
	closeEditorSession: (id) =>
		set((state) => {
			const sessions = state.sessions.filter((s) => s.id !== id);
			const activeSessionId = state.activeSessionId === id ? (sessions[0]?.id ?? null) : state.activeSessionId;
			saveTabsToStorage(sessions, activeSessionId);
			return { sessions, activeSessionId };
		}),
	openDraftSession: async () => {
		if (get().splitMode !== "off") {
			get().showToast("请先退出分屏模式再编辑文件", "info");
			return;
		}
		const draftsDir = await ensureDraftsDir();
		const draftId = `draft_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
		const filePath = draftsDir + "\\" + draftId + ".txt";
		await writeFileContent(filePath, "");
		const drafts = await loadDraftIndex();
		drafts.push({ filePath, createdAt: Date.now() });
		await saveDraftIndex(drafts);

		const id = crypto.randomUUID();
		const session = makeEditorSession(id, filePath, "未命名");
		const sessions = [...get().sessions, session];
		saveTabsToStorage(sessions, id);
		set({ sessions, activeSessionId: id, activeSpecialTab: null, groups: withEditorGroup(get().groups) });
	},
	removeDraftFile: async (draftPath: string) => {
		try {
			await deletePath(draftPath);
		} catch {}
		const drafts = await loadDraftIndex();
		const next = drafts.filter((d) => d.filePath !== draftPath);
		await saveDraftIndex(next);
	},
	restoreDraftTabs: async () => {
		const drafts = await loadDraftIndex();
		if (drafts.length === 0) return;
		set({ _skipSaveTabs: true });
		try {
			for (const draft of drafts) {
				// Skip if already restored (e.g. by restoreTabs)
				const existing = get().sessions.find((s) => s.sessionType === "editor" && s.profileId === draft.filePath);
				if (existing) continue;
				try {
					const { getFileSize } = await import("../../services/tauri");
					await getFileSize(draft.filePath);
					get().ensureEditorGroup();
					const id = crypto.randomUUID();
					const session = makeEditorSession(id, draft.filePath, "未命名");
					get().addSession(session, true);
				} catch {
					// Draft file no longer exists, remove from index
					const remaining = (await loadDraftIndex()).filter((d) => d.filePath !== draft.filePath);
					await saveDraftIndex(remaining);
				}
			}
		} finally {
			set({ _skipSaveTabs: false });
			const { sessions, activeSessionId } = get();
			saveTabsToStorage(sessions, activeSessionId);
		}
	},
	sessionDirectories: {},
	setSessionDirectory: (sessionId, path) =>
		set((state) => ({
			sessionDirectories: { ...state.sessionDirectories, [sessionId]: path },
			...(state.activeSessionId === sessionId ? { currentDirectory: path } : {}),
		})),
	claudeSessionIds: {},
	setClaudeSessionId: (sessionId, claudeSessionId) =>
		set((state) => ({
			claudeSessionIds: { ...state.claudeSessionIds, [sessionId]: claudeSessionId },
		})),
	terminalActivities: {},
	terminalWebTakeovers: {},
	setTerminalWebTakeover: (sessionId, active) =>
		set((state) => {
			const isActive = Boolean(state.terminalWebTakeovers[sessionId]);
			if (isActive === active) return state;
			if (active) {
				return {
					terminalWebTakeovers: {
						...state.terminalWebTakeovers,
						[sessionId]: true,
					},
				};
			}
			const terminalWebTakeovers = { ...state.terminalWebTakeovers };
			delete terminalWebTakeovers[sessionId];
			return { terminalWebTakeovers };
		}),
	setTerminalFallbackWorking: (sessionId, working) =>
		set((state) => {
			const current = state.terminalActivities[sessionId];
			if (current?.runtimeKind === "claude") return state;
			const phase: TerminalActivityPhase = working ? "running" : "idle";
			if (current?.source === "legacy" && current.phase === phase) return state;
			return {
				terminalActivities: {
					...state.terminalActivities,
					[sessionId]: { runtimeKind: "shell", source: "legacy", phase, updatedAt: Date.now(), lastHookAt: current?.lastHookAt },
				},
			};
		}),
	applyClaudeHookActivity: (sessionId, phase, updatedAt) => {
		let applied = false;
		set((state) => {
			const current = state.terminalActivities[sessionId];
			if (current?.lastHookAt !== undefined && current.lastHookAt >= updatedAt) return state;
			applied = true;
			return {
				terminalActivities: {
					...state.terminalActivities,
					[sessionId]: { runtimeKind: "claude", source: "hook", phase, updatedAt, lastHookAt: updatedAt },
				},
			};
		});
		return applied;
	},
	endClaudeHookSession: (sessionId, updatedAt) => {
		let applied = false;
		set((state) => {
			const current = state.terminalActivities[sessionId];
			if (current?.lastHookAt !== undefined && current.lastHookAt >= updatedAt) return state;
			applied = true;
			return {
				terminalActivities: {
					...state.terminalActivities,
					[sessionId]: { runtimeKind: "shell", source: "legacy", phase: "idle", updatedAt, lastHookAt: updatedAt },
				},
			};
		});
		return applied;
	},
	expireClaudeHookActivity: (sessionId, expectedUpdatedAt) =>
		set((state) => {
			const current = state.terminalActivities[sessionId];
			if (current?.runtimeKind !== "claude" || current.phase !== "running" || current.updatedAt !== expectedUpdatedAt) {
				return state;
			}
			return {
				terminalActivities: {
					...state.terminalActivities,
					[sessionId]: {
						...current,
						runtimeKind: "shell",
						source: "legacy",
						phase: "idle",
						updatedAt: Date.now(),
					},
				},
			};
		}),
	handleTerminalInputActivity: (sessionId) =>
		set((state) => {
			const current = state.terminalActivities[sessionId];
			if (current?.runtimeKind === "claude") {
				if (current.phase !== "attention") return state;
				return {
					terminalActivities: {
						...state.terminalActivities,
						[sessionId]: { ...current, phase: "running", updatedAt: Date.now() },
					},
				};
			}
			return {
				terminalActivities: {
					...state.terminalActivities,
					[sessionId]: {
						runtimeKind: "shell",
						source: "legacy",
						phase: "running",
						updatedAt: Date.now(),
						lastHookAt: current?.lastHookAt,
					},
				},
			};
		}),

	// --- Split Screen ---
	splitMode: "off",
	splitSlots: [],
	terminalLayoutVersion: 0,
	splitTransitionUntil: 0,
	cycleSplitMode: () =>
		set((state) => {
			const nowMs = Date.now();
			const splitTransitionUntil = nowMs + TERMINAL_SPLIT_TRANSITION_GUARD_MS;
			if (state.splitTransitionUntil > nowMs) return state;

			const cur = state.splitMode;
			if (cur === "off") {
				// Entry: populate from terminal-session count (editors & web sessions excluded).
				const N = 2;
				const terms = state.sessions.filter((s) => s.sessionType !== "editor" && s.owner !== "web");
				const now = Date.now();
				let slots: { sessionId: string | null; enteredAt: number }[];
				if (terms.length <= N) {
					slots = terms.slice(0, N).map((s) => ({ sessionId: s.id, enteredAt: now }));
					while (slots.length < N) slots.push({ sessionId: null, enteredAt: 0 });
				} else {
					slots = new Array(N).fill(null).map(() => ({ sessionId: null, enteredAt: 0 }));
				}
				// Focus: keep current active if it ended up in a slot; else first filled slot; else unchanged.
				let activeSessionId = state.activeSessionId;
				if (activeSessionId && !slots.some((s) => s.sessionId === activeSessionId)) {
					activeSessionId = slots.find((s) => s.sessionId !== null)?.sessionId ?? activeSessionId;
				}
				return {
					splitMode: "2x1" as const,
					splitSlots: slots,
					activeSessionId,
					terminalLayoutVersion: state.terminalLayoutVersion + 1,
					splitTransitionUntil,
				};
			}
			if (cur === "2x1") {
				// Grow: preserve existing slot contents in place, append blank slots.
				return {
					splitMode: "2x2" as const,
					splitSlots: [...state.splitSlots, { sessionId: null, enteredAt: 0 }, { sessionId: null, enteredAt: 0 }],
					terminalLayoutVersion: state.terminalLayoutVersion + 1,
					splitTransitionUntil,
				};
			}
			// 2x2 -> off: exit. Sessions become normal tabs; activeSessionId (focused pane) stays, shown full-screen.
			return {
				splitMode: "off" as const,
				splitSlots: [],
				terminalLayoutVersion: state.terminalLayoutVersion + 1,
				splitTransitionUntil,
			};
		}),
	closeSplitPane: (slotIndex) => {
		const slot = get().splitSlots[slotIndex];
		if (slot?.sessionId) get().removeSession(slot.sessionId);
	},
	swapSplitSlots: (i, j) =>
		set((state) => {
			const slots = [...state.splitSlots];
			if (i < 0 || j < 0 || i >= slots.length || j >= slots.length) return state;
			[slots[i], slots[j]] = [slots[j], slots[i]];
			return { splitSlots: slots, terminalLayoutVersion: state.terminalLayoutVersion + 1 };
		}),
	placeSessionInSplitSlot: (sessionId) =>
		set((state) => {
			if (state.splitMode === "off") return state;
			const slots = state.splitSlots;

			// 1. 找空位
			const emptyIdx = slots.findIndex((s) => s.sessionId === null);
			if (emptyIdx !== -1) {
				const splitSlots = [...slots];
				splitSlots[emptyIdx] = { sessionId, enteredAt: Date.now() };
				return {
					splitSlots,
					activeSessionId: sessionId,
					terminalLayoutVersion: state.terminalLayoutVersion + 1,
				};
			}

			// 2. 无空位，替换最旧的
			let oldestIdx = 0;
			let oldestTime = slots[0].enteredAt;
			for (let i = 1; i < slots.length; i++) {
				if (slots[i].enteredAt < oldestTime) {
					oldestTime = slots[i].enteredAt;
					oldestIdx = i;
				}
			}
			const splitSlots = [...slots];
			splitSlots[oldestIdx] = { sessionId, enteredAt: Date.now() };
			return {
				splitSlots,
				activeSessionId: sessionId,
				terminalLayoutVersion: state.terminalLayoutVersion + 1,
			};
		}),
});
