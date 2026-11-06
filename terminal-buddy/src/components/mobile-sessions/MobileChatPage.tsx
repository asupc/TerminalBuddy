import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, LoaderCircle, RefreshCw, Smartphone, X } from 'lucide-react';
import { mobileAiRunning, mobileAiStatus, watchMobileAi, type MobileAiSession } from '../../services/mobileAi';
import { closeMobileAiSession, useMobileAiStore } from '../../stores/mobileAiStore';
import './MobileSessions.css';
import './MobileChatPage.css';

/** 直接订阅手机原生会话，关闭查看只释放消息连接，任务继续由原会话执行。 */
export function MobileChatPage({ sessionId }: { sessionId: string }) {
  const metadata = useMobileAiStore(state => state.sessions.find(session => session.id === sessionId));
  const [session, setSession] = useState<MobileAiSession | null>(null);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [generation, setGeneration] = useState(0);
  const [following, setFollowing] = useState(true);
  const followingRef = useRef(true);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLoading(true);
    setError('');
    setConnected(false);
    // 页面切换由 key 重新挂载；手动重连保留已显示的正文和阅读位置。
    const receive = (incoming: MobileAiSession) => {
      if (incoming.id !== sessionId) return;
      setSession(previous => previous && previous.revision > incoming.revision ? previous : incoming);
      setLoading(false);
      setError('');
    };
    return watchMobileAi<MobileAiSession>({
      path: `/api/ai/sessions/${encodeURIComponent(sessionId)}`,
      socketPath: `/ws/ai/${encodeURIComponent(sessionId)}`,
      onSnapshot: receive,
      onFrame: frame => {
        if (frame.type === 'session') { receive(frame.session); return; }
        if (frame.type !== 'update' || frame.session.id !== sessionId) return;
        setSession(previous => {
          if (!previous || frame.session.revision < previous.revision) return previous;
          const changed = new Map(frame.messages.map(message => [message.id, message]));
          const messages = previous.messages.map(message => {
            const next = changed.get(message.id);
            changed.delete(message.id);
            return next ?? message;
          });
          messages.push(...changed.values());
          return { ...frame.session, messages };
        });
        setLoading(false);
        setError('');
      },
      onConnected: setConnected,
      onError: message => { setError(message); setLoading(false); },
    });
  }, [sessionId, generation]);

  // 正文两秒没有追上列表时重连；列表持续更新不能反复推迟这个期限。
  const behind = Boolean(metadata && session && metadata.revision > session.revision);
  useEffect(() => {
    if (!behind) return;
    const retry = setTimeout(() => setGeneration(value => value + 1), 2000);
    return () => clearTimeout(retry);
  }, [behind, session?.revision]);

  const messages = useMemo(() => {
    const queued = new Set(session?.pendingInputs?.map(input => input.requestId));
    return session?.messages.filter(message => !queued.has(message.id)) ?? [];
  }, [session]);
  useLayoutEffect(() => {
    if (followingRef.current && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [messages, session?.pendingInputs, session?.status, session?.error]);
  const latest = () => {
    followingRef.current = true;
    setFollowing(true);
    const body = bodyRef.current;
    if (body) body.scrollTo({ top: body.scrollHeight, behavior: 'smooth' });
  };
  const info = session ?? metadata;
  const running = Boolean(info && mobileAiRunning(info.status));
  const showThinking = running && (info?.status !== 'running' || messages[messages.length - 1]?.role !== 'assistant');

  return (
    <section className="mobile-chat" aria-label="移动端实时会话">
      <header className="mobile-chat-header">
        <Smartphone size={20} aria-hidden="true" />
        <div className="mobile-chat-title">
          <h2>{info?.title ?? '移动端会话'} <span className="mobile-session-badge">移动端</span></h2>
          <p title={info?.projectPath}>{[info?.provider === 'codex' ? 'Codex' : 'Claude', info?.providerName, info?.model, info?.projectPath].filter(Boolean).join(' · ')}</p>
        </div>
        <span className="mobile-chat-status" role="status">{loading ? '正在加载' : connected ? '实时同步' : '正在重连'} · {info ? mobileAiStatus(info.status) : '读取会话'}</span>
        <button type="button" className="mobile-chat-action" onClick={() => setGeneration(value => value + 1)} title="重新同步" aria-label="重新同步移动端会话"><RefreshCw size={16} /></button>
        <button type="button" className="mobile-chat-action" onClick={closeMobileAiSession} title="关闭查看" aria-label="关闭移动端会话查看"><X size={18} /></button>
      </header>
      {error && <div className="mobile-chat-error" role="status">{error}</div>}
      <div className="mobile-chat-body" ref={bodyRef} onScroll={event => {
        const body = event.currentTarget;
        const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 60;
        followingRef.current = atBottom;
        setFollowing(atBottom);
      }}>
        {loading && !session && <div className="mobile-chat-empty"><LoaderCircle className="mobile-chat-spinner" size={20} />正在加载手机会话消息…</div>}
        {!loading && !messages.length && !error && <div className="mobile-chat-empty">暂无消息，手机发送后会自动显示。</div>}
        {messages.map(message => message.role === 'tool' ? (
          <details key={message.id} className="mobile-chat-tools" onToggle={event => {
            if (event.currentTarget.open) { followingRef.current = false; setFollowing(false); }
          }}><summary>执行记录 · {message.text.split('\n')[0]?.slice(0, 100) || '工具结果'}</summary><pre>{message.text}</pre></details>
        ) : (
          <article key={message.id} className={`mobile-chat-message ${message.role === 'user' ? 'mine' : 'assistant'}`}>
            <div className="mobile-chat-message-role">
              <span>{message.role === 'user' ? '你' : message.role === 'assistant' ? (info?.provider === 'codex' ? 'Codex' : 'Claude') : '系统'}</span>
              {message.createdAt > 0 && <time dateTime={new Date(message.createdAt).toISOString()}>{new Date(message.createdAt).toLocaleString('zh-CN', { hour12: false })}</time>}
            </div>
            <div className="mobile-chat-text">{message.text}</div>
          </article>
        ))}
        {session?.pendingInputs?.map(input => <div key={input.requestId} className="mobile-chat-queued">排队中 · {input.text}</div>)}
        {showThinking && <div className="mobile-chat-thinking" role="status"><LoaderCircle className="mobile-chat-spinner" size={16} />{info?.status === 'approval' ? '等待确认' : info?.status === 'background' ? '后台任务执行中' : info?.status === 'stopping' ? '正在中断' : '思考中'}</div>}
        {session?.error && <div className="mobile-chat-error">{session.error}</div>}
      </div>
      {!following && <button type="button" className="mobile-chat-latest" onClick={latest}><ArrowDown size={15} />回到最新</button>}
    </section>
  );
}
