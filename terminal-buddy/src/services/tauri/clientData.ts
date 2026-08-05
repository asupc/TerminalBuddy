import { invoke } from '@tauri-apps/api/core';

// Client Data Commands
export async function readClientData(key: string): Promise<string | null> {
  return invoke<string | null>('read_client_data', { key });
}

export async function writeClientData(key: string, content: string): Promise<void> {
  return invoke('write_client_data', { key, content });
}

// Full Data Import/Export
export async function exportAllData(filePath: string): Promise<void> {
  return invoke('export_all_data', { filePath });
}

export async function importAllData(filePath: string): Promise<void> {
  return invoke('import_all_data', { filePath });
}
