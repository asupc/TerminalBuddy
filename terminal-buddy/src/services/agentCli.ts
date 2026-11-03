/**
 * Agent 管理统一门面：桌面（Tauri）走 invoke，浏览器模式（Docker PC 网页版）
 * 走既有 REST 客户端；两端响应结构一致（camelCase CliStatus）。
 */
import { isBrowserClient } from './platform';
import {
  getContainerCli, getContainerEnvironment, installContainerCli, updateContainerCli,
  type ContainerCli, type ContainerCliStatus, type ContainerEnvironment,
} from './browser/containerEnvironment';
import {
  getAgentCliEnvironment as invokeGetEnvironment, getAgentCliStatus as invokeGetStatus,
  installAgentCli as invokeInstall, updateAgentCli as invokeUpdate,
  type AgentCli, type AgentCliEnvironment, type AgentCliStatus,
} from './tauri/agentCli';

export type { AgentCli, AgentCliEnvironment, AgentCliStatus };
export type { ContainerCli, ContainerCliStatus, ContainerEnvironment };

export function getAgentCliEnvironment(): Promise<AgentCliEnvironment> {
  return isBrowserClient() ? getContainerEnvironment() : invokeGetEnvironment();
}

export function getAgentCli(tool: AgentCli, checkUpdates = false): Promise<AgentCliStatus> {
  return isBrowserClient() ? getContainerCli(tool, checkUpdates) : invokeGetStatus(tool, checkUpdates);
}

export function installAgentCli(tool: AgentCli): Promise<AgentCliStatus> {
  return isBrowserClient() ? installContainerCli(tool) : invokeInstall(tool);
}

export function updateAgentCli(tool: AgentCli): Promise<AgentCliStatus> {
  return isBrowserClient() ? updateContainerCli(tool) : invokeUpdate(tool);
}
