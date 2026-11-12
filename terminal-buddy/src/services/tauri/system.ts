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

/** 运行 TerminalBuddy 后端的那台机器的 CPU / 内存占用。 */
export interface SystemResources {
  /** 全局 CPU 使用率（0–100）。 */
  cpuUsage: number;
  cpuCount: number;
  /** 已用内存（字节）。 */
  memoryUsed: number;
  /** 物理内存总量（字节）。 */
  memoryTotal: number;
  /** 内存使用率（0–100）。 */
  memoryUsage: number;
}

/** 浏览器端经 `/api/desktop/invoke` 转发，读到的是服务端宿主机数据。 */
export async function getSystemResources(): Promise<SystemResources> {
  return invoke<SystemResources>('get_system_resources');
}
