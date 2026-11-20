import { invoke } from './../remoteWorkspace/core';

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export const EFFORT_LABELS: Record<EffortLevel, string> = {
  low: '低 low',
  medium: '中 medium',
  high: '高 high',
  xhigh: '极高 xhigh',
  max: '最高 max',
};

export type LlmAuthType = 'ANTHROPIC_AUTH_TOKEN' | 'ANTHROPIC_API_KEY';

export interface LlmModelConfig {
  id: string;
  enabled: boolean;
  contextWindow: number;
  effortLevel: string;
  maxOutputTokens: number;
}

export interface LlmProviderView {
  id: string;
  name: string;
  baseUrl: string;
  authType: LlmAuthType;
  keySet: boolean;
  keyTail: string;
  isDefault: boolean;
  defaultEffortLevel: string;
  /** 设置后会把 Claude 默认配置（settings.json）改写为该供应商与模型。 */
  defaultModel: string;
  modelsUrl: string;
  enabledModels: LlmModelConfig[];
  sortIndex: number;
  createdAt: string;
  updatedAt: string;
}

export interface LlmProviderInput {
  id?: string;
  name: string;
  baseUrl: string;
  authType: LlmAuthType;
  /** 新建必填；更新时留空表示沿用已保存密钥 */
  apiKey?: string;
  isDefault: boolean;
  defaultEffortLevel: string;
  /** 空串 = 不修改 Claude 默认配置。 */
  defaultModel: string;
  modelsUrl: string;
  enabledModels: LlmModelConfig[];
  sortIndex: number;
}

export interface FetchedModel {
  id: string;
}

export interface LlmLaunchModel {
  id: string;
  effort: string;
  contextWindow: number;
}

export interface LlmLaunchTarget {
  providerId: string;
  providerName: string;
  isDefault: boolean;
  models: LlmLaunchModel[];
}

export function listLlmProviders(): Promise<LlmProviderView[]> {
  return invoke('list_llm_providers');
}

export function saveLlmProvider(input: LlmProviderInput): Promise<LlmProviderView> {
  return invoke('save_llm_provider', { input });
}

export function deleteLlmProvider(id: string): Promise<LlmProviderView[]> {
  return invoke('delete_llm_provider', { id });
}

export function setDefaultLlmProvider(id: string): Promise<LlmProviderView[]> {
  return invoke('set_default_llm_provider', { id });
}

/** 取消默认供应商：允许没有默认，右键菜单不再平铺任何模型。 */
export function clearDefaultLlmProvider(): Promise<LlmProviderView[]> {
  return invoke('clear_default_llm_provider');
}

/**
 * 一期无拖拽排序 UI（新建按序追加 sortIndex），本函数暂无调用方，仅保留桥接
 * 供后续迭代使用；覆盖率脚本按 invoke 字面量统计，故仍计入覆盖。
 */
export function updateLlmProviderOrder(ids: string[]): Promise<LlmProviderView[]> {
  return invoke('update_llm_provider_order', { ids });
}

export function fetchLlmProviderModels(
  baseUrl: string,
  apiKey: string,
  modelsUrl: string,
  providerId?: string,
): Promise<FetchedModel[]> {
  return invoke('fetch_llm_provider_models', { baseUrl, apiKey, modelsUrl, providerId });
}

export function listClaudeLaunchTargets(): Promise<LlmLaunchTarget[]> {
  return invoke('list_claude_launch_targets');
}

// ---------------------------------------------------------------------------
// Claude 默认配置文件
// ---------------------------------------------------------------------------

export interface ClaudeSettingsView {
  path: string;
  exists: boolean;
  content: Record<string, unknown>;
}

export interface ClaudeSettingsWriteResult {
  path: string;
  backupId: string;
}

export interface ClaudeSettingsBackup {
  id: string;
  createdAt: string;
  size: number;
}

export function readClaudeSettings(): Promise<ClaudeSettingsView> {
  return invoke('read_claude_settings');
}

export function writeClaudeSettings(content: Record<string, unknown>): Promise<ClaudeSettingsWriteResult> {
  return invoke('write_claude_settings', { content });
}

export function listClaudeSettingsBackups(): Promise<ClaudeSettingsBackup[]> {
  return invoke('list_claude_settings_backups');
}

export function restoreClaudeSettingsBackup(id: string): Promise<ClaudeSettingsWriteResult> {
  return invoke('restore_claude_settings_backup', { id });
}

// ---------------------------------------------------------------------------
// 引用标记
// ---------------------------------------------------------------------------

export const CLAUDE_REF_PREFIX = '__TB_CLAUDE_REF__:';

/** 组装引用标记开头的启动命令：`[引用] [preset.params?]` */
export function buildClaudeRefCommand(providerId: string, modelId: string, presetParams?: string): string {
  const ref = `${CLAUDE_REF_PREFIX}${providerId}:${modelId}`;
  const params = (presetParams ?? '').trim();
  return params ? `${ref} ${params}` : ref;
}
