import type { StoreApi } from "zustand";
import type { AppState } from "../appStore";
import { saveEnableTabNavigation } from "../../services/tauri";
import { getAppSettings, saveAppSettings } from "../../utils/settings";

export const createWindowSlice = (
	set: StoreApi<AppState>["setState"],
): Partial<AppState> => ({
	// Window mode (F11 cycle)
	windowMode: "normal",
	previousPanelState: null,
	cycleWindowMode: () =>
		set((state) => {
			const cur = state.windowMode;

			if (cur === "normal") {
				// normal → panels-hidden: 保存当前面板状态
				const settings = getAppSettings();
				return {
					windowMode: "panels-hidden" as const,
					terminalLayoutVersion: state.terminalLayoutVersion + 1,
					previousPanelState: {
						configPanelVisible: state.configPanelVisible,
						fileTreeVisible: state.fileTreeVisible,
						enableTabNavigation: settings.enableTabNavigation,
					},
				};
			}

			// panels-hidden → normal: 恢复之前的面板状态
			const prev = state.previousPanelState;
			if (prev) {
				const settings = getAppSettings();
				saveAppSettings({ ...settings, enableTabNavigation: prev.enableTabNavigation });
				saveEnableTabNavigation(prev.enableTabNavigation).catch(() => {});
				window.dispatchEvent(new CustomEvent("tab-navigation-changed"));
			}
			return {
				windowMode: "normal" as const,
				terminalLayoutVersion: state.terminalLayoutVersion + 1,
				previousPanelState: null,
				configPanelVisible: prev?.configPanelVisible ?? state.configPanelVisible,
				fileTreeVisible: prev?.fileTreeVisible ?? state.fileTreeVisible,
			};
		}),

	// Toast (transient notifications, e.g. "split grid full")
	toast: null,
	showToast: (message, type = "info") =>
		set({
			toast: { id: Date.now() + Math.random(), message, type },
		}),
	dismissToast: (id) => set((state) => (state.toast?.id === id ? { toast: null } : {})),

	// Settings version (app-settings-changed 时自增，触发依赖它的 TabNav/TabBar 重渲染；
	// 此前只有类型声明没有任何实现，监听器一触发就抛 TypeError)
	settingsVersion: 0,
	incrementSettingsVersion: () =>
		set((state) => ({ settingsVersion: state.settingsVersion + 1 })),
});
