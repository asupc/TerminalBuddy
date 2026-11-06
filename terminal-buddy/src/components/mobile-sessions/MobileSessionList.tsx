import { Smartphone } from 'lucide-react';
import { mobileAiRunning, mobileAiStatus } from '../../services/mobileAi';
import { useAppStore } from '../../stores/appStore';
import { openMobileAiSession, useMobileAiStore } from '../../stores/mobileAiStore';
import './MobileSessions.css';

export function MobileSessionList({ layout = 'list' }: { layout?: 'list' | 'tabs' }) {
  const sessions = useMobileAiStore(state => state.sessions);
  const selectedId = useMobileAiStore(state => state.selectedId);
  const error = useMobileAiStore(state => state.error);
  const active = useAppStore(state => state.activeSpecialTab);
  if (!sessions.length && !error) return null;
  return (
    <div className={`mobile-session-${layout}`} onContextMenu={event => event.stopPropagation()}>
      {layout === 'list' && <div className="mobile-session-heading"><Smartphone size={14} aria-hidden="true" />移动端会话<span>{sessions.length}</span></div>}
      {error && <div className="mobile-session-error" role="status">移动端会话同步：{error}</div>}
      {sessions.map(session => (
        <button key={session.id} type="button"
          className={`mobile-session-row${layout === 'tabs' ? ' terminal-tab' : ''}${active === 'mobile-chat' && selectedId === session.id ? ' active' : ''}`}
          aria-pressed={active === 'mobile-chat' && selectedId === session.id}
          onClick={() => openMobileAiSession(session.id)}
          title={`${session.title}\n${session.projectPath}\n${mobileAiStatus(session.status)}${session.providerName ? ` · ${session.providerName}` : ''}`}>
          <span className={`mobile-session-dot${mobileAiRunning(session.status) ? ' running' : ''}${session.status === 'error' ? ' failed' : ''}`} />
          <span className="mobile-session-label"><span>{session.title}</span>
            {layout === 'list' && <small>{session.provider === 'codex' ? 'Codex' : 'Claude'} · {mobileAiStatus(session.status)}</small>}
          </span>
          <span className="mobile-session-badge">移动端</span>
        </button>
      ))}
    </div>
  );
}
