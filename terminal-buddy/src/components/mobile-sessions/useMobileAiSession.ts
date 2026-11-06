import { useEffect, useState } from 'react';
import { watchMobileAi, type MobileAiSession } from '../../services/mobileAi';
import { useMobileAiStore } from '../../stores/mobileAiStore';

/** 正文订阅跟随恢复后的终端生命周期，切换标签或折叠消息区不会丢掉增量。 */
export function useMobileAiSession(sessionId: string) {
  const metadata = useMobileAiStore(state => state.sessions.find(session => session.id === sessionId));
  const [session, setSession] = useState<MobileAiSession | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    setConnected(false);
    setError('');
    const receive = (incoming: MobileAiSession) => {
      if (incoming.id !== sessionId) return;
      setSession(previous => previous && previous.revision > incoming.revision ? previous : incoming);
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
          if (!previous || previous.revision > frame.session.revision) return previous;
          // 增量中的 text 是该消息的完整最新值，按 ID 替换，不能重复拼接流式片段。
          const changed = new Map(frame.messages.map(message => [message.id, message]));
          const messages = previous.messages.map(message => {
            const next = changed.get(message.id);
            changed.delete(message.id);
            return next ?? message;
          });
          messages.push(...changed.values());
          return { ...frame.session, messages };
        });
        setError('');
      },
      onConnected: setConnected,
      onError: setError,
    });
  }, [sessionId, generation]);

  // 列表仍在更新而正文停滞时重新取得完整快照；不能因列表不断到达而推迟补偿。
  const behind = Boolean(metadata && session && metadata.revision > session.revision);
  useEffect(() => {
    if (!behind) return;
    const timer = setTimeout(() => setGeneration(value => value + 1), 2000);
    return () => clearTimeout(timer);
  }, [behind, session?.revision]);

  return { session, metadata, connected, error, reconnect: () => setGeneration(value => value + 1) };
}
