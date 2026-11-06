import { useEffect, useMemo, useState } from 'react';
import { watchMobileAi, type MobileAiSession } from '../../services/mobileAi';
import { closeMobileAiSession, useMobileAiStore } from '../../stores/mobileAiStore';
import { MobileSessionTerminal } from './MobileSessionTerminal';
import { mobileTerminalOutput } from './mobileTerminalOutput';

/** 直接订阅手机原生会话，关闭查看只释放消息连接，任务继续由原会话执行。 */
export function MobileChatPage({ sessionId }: { sessionId: string }) {
  const metadata = useMobileAiStore(state => state.sessions.find(session => session.id === sessionId));
  const [session, setSession] = useState<MobileAiSession | null>(null);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [generation, setGeneration] = useState(0);

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
  const info = session ?? metadata ?? null;
  const output = useMemo(() => mobileTerminalOutput(info, messages), [info, messages]);

  return (
    <MobileSessionTerminal output={output} loading={loading} connected={connected} status={info?.status} resultRevision={info?.resultRevision}
      error={error} onReconnect={() => setGeneration(value => value + 1)} onClose={closeMobileAiSession} />
  );
}
