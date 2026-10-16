import { request } from './connection';

export type ContainerCli = 'claude' | 'codex';

export interface ContainerCliStatus {
  status: 'installed' | 'notInstalled' | 'installing' | 'failed';
  version: string | null;
  message: string | null;
}

export type ContainerEnvironment = Record<ContainerCli, ContainerCliStatus>;

export const getContainerEnvironment = () =>
  request<ContainerEnvironment>('/api/container/environment');

export const installContainerClaude = () =>
  request<ContainerEnvironment>('/api/container/environment/claude/install', { method: 'POST' });

export const installContainerCodex = () =>
  request<ContainerEnvironment>('/api/container/environment/codex/install', { method: 'POST' });
