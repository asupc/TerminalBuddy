import { create } from "zustand";
import type { Profile, TerminalSession, TabGroup, ExtraParamPreset, RemoteFileEntry, ServerStats, TransferItem } from "../types";
import { readClientData, writeClientData } from "../services/tauri";
import { createProfilesSlice } from "./slices/profilesSlice";
import { createFileTreeSlice } from "./slices/fileTreeSlice";
import { createSessionsSlice } from "./slices/sessionsSlice";
import { createTabsSlice } from "./slices/tabsSlice";
import { createTransfersSlice } from "./slices/transfersSlice";
import { createWindowSlice } from "./slices/windowSlice";

interface SavedTab {
	profileId: string;
	profileName: string;
	terminalType: string;
	colorTheme: { background: string; foreground: string };
	tabColor: string | null;
	groupId: string;
	groupName?: string;
	sessionType?: "terminal" | "editor";
	isDirty?: boolean;
	owner?: "pc" | "web";
	extraParams?: string;
	extraParamMode?: "append" | "independent";
	extraParamTag?: string;
	extraParamTagColor?: string | null;
	directory?: string;
	claudeSessionId?: string;
}

export interface GitHistoryTab {
	repoRoot: string;
	branch: string;
}

export type WorkspaceSpecialTab = "git-history" | null;

export type TerminalRuntimeKind = "shell" | "claude";
export type TerminalActivityPhase = "idle" | "running" | "attention" | "completed" | "failed";

export interface TerminalActivityState {
	runtimeKind: TerminalRuntimeKind;
	source: "legacy" | "hook";
	phase: TerminalActivityPhase;
	updatedAt: number;
	lastHookAt?: number;
}

export function isTerminalWorking(activity: TerminalActivityState | undefined): boolean {
	return activity?.phase === "running";
}

export function saveTabsToStorage(sessions: TerminalSession[], activeSessionId: string | null): Promise<void> {
	try {
		const dirs = useAppStore.getState().sessionDirectories;
		const claudeIds = useAppStore.getState().claudeSessionIds;
		// 启动中的临时会话没有后端 PTY，退出应用后不能恢复，也不能影响 activeIndex。
		const persistedSessions = sessions.filter((s) => !s.starting);
		const tabs: SavedTab[] = persistedSessions.map((s) => ({
			profileId: s.profileId,
			profileName: s.profileName,
			terminalType: s.terminalType,
			colorTheme: s.colorTheme,
			tabColor: s.tabColor,
			groupId: s.groupId,
			groupName: s.groupName,
			sessionType: s.sessionType,
			isDirty: s.sessionType === "editor" ? false : undefined,
			owner: s.owner,
			extraParams: s.extraParams,
			extraParamMode: s.extraParamMode,
			extraParamTag: s.extraParamTag,
			extraParamTagColor: s.extraParamTagColor ?? null,
			directory: dirs[s.id],
			claudeSessionId: claudeIds[s.id],
		}));
		const resolvedActiveIndex = activeSessionId ? persistedSessions.findIndex((s) => s.id === activeSessionId) : -1;
		const activeIndex = resolvedActiveIndex >= 0 ? resolvedActiveIndex : 0;
		// 保存失败必须留痕：静默吞掉会让「重启后标签丢了」无从排查。
		// 返回 Promise 让退出流程可以 await，避免 invoke 未 settle 进程就退出。
		return writeClientData("saved_tabs", JSON.stringify({ tabs, activeIndex })).catch((error) => {
			console.error("Failed to save tabs:", error);
		});
	} catch (error) {
		console.error("Failed to serialize tabs:", error);
		return Promise.resolve();
	}
}

/**
 * 最低字段校验 + 默认值归一化。磁盘数据可能来自旧版本或手工编辑，
 * 畸形条目不能产生 NaN / undefined 渲染状态。
 */
