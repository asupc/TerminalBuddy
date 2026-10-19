import type { TerminalTaskSummary } from '../../stores/taskSummaryStore';

interface SessionTaskLabelProps {
  task: TerminalTaskSummary;
  connectionName: string;
  fallbackModel?: string;
  tag?: string;
  tagColor?: string | null;
  color?: string | null;
}

/** 第一行提供会话信息，第二行只显示任务摘要。 */
export function SessionTaskLabel({ task, connectionName, fallbackModel, tag, tagColor, color }: SessionTaskLabelProps) {
  const provider = task.provider === 'codex' ? 'Codex' : 'Claude';
  const model = task.model || fallbackModel || '模型待识别';
  return (
    <span className="tab-nav-task-label" style={color ? { color } : undefined}>
      <span className="tab-nav-task-meta">
        <span className="tab-nav-task-provider" data-provider={task.provider}>{provider}</span>
        <span className="tab-nav-task-model" data-pending={!task.model && !fallbackModel || undefined} title={model}>{model}</span>
        <span className="tab-nav-task-connection" title={`启动连接：${connectionName}`}>{connectionName}</span>
        {tag && <span className="tab-nav-tag-chip" title="启动参数预设" style={tagColor ? { backgroundColor: tagColor } : undefined}>{tag}</span>}
      </span>
      <span className="tab-nav-task-summary" title={task.summary}>{task.summary}</span>
    </span>
  );
}
