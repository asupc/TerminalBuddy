import { request } from './connection';

export interface ContainerEnvironment {
  claude: {
    status: 'installed' | 'notInstalled' | 'installing' | 'failed';
    version: string | null;
    message: string | null;
  };
}

export const getContainerEnvironment = () =>
  request<ContainerEnvironment>('/api/container/environment');

export const installContainerClaude = () =>
  request<ContainerEnvironment>('/api/container/environment/claude/install', { method: 'POST' });