function normalizeSavedTab(raw: unknown): SavedTab | null {
	if (typeof raw !== "object" || raw === null) return null;
	const tab = raw as Record<string, unknown>;
	const profileId = typeof tab.profileId === "string" ? tab.profileId : "";
	const profileName = typeof tab.profileName === "string" ? tab.profileName : "";
	const terminalType = typeof tab.terminalType === "string" ? tab.terminalType : "";
	// 三者皆空说明条目已损坏到无法恢复（至少要有类型或文件路径之一）
	if (!terminalType && !profileId) return null;
	const colorTheme =
		typeof tab.colorTheme === "object" && tab.colorTheme !== null
			? (tab.colorTheme as { background?: unknown; foreground?: unknown })
			: {};
	return {
		profileId,
		profileName,
		terminalType,
		colorTheme: {
			background: typeof colorTheme.background === "string" ? colorTheme.background : "#1e1e1e",
			foreground: typeof colorTheme.foreground === "string" ? colorTheme.foreground : "#d4d4d4",
		},
		tabColor: typeof tab.tabColor === "string" ? tab.tabColor : null,
		groupId: typeof tab.groupId === "string" ? tab.groupId : "default",
		groupName: typeof tab.groupName === "string" ? tab.groupName : undefined,
		sessionType: tab.sessionType === "editor" || tab.sessionType === "terminal" ? tab.sessionType : undefined,
		isDirty: typeof tab.isDirty === "boolean" ? tab.isDirty : undefined,
		owner: tab.owner === "pc" || tab.owner === "web" ? tab.owner : undefined,
		extraParams: typeof tab.extraParams === "string" ? tab.extraParams : undefined,
		extraParamMode: tab.extraParamMode === "independent" ? "independent" : tab.extraParamMode === "append" ? "append" : undefined,
		extraParamTag: typeof tab.extraParamTag === "string" ? tab.extraParamTag : undefined,
		extraParamTagColor: typeof tab.extraParamTagColor === "string" ? tab.extraParamTagColor : null,
		directory: typeof tab.directory === "string" ? tab.directory : undefined,
		claudeSessionId: typeof tab.claudeSessionId === "string" ? tab.claudeSessionId : undefined,
	};
}

export async function loadSavedTabs(): Promise<{ tabs: SavedTab[]; activeIndex: number }> {
	try {
		const raw = await readClientData("saved_tabs");
		if (raw) {
			const data = JSON.parse(raw);
			// 根值必须是对象；tabs 必须是数组；逐条校验归一化
			if (typeof data !== "object" || data === null || !Array.isArray(data.tabs)) {
				return { tabs: [], activeIndex: 0 };
			}
			const tabs = data.tabs
				.map(normalizeSavedTab)
				.filter((tab: SavedTab | null): tab is SavedTab => tab !== null);
			// activeIndex 必须是有限整数并 clamp 到有效范围，畸形值（"x"、NaN、1e9）一律安全降级
			const rawActiveIndex = data.activeIndex;
			const activeIndex =
				typeof rawActiveIndex === "number" && Number.isFinite(rawActiveIndex) && Number.isInteger(rawActiveIndex)
					? Math.min(Math.max(rawActiveIndex, 0), Math.max(tabs.length - 1, 0))
					: 0;
			return { tabs, activeIndex };
		}
	} catch (error) {
		console.error("Failed to load saved tabs:", error);
	}
	return { tabs: [], activeIndex: 0 };
}

export async function initExtraParamPresets() {
	try {
		const raw = await readClientData("extra_param_presets");
		if (raw) {
			const parsed = JSON.parse(raw) as Array<Partial<ExtraParamPreset>>;
			// 兼容旧数据：补齐后续版本新增的可选字段
			const normalized: ExtraParamPreset[] = (Array.isArray(parsed) ? parsed : []).map((p) => ({
				id: p.id ?? crypto.randomUUID(),
				name: p.name ?? "",
				params: p.params ?? "",
				mode: p.mode === "independent" ? "independent" : "append",
				tagColor: p.tagColor ?? null,
				commandMatch: p.commandMatch ?? null,
				enabled: p.enabled !== false,
			}));
			useAppStore.setState({ extraParamPresets: normalized });
		}
	} catch {}
}

