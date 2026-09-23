import type { StoreApi } from "zustand";
import type { AppState } from "../appStore";
import { getAppSettings, saveAppSettings } from "../../utils/settings";

export const createProfilesSlice = (
	set: StoreApi<AppState>["setState"],
): Partial<AppState> => ({
	// Profiles
	profiles: [],
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
	toggleConfigPanel: () =>
		set((state) => {
			const next = !state.configPanelVisible;
			const s = getAppSettings();
			saveAppSettings({ ...s, configPanelAutoExpand: next });
			return { configPanelVisible: next };
		}),
	toggleFileTree: () =>
		set((state) => {
			const next = !state.fileTreeVisible;
			const s = getAppSettings();
			saveAppSettings({ ...s, fileTreeAutoExpand: next });
			return { fileTreeVisible: next };
		}),
	configSearchQuery: "",
	setConfigSearchQuery: (query) => set({ configSearchQuery: query }),

	settingsDialogOpen: false,
	gitHistoryTab: null,
	activeSpecialTab: null,
	openSettingsDialog: () => set({ settingsDialogOpen: true }),
	closeSettingsDialog: () => set({ settingsDialogOpen: false }),
	openGitHistoryTab: (tab) => set({ gitHistoryTab: tab, activeSpecialTab: "git-history" }),
	closeGitHistoryTab: () =>
		set((state) => ({
			gitHistoryTab: null,
			activeSpecialTab: state.activeSpecialTab === "git-history" ? null : state.activeSpecialTab,
		})),
	setActiveSpecialTab: (tab) => set({ activeSpecialTab: tab }),

	exclusionPatterns: ["node_modules", ".git"],
	setExclusionPatterns: (patterns) => set({ exclusionPatterns: patterns }),

	// 拖拽中的 profile id（ConfigNav → TabNav 启动终端）
	dragProfileId: null,
	setDragProfileId: (id) => set({ dragProfileId: id }),
});
