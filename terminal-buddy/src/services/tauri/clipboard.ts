import { invoke } from '@tauri-apps/api/core';

// Clipboard Commands
export async function readClipboardFilePaths(): Promise<string[]> {
  return invoke('read_clipboard_file_paths');
}

export async function readClipboardImageAsFile(): Promise<string> {
  return invoke('read_clipboard_image_as_file');
}
