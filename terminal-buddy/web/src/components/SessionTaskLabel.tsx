import type { TerminalTaskSummary } from '../types';

interface SessionTaskLabelProps {
  task: TerminalTaskSummary;
  fallbackModel?: string;
  color?: string | null;
}

/** 第一行显示任务摘要，第二行仅显示工具与模型标签。 */
export function SessionTaskLabel({ task, fallbackModel, color }: SessionTaskLabelProps) {
  const provider = task.provider === 'codex' ? 'Codex' : 'Claude';
  const model = task.model || fallbackModel || '模型待识别';
  return (
    <span className="tab-nav-task-label" style={color ? { color } : undefined}>
      <span className="tab-nav-task-summary" title={task.summary}>{task.summary}</span>
      <span className="tab-nav-task-meta">
        <span className="tab-nav-task-provider" data-provider={task.provider}>{provider}</span>
        <span className="tab-nav-task-model" data-pending={!task.model && !fallbackModel || undefined} title={model}>{model}</span>
      </span>
    </span>
  );
}
