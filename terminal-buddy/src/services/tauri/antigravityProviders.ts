import { invoke } from '@tauri-apps/api/core';
import type { AntigravityModel } from './agentCli';

export type AntigravityEffortLevel = '' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AntigravityModelEntry {
  id: string;
  name: string;
  effortLevel: AntigravityEffortLevel;
}

export interface AntigravityProviderConfig {
  defaultEffortLevel: AntigravityEffortLevel;
  availableModels: AntigravityModel[];
  enabledModels: AntigravityModelEntry[];
}

export function getAntigravityProviderConfig(): Promise<AntigravityProviderConfig> {
  return invoke('get_antigravity_provider_config');
}

export function saveAntigravityProviderConfig(
  config: AntigravityProviderConfig,
): Promise<AntigravityProviderConfig> {
  return invoke('save_antigravity_provider_config', { config });
}

export function fetchAntigravityProviderModels(): Promise<AntigravityProviderConfig> {
  return invoke('fetch_antigravity_provider_models');
}
