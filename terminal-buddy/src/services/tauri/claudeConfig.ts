import { invoke } from '@tauri-apps/api/core';

export interface ClaudeProjectInfo {
  dir: string;
  label: string;
  hasMemory: boolean;
  hasClaudeMd: boolean;
  hasDotClaude: boolean;
}

export interface ClaudeMemoryFile {
  name: string;
  memoryType: string | null;
  description: string | null;
  links: string[];
  size: number;
}

export function listClaudeProjects(): Promise<ClaudeProjectInfo[]> {
  return invoke('list_claude_projects');
}

export function listClaudeMemoryFiles(projectDir: string): Promise<ClaudeMemoryFile[]> {
  return invoke('list_claude_memory_files', { projectDir });
}

export function readClaudeMemoryFile(projectDir: string, name: string): Promise<string> {
  return invoke('read_claude_memory_file', { projectDir, name });
}

export function writeClaudeMemoryFile(projectDir: string, name: string, content: string): Promise<void> {
  return invoke('write_claude_memory_file', { projectDir, name, content });
}

export function createClaudeMemoryFile(
  projectDir: string,
  name: string,
  memoryType: string,
  description: string,
): Promise<string> {
  return invoke('create_claude_memory_file', { projectDir, name, memoryType, description });
}

export function deleteClaudeMemoryFile(projectDir: string, name: string): Promise<void> {
  return invoke('delete_claude_memory_file', { projectDir, name });
}

export function readClaudeMd(kind: 'global' | 'project', projectDir: string): Promise<string | null> {
  return invoke('read_claude_md', { kind, projectDir });
}

export function writeClaudeMd(kind: 'global' | 'project', projectDir: string, content: string): Promise<void> {
  return invoke('write_claude_md', { kind, projectDir, content });
}
