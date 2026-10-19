import type { TerminalTaskSummary } from '../types';

interface SessionTaskLabelProps {
  task: TerminalTaskSummary;
  projectName: string;
  fallbackModel?: string;
  tag?: string;
  tagColor?: string | null;
  color?: string | null;
}

/** 第一行提供会话信息，第二行只显示任务摘要。 */
export function SessionTaskLabel({ task, projectName, fallbackModel, tag, tagColor, color }: SessionTaskLabelProps) {
  const provider = task.provider === 'codex' ? 'Codex' : 'Claude';
  const model = task.model || fallbackModel || '模型待识别';
  return (
    <span className="tab-nav-task-label" style={color ? { color } : undefined}>
      <span className="tab-nav-task-meta">
        <span className="tab-nav-task-provider">{provider}</span>
        <span className="tab-nav-task-model" title={model}>{model}</span>
        <span className="tab-nav-task-project" title={projectName}>{projectName}</span>
        {tag && <span className="tab-nav-tag-chip" title="启动参数预设" style={tagColor ? { backgroundColor: tagColor } : undefined}>{tag}</span>}
      </span>
      <span className="tab-nav-task-summary" title={task.summary}>{task.summary}</span>
    </span>
  );
}
