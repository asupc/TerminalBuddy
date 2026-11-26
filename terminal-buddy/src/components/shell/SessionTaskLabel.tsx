import type { TerminalTaskSummary } from '../../stores/taskSummaryStore';
import { AgentIcon } from '../agent-chat/AgentIcon';

interface SessionTaskLabelProps {
  task?: TerminalTaskSummary;
  fallbackName: string;
  fallbackProvider: TerminalTaskSummary['provider'];
  color?: string | null;
  /** 用户手动重命名过：第一行固定显示手动名称，不再被任务摘要覆盖。 */
  manualTitle?: boolean;
  showProviderIcon?: boolean;
}

/** 与原生会话标签一致的单行布局：Agent Logo 在前，摘要或会话名随后。 */
export function SessionTaskLabel({ task, fallbackName, fallbackProvider, color, manualTitle, showProviderIcon = true }: SessionTaskLabelProps) {
  const provider = task?.provider ?? fallbackProvider;
  const providerName = provider === 'codex'
    ? 'Codex'
    : provider === 'antigravity'
      ? 'Antigravity CLI'
      : 'Claude';
  const summary = (!manualTitle && task?.summary?.trim()) || fallbackName;
  return (
    <span className="tab-nav-task-label" style={color ? { color } : undefined}>
      {showProviderIcon && (
        <span className="tab-nav-task-provider" data-provider={provider} title={providerName}>
          <AgentIcon provider={provider} className="tab-nav-task-provider-logo" />
        </span>
      )}
      <span className="tab-nav-task-summary" title={summary}>{summary}</span>
    </span>
  );
}
