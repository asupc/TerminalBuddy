import { memo, useEffect, useMemo, useState } from 'react';
import type { AiAgent } from '../../services/tauri';

/**
 * 底部子代理 chip 带（清单卡下方、排队消息之上）。
 *
 * 只显示顶层代理（depth == 1）与仍在保留窗口内的已结束代理；运行中 chip 自带秒表，
 * 每秒只重渲染该 chip 内的文本（同 ElapsedBadge 的既有约束，审查 V-16）。
 * 规格见 docs/原生会话任务清单与子代理面板实施计划.md 第 6.2 节。
 */

/** 最多平铺的 chip 数，其余收为 `+N`。 */
const MAX_VISIBLE = 4;
/** 已结束 chip 的展示保留时长：数据仍随会话保留，只是从界面上淘汰。 */
const LINGER_MS = 10 * 60 * 1000;
/** 淘汰检查的轮询间隔。 */
const SWEEP_MS = 30 * 1000;

type ChipState = 'running' | 'completed' | 'failed' | 'stopped';

function chipState(agent: AiAgent): ChipState {
  if (agent.status === 'running' || agent.status === 'paused' || agent.status === 'pending') return 'running';
  if (agent.status === 'completed') return 'completed';
  if (agent.status === 'failed') return 'failed';
  return 'stopped';
}

/** 时长文案：`42s` / `1m12s`，与设计稿一致。 */
export function durationText(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m${seconds}s` : `${total}s`;
}

/** 运行中 chip 的秒表：clock 状态只住在这个子组件里。 */
const ChipClock = memo(function ChipClock({ since }: { since: number }) {
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <>{durationText(clock - since)}</>;
});

interface Props {
  agents: AiAgent[];
  /** 当前选中的子代理（按 subagentKey 关联），用于 aria-pressed。 */
  selectedKey: string | null;
  onSelect: (agent: AiAgent) => void;
  /** 会话切换时重置「展开全部」。 */
  sessionId: string;
}

export const AgentChips = memo(function AgentChips({ agents, selectedKey, onSelect, sessionId }: Props) {
  const [expanded, setExpanded] = useState(false);
  // 淘汰已结束超过保留时长的 chip：只是显示层过滤。
  const [sweep, setSweep] = useState(() => Date.now());

  useEffect(() => { setExpanded(false); }, [sessionId]);

  // 已结束 chip 到保留时限后由这里淘汰；没有已结束条目时不必轮询。
  const hasFinished = agents.some(agent => chipState(agent) !== 'running');
  useEffect(() => {
    if (!hasFinished) return;
    setSweep(Date.now());
    const timer = window.setInterval(() => setSweep(Date.now()), SWEEP_MS);
    return () => window.clearInterval(timer);
  }, [hasFinished]);

  const visible = useMemo(() => {
    // 后台 Bash 命令（taskType=local_bash）与子代理共用 task_* 事件，但不是子代理：
    // 没有可展示的子代理消息，点开只会是空抽屉，因此不进 chip 带。
    const alive = agents.filter(agent => agent.depth === 1 && agent.taskType !== 'local_bash' && agent.taskType !== 'background_shell').filter(agent => {
      if (chipState(agent) === 'running') return true;
      return sweep - (agent.endedAt ?? agent.startedAt) < LINGER_MS;
    });
    // 运行中按开始时间升序在前，已结束按结束时间降序在后。
    const running = alive.filter(agent => chipState(agent) === 'running')
      .sort((a, b) => a.startedAt - b.startedAt);
    const finished = alive.filter(agent => chipState(agent) !== 'running')
      .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));
    return [...running, ...finished];
  }, [agents, sweep]);

  if (visible.length === 0) return null;

  const shown = expanded ? visible : visible.slice(0, MAX_VISIBLE);
  const hidden = visible.length - shown.length;

  return (
    <div className="agent-chips">
      {shown.map(agent => {
        const state = chipState(agent);
        const duration = state === 'running'
          ? null
          : durationText(agent.durationMs ?? ((agent.endedAt ?? agent.startedAt) - agent.startedAt));
        return (
          <button
            key={agent.taskId}
            type="button"
            className={`agent-chip ${state}`}
            aria-pressed={selectedKey != null && agent.toolUseId === selectedKey}
            aria-label={`${agent.name}${agent.model ? `，模型 ${agent.model}` : ''}，${state === 'running' ? '执行中' : state === 'completed' ? '已完成' : state === 'failed' ? '失败' : '已停止'}，${state === 'running' ? '实时计时' : duration}`}
            title={agent.description ?? agent.summary ?? agent.name}
            onClick={() => onSelect(agent)}
            data-task-id={agent.taskId}
          >
            <span className="agent-chip-dot" aria-hidden="true" />
            <span className="agent-chip-name">{agent.name}</span>
            {agent.model && <span className="agent-chip-model" title={agent.model}>{agent.model}</span>}
            <span className="agent-chip-meta">
              {state === 'running' ? <>执行中 <ChipClock since={agent.startedAt} /></> : null}
              {state === 'completed' ? <>已完成 {duration}</> : null}
              {state === 'failed' ? '失败' : null}
              {state === 'stopped' ? '已停止' : null}
            </span>
          </button>
        );
      })}
      {hidden > 0 && (
        <button type="button" className="agent-chip-more" onClick={() => setExpanded(true)}>
          +{hidden}
        </button>
      )}
      {expanded && visible.length > MAX_VISIBLE && (
        <button type="button" className="agent-chip-more" onClick={() => setExpanded(false)}>收起</button>
      )}
    </div>
  );
});
