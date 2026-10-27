import { invoke } from '@tauri-apps/api/core';
import type { FetchedModel } from './claudeEnhance';

/** Pi Thinking 档位（schema ThinkingLevelMap 的键全集）。 */
export const PI_THINKING_LEVELS = [
  'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
] as const;
export type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number];

/** Provider 级 `api` 可选值（Pi 1.4.0 内置实现全集）。 */
export const PI_API_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'openai-completions', label: 'OpenAI Chat Completions' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'openai-codex-responses', label: 'OpenAI Codex Responses' },
  { value: 'anthropic-messages', label: 'Anthropic Messages' },
  { value: 'google-generative-ai', label: 'Google Generative AI' },
  { value: 'azure-openai-responses', label: 'Azure OpenAI Responses' },
  { value: 'mistral-conversations', label: 'Mistral Conversations' },
  { value: 'bedrock-converse-stream', label: 'Bedrock Converse' },
];

/** `compat.thinkingFormat` 可选值（`auto` = 省略，由 Pi 按 URL 自动检测）。 */
export const PI_THINKING_FORMAT_OPTIONS = [
  'auto', 'openai', 'openrouter', 'deepseek', 'together', 'baseten',
  'zai', 'qwen', 'chat-template', 'qwen-chat-template', 'string-thinking', 'ant-ling',
] as const;

/** 密钥形态：明文 / 环境变量引用 / 取密钥命令。 */
export const PI_KEY_MODE_OPTIONS = [
  ['literal', '直接填写密钥'],
  ['env', '环境变量（如 $MY_API_KEY）'],
  ['command', '命令输出（如 !cat ~/.secret）'],
] as const;
export type PiKeyMode = 'literal' | 'env' | 'command';

export interface PiThinkingLevelMap {
  levels: Record<string, string | null>;
}

export interface PiCompatConfig {
  forceAdaptiveThinking?: boolean | null;
  thinkingFormat?: string | null;
  extra: Record<string, unknown>;
}

export interface PiModelConfig {
  id: string;
  name: string;
  reasoning: boolean;
  /** 默认思考级别（null = 不指定，启动时不传 --thinking）。仅 TerminalBuddy 启动用。 */
  defaultThinking?: string | null;
  thinkingLevelMap: PiThinkingLevelMap;
  imageInput: boolean;
  contextWindow: number;
  maxTokens: number;
  compat: PiCompatConfig;
}

export interface PiProviderView {
  id: string;
  name: string;
  piProviderId: string;
  baseUrl: string;
  keySet: boolean;
  /** literal 模式为末 4 位；env/command 模式为原文（非敏感）。 */
  keyTail: string;
  keyMode: PiKeyMode;
  api: string;
  authHeader: boolean;
  headers: Record<string, string>;
  model: string;
  models: PiModelConfig[];
  availableModels: string[];
  compat: PiCompatConfig;
}

export interface PiProviderInput {
  id?: string;
  name: string;
  piProviderId: string;
  baseUrl: string;
  /** 留空沿用已保存的密钥（keyMode 必须与旧值一致）。 */
  apiKey?: string;
  keyMode: PiKeyMode;
  api: string;
  authHeader: boolean;
  headers: Record<string, string>;
  model: string;
  models: PiModelConfig[];
  availableModels: string[];
  compat: PiCompatConfig;
}

export interface PiProviderState {
  providers: PiProviderView[];
  /** TerminalBuddy 侧的默认供应商卡片 id（右键菜单平铺其模型）。 */
  activeProviderId: string | null;
  agentDir: string;
  modelsPath: string;
  configError: string | null;
  /** models.json 中非本应用管理的 provider 键名（可导入，需逐条确认）。 */
  externalProviderIds: string[];
}

export function emptyPiCompat(): PiCompatConfig {
  return { forceAdaptiveThinking: null, thinkingFormat: null, extra: {} };
}

export function emptyPiModel(id = ''): PiModelConfig {
  return {
    id, name: '', reasoning: false, defaultThinking: null, thinkingLevelMap: { levels: {} },
    imageInput: true, contextWindow: 0, maxTokens: 0, compat: emptyPiCompat(),
  };
}

export function getPiProviderState(): Promise<PiProviderState> {
  return invoke('get_pi_provider_state');
}

export function savePiProvider(input: PiProviderInput, activate = false): Promise<PiProviderState> {
  return invoke('save_pi_provider', { input, activate });
}

export function activatePiProvider(id: string): Promise<PiProviderState> {
  return invoke('activate_pi_provider', { id });
}

export function clearDefaultPiProvider(): Promise<PiProviderState> {
  return invoke('clear_default_pi_provider');
}

export function deletePiProvider(id: string): Promise<PiProviderState> {
  return invoke('delete_pi_provider', { id });
}

export function importPiProvider(piProviderId: string): Promise<PiProviderState> {
  return invoke('import_pi_provider', { piProviderId });
}

export function fetchPiProviderModels(baseUrl: string, apiKey: string, providerId?: string): Promise<FetchedModel[]> {
  return invoke('fetch_pi_provider_models', { baseUrl, apiKey, providerId });
}
