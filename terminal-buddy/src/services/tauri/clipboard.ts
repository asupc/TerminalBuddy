import { invoke } from './../remoteWorkspace/core';

// Clipboard Commands
export async function readClipboardFilePaths(): Promise<string[]> {
  return invoke('read_clipboard_file_paths');
}

export async function readClipboardImageAsFile(): Promise<string> {
  return invoke('read_clipboard_image_as_file');
}

/** 剪贴板图片存入 dataPath/ClientData/claude-images（供 @path 引用，Claude 之后仍可读） */
export async function saveClipboardImageToClaudeCache(): Promise<string> {
  return invoke('save_clipboard_image_to_claude_cache');
}