export async function initFileTreeNav() {
	try {
		const raw = await readClientData("file_nav");
		if (raw) {
			const data = JSON.parse(raw);
			if (Array.isArray(data?.backStack)) {
				useAppStore.setState({ navBackStack: data.backStack.filter((p: unknown) => typeof p === "string") });
			}
			if (Array.isArray(data?.forwardStack)) {
				useAppStore.setState({ navForwardStack: data.forwardStack.filter((p: unknown) => typeof p === "string") });
			}
			if (data?.sortBy === "name" || data?.sortBy === "size" || data?.sortBy === "modified") {
				useAppStore.setState({ fileSortBy: data.sortBy });
			}
			if (data?.sortDir === "asc" || data?.sortDir === "desc") {
				useAppStore.setState({ fileSortDir: data.sortDir });
			}
			if (Array.isArray(data?.roots)) {
				const fileRoots = data.roots.filter((path: unknown): path is string => typeof path === "string" && path.trim().length > 0).filter((path: string, index: number, paths: string[]) => paths.findIndex((candidate) => candidate.toLowerCase() === path.toLowerCase()) === index);
				useAppStore.setState({ fileRoots });
			}
		}
	} catch {}
}

export interface AppState {
	// Profiles
	profiles: Profile[];
	selectedProfileId: string | null;
	setProfiles: (profiles: Profile[]) => void;
	addProfile: (profile: Profile) => void;
	updateProfile: (profile: Profile) => void;
	removeProfile: (id: string) => void;
	selectProfile: (id: string | null) => void;

	// UI State
	configPanelVisible: boolean;
	fileTreeVisible: boolean;
	toggleConfigPanel: () => void;
	toggleFileTree: () => void;

	// Config panel search
	configSearchQuery: string;
	setConfigSearchQuery: (query: string) => void;

	// Settings dialog and workspace special tabs
	settingsDialogOpen: boolean;
	openSettingsDialog: () => void;
	closeSettingsDialog: () => void;
	gitHistoryTab: GitHistoryTab | null;
	openGitHistoryTab: (tab: GitHistoryTab) => void;
	closeGitHistoryTab: () => void;
	activeSpecialTab: WorkspaceSpecialTab;
	setActiveSpecialTab: (tab: WorkspaceSpecialTab) => void;

	// File exclusion patterns
	exclusionPatterns: string[];
	setExclusionPatterns: (patterns: string[]) => void;

	// File tree navigation history (back/forward across directories)
	currentDirectory: string;
	setCurrentDirectory: (path: string) => void;
	navBackStack: string[];
	navForwardStack: string[];
	navigateWithHistory: (path: string) => void;
	navBack: () => string | null;
	navForward: () => string | null;

	// File tree sort preference
	fileSortBy: "name" | "size" | "modified";
	fileSortDir: "asc" | "desc";
	setFileSort: (by: "name" | "size" | "modified", dir: "asc" | "desc") => void;
	fileRoots: string[];
	addFileRoot: (path: string) => void;
	removeFileRoot: (path: string) => void;

	// Tab Groups
	groups: TabGroup[];
	addGroup: (name: string, color?: string) => void;
	removeGroup: (id: string) => void;
	renameGroup: (id: string, name: string) => void;
	setGroupColor: (id: string, color: string) => void;
	toggleGroupCollapse: (id: string) => void;
	moveSessionToGroup: (sessionId: string, groupId: string) => void;

	// Terminal Sessions
	sessions: TerminalSession[];
	activeSessionId: string | null;
	_skipSaveTabs: boolean;
	addSession: (session: TerminalSession, keepActive?: boolean) => void;
	resolveStartingSession: (startingId: string, terminalId: string) => boolean;
	removeSession: (id: string) => void;
	removeSessions: (ids: readonly string[]) => void;
	setActiveSession: (id: string | null) => void;
	setSessions: (sessions: TerminalSession[]) => void;
	renameSession: (id: string, name: string) => void;
	updateSession: (id: string, updates: Partial<TerminalSession>) => void;
	ensureEditorGroup: () => void;
	openEditorSession: (filePath: string, sshRemotePath?: string, sshTerminalId?: string) => void;
	closeEditorSession: (id: string) => void;
	openDraftSession: () => Promise<void>;
	removeDraftFile: (draftPath: string) => Promise<void>;
	restoreDraftTabs: () => Promise<void>;
	sessionDirectories: Record<string, string>;
	setSessionDirectory: (sessionId: string, path: string) => void;

	// Claude Code session IDs
	claudeSessionIds: Record<string, string>;
	setClaudeSessionId: (sessionId: string, claudeSessionId: string) => void;

