import { invoke } from '@tauri-apps/api/core';

export type ClaudeAssetKind = 'skills' | 'agents' | 'commands';
export type AssetScope = 'user' | 'project';

export interface ClaudeAssetDeployment {
  scope: AssetScope;
  projectDir: string | null;
  drifted: boolean;
}

export interface ClaudeAssetEntry {
  kind: ClaudeAssetKind;
  kindLabel: string;
  name: string;
  description: string | null;
  deployments: ClaudeAssetDeployment[];
}

export interface ImportableClaudeAsset {
  kind: ClaudeAssetKind;
  kindLabel: string;
  name: string;
  description: string | null;
}

export function listClaudeAssets(projectDir?: string): Promise<ClaudeAssetEntry[]> {
  return invoke('list_claude_assets', { projectDir: projectDir ?? null });
}

export function deployClaudeAsset(
  kind: ClaudeAssetKind,
  name: string,
  scope: AssetScope,
  projectDir?: string,
): Promise<void> {
  return invoke('deploy_claude_asset', { kind, name, scope, projectDir: projectDir ?? null });
}

export function undeployClaudeAsset(
  kind: ClaudeAssetKind,
  name: string,
  scope: AssetScope,
  projectDir?: string,
): Promise<void> {
  return invoke('undeploy_claude_asset', { kind, name, scope, projectDir: projectDir ?? null });
}

export function syncClaudeAsset(
  kind: ClaudeAssetKind,
  name: string,
  direction: 'overwrite' | 'pull_back',
  scope: AssetScope,
  projectDir?: string,
): Promise<void> {
  return invoke('sync_claude_asset', { kind, name, direction, scope, projectDir: projectDir ?? null });
}

export function importClaudeAsset(
  kind: ClaudeAssetKind,
  scope: AssetScope,
  projectDir: string | undefined,
  name: string,
): Promise<void> {
  return invoke('import_claude_asset', { kind, scope, projectDir: projectDir ?? null, name });
}

export function listImportableClaudeAssets(
  scope: AssetScope,
  projectDir?: string,
): Promise<ImportableClaudeAsset[]> {
  return invoke('list_importable_claude_assets', { scope, projectDir: projectDir ?? null });
}

export function deleteClaudeAsset(kind: ClaudeAssetKind, name: string): Promise<void> {
  return invoke('delete_claude_asset', { kind, name });
}

export function createClaudeAsset(kind: ClaudeAssetKind, name: string, description: string): Promise<string> {
  return invoke('create_claude_asset', { kind, name, description });
}

export function readClaudeAsset(kind: ClaudeAssetKind, name: string): Promise<string> {
  return invoke('read_claude_asset', { kind, name });
}

export function writeClaudeAsset(kind: ClaudeAssetKind, name: string, content: string): Promise<void> {
  return invoke('write_claude_asset', { kind, name, content });
}
