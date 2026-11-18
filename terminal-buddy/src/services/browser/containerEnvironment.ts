// 容器环境接口在浏览器里同源访问；桌面远程工作区则经由本机回环代理转发到远程服务。
import { isRemoteWorkspace } from '../remoteWorkspace/config';
import { remoteRequest } from '../remoteWorkspace/http';
import { request } from './connection';

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  return isRemoteWorkspace() ? remoteRequest<T>(path, init) : request<T>(path, init);
}

export type ContainerCli = 'claude' | 'codex';

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
  call<ContainerEnvironment>('/api/container/environment');

export const getContainerCli = (tool: ContainerCli, checkUpdates = false) =>
  call<ContainerCliStatus>(`/api/container/environment/${tool}${checkUpdates ? '?checkUpdates=true' : ''}`);

export const installContainerCli = (tool: ContainerCli) =>
  call<ContainerCliStatus>(`/api/container/environment/${tool}/install`, { method: 'POST' });

export const updateContainerCli = (tool: ContainerCli) =>
  call<ContainerCliStatus>(`/api/container/environment/${tool}/update`, { method: 'POST' });