	// Unified terminal activity. Claude Hook becomes authoritative after first valid event.
	terminalActivities: Record<string, TerminalActivityState>;
	terminalWebTakeovers: Record<string, boolean>;
	setTerminalWebTakeover: (sessionId: string, active: boolean) => void;
	setTerminalFallbackWorking: (sessionId: string, working: boolean) => void;
	applyClaudeHookActivity: (sessionId: string, phase: TerminalActivityPhase, updatedAt: number) => boolean;
	endClaudeHookSession: (sessionId: string, updatedAt: number) => boolean;
	expireClaudeHookActivity: (sessionId: string, expectedUpdatedAt: number) => void;
	handleTerminalInputActivity: (sessionId: string) => void;

	// Split Screen mode
	splitMode: "off" | "2x1" | "2x2";
	splitSlots: { sessionId: string | null; enteredAt: number }[];
	terminalLayoutVersion: number;
	splitTransitionUntil: number;
	cycleSplitMode: () => void;
	closeSplitPane: (slotIndex: number) => void;
	swapSplitSlots: (i: number, j: number) => void;
	placeSessionInSplitSlot: (sessionId: string) => void;

	// Window mode (F11 cycle)
	windowMode: "normal" | "panels-hidden";
	previousPanelState: { configPanelVisible: boolean; fileTreeVisible: boolean; enableTabNavigation: boolean } | null;
	cycleWindowMode: () => void;

	// Toast (transient notifications, e.g. "split grid full")
	toast: { id: number; message: string; type: "info" | "success" | "error" } | null;
	showToast: (message: string, type?: "info" | "success" | "error") => void;
	dismissToast: (id: number) => void;

	// Settings version (incremented when settings change, triggers re-render in subscribers)
	settingsVersion: number;
	incrementSettingsVersion: () => void;

	// Internal drag paths (from FileTree to terminal)
	dragPaths: string[] | null;
	setDragPaths: (paths: string[] | null) => void;

	// 拖拽中的 profile id（ConfigNav → TabNav 启动终端）
	dragProfileId: string | null;
	setDragProfileId: (id: string | null) => void;

	// Extra param presets
	extraParamPresets: ExtraParamPreset[];
	addExtraParamPreset: (name: string, params: string, tagColor?: string | null, commandMatch?: string | null, mode?: "append" | "independent") => void;
	updateExtraParamPreset: (id: string, patch: Partial<Omit<ExtraParamPreset, "id">>) => void;
	removeExtraParamPreset: (id: string) => void;
	reorderExtraParamPresets: (fromId: string, toId: string, position: "before" | "after") => void;

	// Last click region for F2 routing
	lastClickRegion: "config" | "tab" | null;
	setLastClickRegion: (region: "config" | "tab" | null) => void;

	// Remote file cache (per session)
	remoteFileCache: Record<string, { files: RemoteFileEntry[]; currentPath: string }>;
	setRemoteFileCache: (terminalId: string, cache: { files: RemoteFileEntry[]; currentPath: string }) => void;
	clearRemoteFileCache: (terminalId: string) => void;

	// Remote clipboard
	remoteClipboard: { items: string[]; operation: "copy" | "move" } | null;
	setRemoteClipboard: (clipboard: { items: string[]; operation: "copy" | "move" } | null) => void;

	// Server stats
	serverStats: ServerStats | null;
	setServerStats: (stats: ServerStats | null) => void;

	// Transfer state
	transfers: TransferItem[];
	addTransfer: (item: TransferItem) => void;
	updateTransferProgress: (id: string, transferred: number, total: number, percent: number) => void;
	completeTransfer: (id: string) => void;
	failTransfer: (id: string, error: string) => void;
	removeTransfer: (id: string) => void;
	clearCompletedTransfers: (terminalId: string) => void;
	clearCompletedTransfersByProfile: (profileId: string) => void;
}

// 各 slice 只声明自己管辖的字段（Partial<AppState>），
// spread 组合后即为完整 AppState；断言仅用于恢复全量类型。
export const useAppStore = create<AppState>((set, get) => ({
	...createProfilesSlice(set),
	...createFileTreeSlice(set, get),
	...createSessionsSlice(set, get),
	...createTabsSlice(set),
	...createTransfersSlice(set),
	...createWindowSlice(set),
}) as AppState);

// Listen for app-settings-changed events and increment version to trigger re-renders
if (!(window as any).__settingsListenerRegistered) {
	(window as any).__settingsListenerRegistered = true;
	window.addEventListener("app-settings-changed", () => {
		useAppStore.getState().incrementSettingsVersion();
	});
}
