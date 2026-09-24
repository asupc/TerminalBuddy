import { invoke } from '@tauri-apps/api/core';

// 默认终端（实验）：Windows Delegation/Handoff 机制的注册与状态查询。

export interface DefaultTerminalStatus {
  /** 当前 DelegationTerminal 是否指向 TerminalBuddy（以注册表为准） */
  enabled: boolean;
  /** notConfigured | ours | windowsTerminal | conhostForced | other */
  state: string;
  /** 中文一句话状态描述 */
  description: string;
  /** 本进程 COM 类对象是否已注册成功 */
  comRegistered: boolean;
  /** LocalServer32 是否已注册（进程未启动时 COM 据此拉起） */
  localServerRegistered: boolean;
}

export async function getDefaultTerminalStatus(): Promise<DefaultTerminalStatus> {
  return invoke('get_default_terminal_status');
}

export async function setDefaultTerminalEnabled(enabled: boolean): Promise<DefaultTerminalStatus> {
  return invoke('set_default_terminal_enabled', { enabled });
}
