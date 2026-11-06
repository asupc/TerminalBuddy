import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ChevronDown, ChevronUp, RefreshCw } from 'lucide-react';
import { mobileAiIndicator, mobileAiStatus, type MobileAiMessage } from '../../services/mobileAi';
import { useAppStore } from '../../stores/appStore';
import { getIndicatorClassName, getIndicatorColor } from '../../utils/claudeIndicator';
import type { TerminalColors } from '../../utils/terminalTheme';
import { useMobileAiSession } from './useMobileAiSession';
import './MobileSessionLiveMessages.css';

const PAGE_SIZE = 100;
const ROLE_LABELS: Record<string, string> = { user: '你', tool: '工具', system: '系统' };

const MessageRow = memo(function MessageRow({ message, provider }: { message: MobileAiMessage; provider: string }) {
  return (
    <div className={`mobile-live-message role-${message.role}`}>
      <div className="mobile-live-message-role">
        {message.role === 'assistant' ? (provider === 'codex' ? 'Codex' : 'Claude') : ROLE_LABELS[message.role] ?? message.role}
      </div>
      <div className="mobile-live-message-text">{message.text}</div>
    </div>
  );
});

/** 原生 CLI 保留交互；手机正文从同一个 AI 任务读取，不依赖 CLI 恢复时的历史快照。 */
export function MobileSessionLiveMessages({ sessionId, colorTheme, isActive }: {
  sessionId: string;
  colorTheme: TerminalColors;
  isActive: boolean;
}) {
  const { session, metadata, connected, error, reconnect } = useMobileAiSession(sessionId);
  const [expanded, setExpanded] = useState(true);
  const [following, setFollowing] = useState(true);
  const [startIndex, setStartIndex] = useState<number | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const prependRef = useRef<{ height: number; top: number } | null>(null);
  const info = metadata && (!session || metadata.revision > session.revision) ? metadata : session;
  const light = mobileAiIndicator(info?.status ?? 'idle', info?.resultRevision);
  const messages = useMemo(() => {
    const pending = new Set(session?.pendingInputs?.map(input => input.requestId));
    return session?.messages.filter(message => !pending.has(message.id)) ?? [];
  }, [session]);
  // 首次只显示最近一页，随后追加消息时保持起点，避免挤掉正在阅读的旧消息。
  const firstVisibleIndex = Math.min(startIndex ?? Math.max(0, messages.length - PAGE_SIZE), messages.length);
  const visibleMessages = messages.slice(firstVisibleIndex);
  useLayoutEffect(() => {
    if (session && startIndex === null) setStartIndex(firstVisibleIndex);
  }, [session, startIndex, firstVisibleIndex]);

  const scrollToLatest = () => {
    followingRef.current = true;
    setFollowing(true);
    const body = bodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
  };

  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!expanded || !body || body.clientHeight === 0) return;
    if (prependRef.current) {
      body.scrollTop = prependRef.current.top + body.scrollHeight - prependRef.current.height;
      prependRef.current = null;
    } else if (followingRef.current) {
      body.scrollTop = body.scrollHeight;
    }
  }, [session?.revision, expanded, startIndex, isActive]);

  useEffect(() => {
    // 懒加载挂载和折叠都会改变原终端高度，TUI 需要走强制尺寸同步。
    useAppStore.getState().bumpTerminalLayout();
  }, [expanded]);

  useEffect(() => () => useAppStore.getState().bumpTerminalLayout(), []);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    // 分屏、窗口大小和消息区展开后继续跟随，阅读历史时保持原位置。
    const observer = new ResizeObserver(() => {
      if (followingRef.current && body.clientHeight > 0) body.scrollTop = body.scrollHeight;
    });
    observer.observe(body);
    return () => observer.disconnect();
  }, [expanded]);

  return (
    <section className={`mobile-session-live${expanded ? ' expanded' : ''}`}
      style={{ backgroundColor: colorTheme.background, color: colorTheme.foreground }} aria-label="手机实时消息">
      <div className="mobile-session-live-head">
        <button type="button" className="mobile-session-live-toggle" aria-expanded={expanded}
          onClick={() => {
            setExpanded(value => !value);
            if (!expanded) scrollToLatest();
          }}>
          {expanded ? <ChevronDown aria-hidden="true" /> : <ChevronUp aria-hidden="true" />}
          手机实时消息
        </button>
        <span className={`mobile-session-live-dot${getIndicatorClassName(light)}`} style={{ background: getIndicatorColor(light) }} />
        <span className="mobile-session-live-status" role="status">
          {error || `${connected ? '实时同步' : '正在重连'} · ${mobileAiStatus(info?.status ?? 'idle')}`}
        </span>
        <button type="button" onClick={reconnect} title="重新同步消息" aria-label="重新同步消息"><RefreshCw aria-hidden="true" /></button>
      </div>
      {expanded && (
        <>
          <div className="mobile-session-live-body" ref={bodyRef} onScroll={() => {
            const body = bodyRef.current;
            if (!body || body.clientHeight === 0) return;
            const follow = body.scrollHeight - body.scrollTop - body.clientHeight <= 48;
            followingRef.current = follow;
            setFollowing(follow);
          }}>
            {firstVisibleIndex > 0 && (
              <button type="button" className="mobile-session-live-more" onClick={() => {
                const body = bodyRef.current;
                if (body) prependRef.current = { height: body.scrollHeight, top: body.scrollTop };
                followingRef.current = false;
                setFollowing(false);
                setStartIndex(Math.max(0, firstVisibleIndex - PAGE_SIZE));
              }}>加载更早消息（还有 {firstVisibleIndex} 条）</button>
            )}
            {!session && <div className="mobile-session-live-empty">正在同步会话消息…</div>}
            {session && !messages.length && <div className="mobile-session-live-empty">等待手机发送消息</div>}
            {visibleMessages.map(message => <MessageRow key={message.id} message={message} provider={info?.provider ?? 'claude'} />)}
            {session?.error && <div className="mobile-session-live-error">{session.error}</div>}
          </div>
          {!following && <button type="button" className="mobile-session-live-latest" onClick={scrollToLatest}>
            <ArrowDown aria-hidden="true" />最新消息
          </button>}
        </>
      )}
    </section>
  );
}
