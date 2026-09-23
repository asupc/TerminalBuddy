import { invoke } from '@tauri-apps/api/core';

// System Commands
let _windowsBuildNumber: number | null | undefined = undefined;

export async function getWindowsBuildNumber(): Promise<number | null> {
  if (_windowsBuildNumber !== undefined) return _windowsBuildNumber;
  try {
    _windowsBuildNumber = await invoke<number>('get_windows_build_number');
  } catch {
    _windowsBuildNumber = null;
  }
  return _windowsBuildNumber;
}
