import type { TerminalTaskSummary } from '../../stores/taskSummaryStore';

interface SessionTaskLabelProps {
  task?: TerminalTaskSummary;
  fallbackName: string;
  fallbackProvider: TerminalTaskSummary['provider'];
  fallbackModel?: string;
  color?: string | null;
}

/** 固定两行布局：第一行显示摘要或项目名称，第二行仅显示工具与模型标签。 */
export function SessionTaskLabel({ task, fallbackName, fallbackProvider, fallbackModel, color }: SessionTaskLabelProps) {
  const provider = task?.provider ?? fallbackProvider;
  const providerName = provider === 'codex' ? 'Codex' : 'Claude';
  const model = task?.model?.trim() || fallbackModel?.trim() || '模型待识别';
  const summary = task?.summary?.trim() || fallbackName;
  return (
    <span className="tab-nav-task-label" style={color ? { color } : undefined}>
      <span className="tab-nav-task-summary" title={summary}>{summary}</span>
      <span className="tab-nav-task-meta">
        <span className="tab-nav-task-provider" data-provider={provider}>{providerName}</span>
        <span className="tab-nav-task-model" data-pending={!task?.model?.trim() && !fallbackModel?.trim() || undefined} title={model}>{model}</span>
      </span>
    </span>
  );
}
