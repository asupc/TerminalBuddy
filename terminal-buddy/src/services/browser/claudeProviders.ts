import { isRemoteWorkspace } from '../remoteWorkspace/config';
import { remoteRequest } from '../remoteWorkspace/http';
import { request as localRequest } from './connection';

// 桌面远程工作区与浏览器共用同一组容器接口，但必须打到远程服务。
const request = <T>(path: string, init?: RequestInit): Promise<T> =>
  isRemoteWorkspace() ? remoteRequest<T>(path, init) : localRequest<T>(path, init);

export type ClaudeAuthType = 'ANTHROPIC_AUTH_TOKEN' | 'ANTHROPIC_API_KEY';
export interface ClaudeProviderInput {
  name: string;
  baseUrl: string;
  authType: ClaudeAuthType;
  apiKey: string | null;
  model: string;
  opusModel: string;
  sonnetModel: string;
  haikuModel: string;
  extraEnv: Record<string, string>;
}
export interface ClaudeProvider extends ClaudeProviderInput {
  id: string;
  hasApiKey: boolean;
  updatedAt: number;
}
export interface ClaudeProviderList {
  providers: ClaudeProvider[];
  activeProviderId: string | null;
  applied: boolean;
  canImport: boolean;
}
const path = '/api/container/claude/providers';
const json = (value: unknown, method: string): RequestInit => ({
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
});
export const getClaudeProviders = () => request<ClaudeProviderList>(path);
export const createClaudeProvider = (input: ClaudeProviderInput) => request<ClaudeProviderList>(path, json(input, 'POST'));
export const updateClaudeProvider = (id: string, input: ClaudeProviderInput) => request<ClaudeProviderList>(`${path}/${encodeURIComponent(id)}`, json(input, 'PUT'));
export const activateClaudeProvider = (id: string) => request<ClaudeProviderList>(`${path}/${encodeURIComponent(id)}/activate`, { method: 'POST' });
export const deleteClaudeProvider = (id: string) => request<ClaudeProviderList>(`${path}/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const importCurrentClaudeProvider = () => request<ClaudeProviderList>(`${path}/import-current`, { method: 'POST' });
export const deactivateClaudeProvider = () => request<ClaudeProviderList>(`${path}/deactivate`, { method: 'POST' });
