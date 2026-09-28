import { FC, useMemo, useState } from 'react';
import { useAppStore, type TerminalActivityState } from '../../stores/appStore';
import {
  getIndicatorLight,
  getIndicatorColor,
  getIndicatorTitle,
  type IndicatorLight,
} from '../../utils/claudeIndicator';
import { focusTerminalById } from '../claude-history/resumeClaudeSession';
import { MemorySegment } from './segments/MemorySegment';
import { ClaudeMdSegment } from './segments/ClaudeMdSegment';
import { AssetsSegment } from './segments/AssetsSegment';
import { McpSegment } from './segments/McpSegment';
import './ClaudePanel.css';

const PHASE_LABEL: Record<string, string> = {
  running: '执行中',
  attention: '等待确认',
  completed: '任务完成',
  failed: '错误停止',
  idle: '空闲',
};

const SEGMENTS = [
  { id: 'overview', label: '总览' },
  { id: 'memory', label: 'Memory' },
  { id: 'claudemd', label: 'CLAUDE.md' },
  { id: 'assets', label: '技能' },
  { id: 'mcp', label: 'MCP' },
] as const;

type SegmentId = typeof SEGMENTS[number]['id'];

function formatTime(millis: number): string {
  return new Date(millis).toLocaleString('zh-CN', { hour12: false });
}

interface OverviewCard {
  terminalId: string;
  name: string;
  activity: TerminalActivityState | undefined;
  light: IndicatorLight;
  claudeSessionId?: string;
}

/** Claude 面板：会话总览 / Memory / CLAUDE.md / 技能资产 / MCP 五个分段（切换不卸载，编辑状态保留）。 */
export const ClaudePanel: FC = () => {
  const [segment, setSegment] = useState<SegmentId>('overview');
  // 分段首次切到才挂载、之后常驻：既不在启动时把四个分段的数据请求全打一遍，
  // 又保留「切换不卸载、编辑状态不丢」。
  const [visited, setVisited] = useState<SegmentId[]>(['overview']);
  const pickSegment = (id: SegmentId) => {
    setSegment(id);
    setVisited(prev => (prev.includes(id) ? prev : [...prev, id]));
  };
  const sessions = useAppStore(s => s.sessions);
  const terminalActivities = useAppStore(s => s.terminalActivities);
  const claudeSessionIds = useAppStore(s => s.claudeSessionIds);
  const sessionDirectories = useAppStore(s => s.sessionDirectories);
  const clearClaudeFailure = useAppStore(s => s.clearClaudeFailure);
  const openClaudeReplayTab = useAppStore(s => s.openClaudeReplayTab);

  const cards = useMemo<OverviewCard[]>(() => {
    const result: OverviewCard[] = [];
    for (const session of sessions) {
      if (session.sessionType === 'editor' || session.starting) continue;
      const activity = terminalActivities[session.id];
      const claudeSessionId = claudeSessionIds[session.id];
      if (activity?.runtimeKind !== 'claude' && !claudeSessionId) continue;
      result.push({
        terminalId: session.id,
        name: session.profileName,
        activity,
        light: getIndicatorLight(activity),
        claudeSessionId,
      });
    }
    // 需要处理的排前：等待确认 / 错误停止 > 执行中 > 其它（按更新时间倒序）
    const priority = (card: OverviewCard) =>
      card.light === 'attention' ? 0 : card.light === 'failed' ? 1 : card.light === 'running' ? 2 : 3;
    return result.sort((a, b) =>
      priority(a) - priority(b) || ((b.activity?.updatedAt ?? 0) - (a.activity?.updatedAt ?? 0)));
  }, [sessions, terminalActivities, claudeSessionIds]);

  return (
    <div className="claude-panel">
      <div className="panel-titlebar">
        <span className="panel-title">{SEGMENTS.find(item => item.id === segment)?.label}</span>
        {segment === 'overview' && <span className="panel-title-count">{cards.length}</span>}
      </div>
      <div className="claude-panel-segtabs">
        {SEGMENTS.map(item => (
          <button
            key={item.id}
            type="button"
            className={segment === item.id ? 'on' : ''}
            onClick={() => pickSegment(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className={`claude-segment-host${segment === 'overview' ? '' : ' off'}`}>
        <div className="claude-panel-list">
          {cards.length === 0 && (
            <div className="claude-panel-empty">
              暂无 Claude 活动
              <small>hook 事件到达后，这里会显示各终端的执行状态</small>
            </div>
          )}
          {cards.map(card => (
            <div key={card.terminalId} className={`claude-panel-card light-${card.light}`}>
              <div className="claude-panel-card-head">
                <span
                  className={`claude-panel-led led-${card.light}`}
                  style={{ background: getIndicatorColor(card.light) }}
                  title={getIndicatorTitle(card.light) || undefined}
                  onClick={() => {
                    if (card.light === 'failed') clearClaudeFailure(card.terminalId);
                    else if (card.light === 'attention') focusTerminalById(card.terminalId);
                  }}
                />
                <span className="claude-panel-name">{card.name}</span>
                <span className="claude-panel-phase">{PHASE_LABEL[card.activity?.phase ?? 'idle']}</span>
              </div>
              {card.activity?.taskTitle && (
                <div className="claude-panel-task">{card.activity.taskTitle}</div>
              )}
              {card.activity?.summary && (
                <div className="claude-panel-summary">{card.activity.summary}</div>
              )}
              {card.activity && (
                <div className="claude-panel-time">{formatTime(card.activity.updatedAt)}</div>
              )}
              <div className="claude-panel-actions">
                <button type="button" className="claude-panel-btn" onClick={() => focusTerminalById(card.terminalId)}>
                  跳转
                </button>
                {card.claudeSessionId && (
                  <button
                    type="button"
                    className="claude-panel-btn"
                    onClick={() => openClaudeReplayTab({
                      sessionId: card.claudeSessionId!,
                      title: card.name,
                      projectDir: sessionDirectories[card.terminalId],
                    })}
                  >
                    回放
                  </button>
                )}
                {card.light === 'failed' && (
                  <button type="button" className="claude-panel-btn" onClick={() => clearClaudeFailure(card.terminalId)}>
                    清除
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className={`claude-segment-host${segment === 'memory' ? '' : ' off'}`}>{visited.includes('memory') && <MemorySegment />}</div>
      <div className={`claude-segment-host${segment === 'claudemd' ? '' : ' off'}`}>{visited.includes('claudemd') && <ClaudeMdSegment />}</div>
      <div className={`claude-segment-host${segment === 'assets' ? '' : ' off'}`}>{visited.includes('assets') && <AssetsSegment />}</div>
      <div className={`claude-segment-host${segment === 'mcp' ? '' : ' off'}`}>{visited.includes('mcp') && <McpSegment />}</div>
    </div>
  );
};
