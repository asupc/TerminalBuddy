import { invoke } from './../remoteWorkspace/core';
import type { AssetScope } from './claudeAssets';

export interface ClaudeMcpServerConfig {
  name: string;
  /** "stdio" | "sse" | "http" */
  transport: string;
  command: string | null;
  args: string[];
  url: string | null;
  /** 原始配置对象（编辑回写用） */
  raw: Record<string, unknown>;
}

export interface ClaudeMcpProbeStatus {
  name: string;
  /** "connected" | "pending" | "failed" | "unknown" */
  status: string;
  detail: string;
}

export function listClaudeMcpServers(scope: AssetScope, projectDir?: string): Promise<ClaudeMcpServerConfig[]> {
  return invoke('list_claude_mcp_servers', { scope, projectDir: projectDir ?? null });
}

export function saveClaudeMcpServer(
  scope: AssetScope,
  name: string,
  config: Record<string, unknown>,
  projectDir?: string,
): Promise<void> {
  return invoke('save_claude_mcp_server', { scope, projectDir: projectDir ?? null, name, config });
}

export function deleteClaudeMcpServer(scope: AssetScope, name: string, projectDir?: string): Promise<void> {
  return invoke('delete_claude_mcp_server', { scope, projectDir: projectDir ?? null, name });
}

export function getClaudeMcpConfigPath(scope: AssetScope, projectDir?: string): Promise<string> {
  return invoke('get_claude_mcp_config_path', { scope, projectDir: projectDir ?? null });
}

export function probeClaudeMcp(timeoutSecs?: number): Promise<ClaudeMcpProbeStatus[]> {
  return invoke('probe_claude_mcp', { timeoutSecs: timeoutSecs ?? null });
}
