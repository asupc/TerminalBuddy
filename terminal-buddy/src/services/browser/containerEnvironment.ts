import { request } from './connection';

export type ContainerCli = 'claude' | 'codex' | 'antigravity';

export interface ContainerCliStatus {
  status: 'installed' | 'notInstalled' | 'installing' | 'updating' | 'failed';
  version: string | null;
  message: string | null;
  update: {
    latestVersion: string | null;
    state: 'available' | 'upToDate' | 'ahead' | 'unknown' | 'failed';
    message: string | null;
  } | null;
  updatedVersion: string | null;
}

export type ContainerEnvironment = Record<ContainerCli, ContainerCliStatus>;

export const getContainerEnvironment = () =>
  request<ContainerEnvironment>('/api/container/environment');

export const getContainerCli = (tool: ContainerCli, checkUpdates = false) =>
  request<ContainerCliStatus>(`/api/container/environment/${tool}${checkUpdates ? '?checkUpdates=true' : ''}`);

export const installContainerCli = (tool: ContainerCli) =>
  request<ContainerCliStatus>(`/api/container/environment/${tool}/install`, { method: 'POST' });

export const updateContainerCli = (tool: ContainerCli) =>
  request<ContainerCliStatus>(`/api/container/environment/${tool}/update`, { method: 'POST' });
