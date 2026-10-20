import type { StoreApi } from "zustand";
import type { AppState } from "../appStore";
import { getCodexProviderState, listClaudeLaunchTargets, type LlmLaunchTarget } from "../../services/tauri";

export const createClaudeLaunchSlice = (
	set: StoreApi<AppState>["setState"],
): Partial<AppState> => ({
	/** Agent 管理的基础启动命令（空串 = 内置默认），供项目模型启动与历史恢复继承参数。 */
	agentCommands: { claude: '', codex: '' },
	setAgentCommands: (commands) => set({ agentCommands: commands }),
	codexProviderState: null,
	providerSettingsTab: 'claude',
	setProviderSettingsTab: (tab) => set({ providerSettingsTab: tab }),
	setCodexProviderState: (state) => set({ codexProviderState: state }),
	refreshCodexLaunchTargets: async () => {
		try { set({ codexProviderState: await getCodexProviderState() }); }
		catch { /* 加载失败时保留菜单缓存，可从供应商页面重试。 */ }
	},
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
