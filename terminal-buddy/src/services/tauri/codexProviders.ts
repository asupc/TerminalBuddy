import { invoke } from './../remoteWorkspace/core';
import type { FetchedModel } from './claudeEnhance';

export const CODEX_EFFORT_OPTIONS = [
  ['', '跟随模型默认'], ['none', '关闭 none'], ['minimal', '最低 minimal'],
  ['low', '低 low'], ['medium', '中 medium'], ['high', '高 high'],
  ['xhigh', '极高 xhigh'], ['max', '最高 MAX'], ['ultra', '超高 ultra'],
] as const;

export interface CodexProviderView {
  id: string;
  name: string;
  baseUrl: string;
  keySet: boolean;
  keyTail: string;
  model: string;
  models: string[];
  availableModels: string[];
  modelReasoningEfforts: Record<string, string>;
  contextWindow: number;
  autoCompactTokenLimit: number;
  disableResponseStorage: boolean;
}

export interface CodexProviderInput {
  id?: string;
  name: string;
  baseUrl: string;
  /** 留空沿用已保存的密钥。 */
  apiKey?: string;
  model: string;
  models: string[];
  availableModels: string[];
  modelReasoningEfforts: Record<string, string>;
  contextWindow: number;
  autoCompactTokenLimit: number;
  disableResponseStorage: boolean;
}

export interface CodexProviderState {
  providers: CodexProviderView[];
  activeProviderId: string | null;
  configDir: string;
  configError: string | null;
}

export function getCodexProviderState(): Promise<CodexProviderState> {
  return invoke('get_codex_provider_state');
}

export function saveCodexProvider(input: CodexProviderInput, activate: boolean): Promise<CodexProviderState> {
  return invoke('save_codex_provider', { input, activate });
}

export function activateCodexProvider(id: string): Promise<CodexProviderState> {
  return invoke('activate_codex_provider', { id });
}

export function clearDefaultCodexProvider(): Promise<CodexProviderState> {
  return invoke('clear_default_codex_provider');
}

export function deleteCodexProvider(id: string): Promise<CodexProviderState> {
  return invoke('delete_codex_provider', { id });
}

export function importCodexProvider(): Promise<CodexProviderState> {
  return invoke('import_codex_provider');
}

export function fetchCodexProviderModels(baseUrl: string, apiKey: string, providerId?: string): Promise<FetchedModel[]> {
  return invoke('fetch_codex_provider_models', { baseUrl, apiKey, providerId });
}
