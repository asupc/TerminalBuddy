import { invoke } from './../remoteWorkspace/core';

export type AgentCli = 'claude' | 'codex' | 'antigravity';

export interface AgentCliStatus {
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

export type AgentCliEnvironment = Record<AgentCli, AgentCliStatus>;

export interface AntigravityModel {
  id: string;
  name: string;
}

/** Agent 管理：与 Docker 网页版 REST 接口共用后端 agent_cli_service。 */
export const getAgentCliEnvironment = () => invoke<AgentCliEnvironment>('get_agent_cli_environment');

export const getAgentCliStatus = (tool: AgentCli, checkUpdates = false) =>
  invoke<AgentCliStatus>('get_agent_cli_status', { tool, checkUpdates });

export const installAgentCli = (tool: AgentCli) =>
  invoke<AgentCliStatus>('install_agent_cli', { tool });

export const updateAgentCli = (tool: AgentCli) =>
  invoke<AgentCliStatus>('update_agent_cli', { tool });

export const listAntigravityModels = (refresh = false) =>
  invoke<AntigravityModel[]>('list_antigravity_models', { refresh });
