// 终端 Agent 会话接力面板（§5.5）：列表 + 会话视图，外壳仿 HistoryPanel / ConfigNav。
// - 列表是完整数据源（terminal_agent_list 按调用端身份过滤，不从普通终端列表推导）；
// - 仅在面板激活时轮询列表；进入具体会话才建立镜像租约（AgentChatView 内管理）；
// - 默认风格下面板可见性由 store 的 agentsPanelVisible 控制（与 config/history 同款收零宽），
//   侧栏风格由 App 的 sidebarPanel === 'agents' 控制。
import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import {
  describeTerminalAgentError,
  listTerminalAgents,
  type TerminalAgentSession,
} from '../../services/terminalAgent';
import { useAppStore } from '../../stores/appStore';
import { getBackendAppSettings, saveConfigNavWidth, saveFileNavWidth } from '../../services/tauri';
import { useResizablePanel } from '../../hooks/useResizablePanel';
import { notifyTerminalPanelResize } from '../../utils/terminalResizeEvent';
import { agentSessionTitle, formatRelativeTime, phaseClass, phaseLabel, providerLabel } from './agentViewHelpers';
import { AgentChatView } from './AgentChatView';
import './TerminalAgentPanel.css';

/** 面板激活时的列表轮询周期（秒级进度刷新足够，不做逐字流式）。 */
const LIST_POLL_INTERVAL_MS = 15_000;

interface TerminalAgentPanelProps {
  isSidebarMode?: boolean;
  /** 面板当前可见且在最前：不可见时停轮询、退订镜像租约。 */
  isActive?: boolean;
  /** 待决策聚焦请求：转交 App 层的根 ClaudeDecisionDialog，本面板不实例化弹窗。 */
  onFocusDecision?: (decisionId: string) => void;
}

export function TerminalAgentPanel({ isSidebarMode = false, isActive = true, onFocusDecision }: TerminalAgentPanelProps) {
  const agentsPanelVisible = useAppStore(s => s.agentsPanelVisible);
  const selectedAgentTerminalId = useAppStore(s => s.selectedAgentTerminalId);
  const setSelectedAgentTerminalId = useAppStore(s => s.setSelectedAgentTerminalId);
  const [sessions, setSessions] = useState<TerminalAgentSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [nowTick, setNowTick] = useState(() => Date.now());
  const loadRequestRef = useRef(0);

  const load = useCallback(async () => {
    const request = ++loadRequestRef.current;
    setLoading(true);
    try {
      const items = await listTerminalAgents();
      if (request !== loadRequestRef.current) return;
      setSessions(items);
      setLoaded(true);
      setError('');
    } catch (loadError) {
      if (request === loadRequestRef.current) setError(describeTerminalAgentError(loadError));
    } finally {
      if (request === loadRequestRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isActive) return;
    void load();
    const timer = setInterval(() => void load(), LIST_POLL_INTERVAL_MS);
    const clock = setInterval(() => setNowTick(Date.now()), 30_000);
    return () => {
      clearInterval(timer);
      clearInterval(clock);
    };
  }, [isActive, load]);

  // 宽度与其余侧栏面板共用一套：侧栏风格下都是 configNavWidth，拖完互相广播同步。
  const { width, setWidth, isResizing, resizeHandleProps } = useResizablePanel({
    defaultWidth: 260,
    minWidth: 220,
    maxWidth: isSidebarMode ? 400 : 480,
    onResizeEnd: (w) => {
      const saveWidth = isSidebarMode ? saveConfigNavWidth : saveFileNavWidth;
      saveWidth(w).catch(console.error);
      notifyTerminalPanelResize();
      if (isSidebarMode) {
        window.dispatchEvent(new CustomEvent('navigation-width-changed', { detail: w }));
      }
    },
  });

  useEffect(() => {
    getBackendAppSettings()
      .then(s => setWidth(isSidebarMode ? s.configNavWidth || 260 : s.fileNavWidth || 260))
      .catch(() => {});
  }, [isSidebarMode, setWidth]);

  useEffect(() => {
    if (!isSidebarMode) return;
    const syncWidth = (event: Event) => {
      const next = (event as CustomEvent<number>).detail;
      if (Number.isFinite(next)) setWidth(next);
    };
    window.addEventListener('navigation-width-changed', syncWidth);
    return () => window.removeEventListener('navigation-width-changed', syncWidth);
  }, [isSidebarMode, setWidth]);

  // 选中终端已从列表消失且不属于本地会话时，仍保留会话视图（ended 只读），
  // 由 AgentChatView 的 error / failed 横幅提示，用户手动返回。

  const sortedSessions = [...sessions].sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));

  return (
    <div
      className={`ta-panel${isSidebarMode ? ' sidebar-mode' : ''}${agentsPanelVisible || isSidebarMode ? '' : ' collapsed'}`}
      style={{ width }}
    >
      {!selectedAgentTerminalId ? (
        <>
          <div className="panel-titlebar">
            <span className="panel-title">Agent 会话</span>
            <span className="panel-title-count">{sessions.length}</span>
            <button
              type="button"
              className="ta-titlebar-refresh"
              onClick={() => void load()}
              title="刷新列表"
              aria-label="刷新列表"
              disabled={loading}
            >
              <RefreshCw size={13} className={loading ? 'spin' : undefined} />
            </button>
          </div>
          <div className="ta-list" role="list" aria-label="可接力的终端 Agent 会话">
            {error && <div className="ta-list-error" role="alert">{error}</div>}
            {!error && !loaded && loading && <div className="ta-empty">正在获取 Agent 会话…</div>}
            {loaded && !loading && sessions.length === 0 && (
              <div className="ta-empty">
                暂无正在运行的 Agent 会话
                <div className="ta-empty-sub">在终端里启动 claude / codex / pi 后，会话会出现在这里</div>
              </div>
            )}
            {sortedSessions.map(item => (
              <button
                key={item.terminalId}
                type="button"
                className={`ta-item${item.terminalId === selectedAgentTerminalId ? ' selected' : ''}`}
                role="listitem"
                onClick={() => setSelectedAgentTerminalId(item.terminalId)}
              >
                <span className={`ta-provider-badge ${item.provider}`}>{providerLabel(item.provider)}</span>
                <span className="ta-item-main">
                  <span className="ta-item-title">{agentSessionTitle(item.title, item.sessionId)}</span>
                  <span className="ta-item-meta">
                    {item.profileName}
                    {formatRelativeTime(item.lastActivityAt, nowTick) && ` · ${formatRelativeTime(item.lastActivityAt, nowTick)}`}
                  </span>
                </span>
                <span className="ta-item-side">
                  {item.pendingDecisionCount > 0 && (
                    <span className="ta-item-decision">{item.pendingDecisionCount} 项待确认</span>
                  )}
                  {!item.canReply && <span className="ta-item-readonly">只读</span>}
                  <span className={`ta-phase ${phaseClass(item.phase)}`}>{phaseLabel(item.phase)}</span>
                </span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <AgentChatView
          key={selectedAgentTerminalId}
          terminalId={selectedAgentTerminalId}
          isActive={isActive}
          onBack={() => setSelectedAgentTerminalId(null)}
          onFocusDecision={onFocusDecision}
        />
      )}

      <div className={`resize-handle ${isResizing ? 'active' : ''}`} {...resizeHandleProps} />
    </div>
  );
}
