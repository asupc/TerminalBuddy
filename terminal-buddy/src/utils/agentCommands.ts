import { DEFAULT_CLAUDE_COMMAND } from './claudeLaunch';
import { DEFAULT_CODEX_COMMAND } from './codexLaunch';
import { DEFAULT_PI_COMMAND } from './piLaunch';
import { useAppStore } from '../stores/appStore';

/**
 * Agent 管理中配置的基础启动命令（如 claude --dangerously-skip-permissions）。
 * 未配置或空白时回退内置默认命令。
 */
export function effectiveClaudeCommand(configured?: string | null): string {
  return configured?.trim() || DEFAULT_CLAUDE_COMMAND;
}

export function effectiveCodexCommand(configured?: string | null): string {
  return configured?.trim() || DEFAULT_CODEX_COMMAND;
}

export function effectivePiCommand(configured?: string | null): string {
  return configured?.trim() || DEFAULT_PI_COMMAND;
}

/** 从 store 读取当前生效的 Agent 基础命令（App 初始化时由后端设置同步，浏览器模式经 /api/runtime）。 */
export function currentClaudeCommand(): string {
  return effectiveClaudeCommand(useAppStore.getState().agentCommands.claude);
}

export function currentCodexCommand(): string {
  return effectiveCodexCommand(useAppStore.getState().agentCommands.codex);
}

export function currentPiCommand(): string {
  return effectivePiCommand(useAppStore.getState().agentCommands.pi);
}
