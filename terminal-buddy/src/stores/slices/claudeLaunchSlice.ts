import type { StoreApi } from "zustand";
import type { AppState } from "../appStore";
import { listClaudeLaunchTargets, type LlmLaunchTarget } from "../../services/tauri";

export const createClaudeLaunchSlice = (
	set: StoreApi<AppState>["setState"],
): Partial<AppState> => ({
	claudeLaunchTargets: [],
	claudeLaunchTargetsLoaded: false,
	refreshClaudeLaunchTargets: async () => {
		try {
			const targets = await listClaudeLaunchTargets();
			set({ claudeLaunchTargets: targets, claudeLaunchTargetsLoaded: true });
		} catch {
			// 右键菜单用缓存降级：加载失败保留旧值，不打断菜单渲染。
			set({ claudeLaunchTargetsLoaded: true });
		}
	},
	setClaudeLaunchTargets: (targets: LlmLaunchTarget[]) => {
		set({ claudeLaunchTargets: targets, claudeLaunchTargetsLoaded: true });
	},
});
