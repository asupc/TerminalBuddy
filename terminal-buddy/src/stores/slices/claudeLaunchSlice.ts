import type { StoreApi } from "zustand";
import type { AppState } from "../appStore";
import {
	getAntigravityProviderConfig,
	getCodexProviderState,
	listAntigravityModels,
	listClaudeLaunchTargets,
	type AntigravityProviderConfig,
	type LlmLaunchTarget,
} from "../../services/tauri";

let antigravityModelsInFlight: Promise<void> | null = null;
let antigravityConfigInFlight: Promise<void> | null = null;

export const createClaudeLaunchSlice = (
	set: StoreApi<AppState>["setState"],
): Partial<AppState> => ({
	/** Agent 管理的基础启动命令（空串 = 内置默认），供项目模型启动与历史恢复继承参数。 */
	agentCommands: { claude: '', codex: '', antigravity: '' },
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
	antigravityModels: [],
	antigravityModelsLoaded: false,
	antigravityModelsLoading: false,
	antigravityModelsError: null,
	refreshAntigravityModels: (force = false) => {
		if (antigravityModelsInFlight) return antigravityModelsInFlight;
		set({ antigravityModelsLoading: true, antigravityModelsError: null });
		const run = listAntigravityModels(force)
			.then(models => {
				set({
					antigravityModels: Array.isArray(models) ? models : [],
					antigravityModelsLoaded: true,
					antigravityModelsLoading: false,
					antigravityModelsError: null,
				});
			})
			.catch(error => {
				set({
					antigravityModelsLoaded: true,
					antigravityModelsLoading: false,
					antigravityModelsError: error instanceof Error ? error.message : String(error),
				});
			})
			.finally(() => {
				antigravityModelsInFlight = null;
			});
		antigravityModelsInFlight = run;
		return run;
	},
	antigravityProviderConfig: null,
	antigravityProviderConfigLoaded: false,
	refreshAntigravityProviderConfig: () => {
		if (antigravityConfigInFlight) return antigravityConfigInFlight;
		const run = getAntigravityProviderConfig()
			.then(config => {
				set({ antigravityProviderConfig: config, antigravityProviderConfigLoaded: true });
			})
			.catch(() => {
				set({ antigravityProviderConfigLoaded: true });
			})
			.finally(() => {
				antigravityConfigInFlight = null;
			});
		antigravityConfigInFlight = run;
		return run;
	},
	setAntigravityProviderConfig: (config: AntigravityProviderConfig) => {
		set({ antigravityProviderConfig: config, antigravityProviderConfigLoaded: true });
	},
});
