import { invoke } from '@tauri-apps/api/core';

// Template Commands
export async function getCommandTemplates(): Promise<string> {
  return invoke('get_command_templates');
}

export async function initCommandTemplates(defaultContent: string): Promise<boolean> {
  return invoke('init_command_templates', { defaultContent });
}
