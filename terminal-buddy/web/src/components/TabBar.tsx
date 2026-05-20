import React from 'react';
import { useWebAppStore } from '../stores/appStore';
import { closeTerminal } from '../api/terminals';

const TabBar: React.FC = () => {
  const sessions = useWebAppStore((s) => s.sessions);
  const activeSessionId = useWebAppStore((s) => s.activeSessionId);
  const setActiveSession = useWebAppStore((s) => s.setActiveSession);
  const removeSession = useWebAppStore((s) => s.removeSession);

  const handleClose = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    try { await closeTerminal(id); } catch {}
    removeSession(id);
  };

  return (
    <div style={{
      display: 'flex', background: '#16162e', borderBottom: '1px solid #2a2a4a',
      padding: '0 8px', height: 40, gap: 2, overflowX: 'auto', flexShrink: 0,
    }}>
      {sessions.map((session) => (
        <div
          key={session.id}
          onClick={() => setActiveSession(session.id)}
          style={{
            padding: '6px 16px', borderRadius: '6px 6px 0 0',
            fontSize: 13, color: session.id === activeSessionId ? '#e0e0ff' : '#8a8aaa',
            cursor: 'pointer', whiteSpace: 'nowrap', display: 'flex',
            alignItems: 'center', gap: 8, transition: 'all 0.15s',
            background: session.id === activeSessionId ? '#1e1e3a' : 'transparent',
            borderBottom: session.id === activeSessionId ? '2px solid #6a6ad5' : 'none',
          }}
        >
          <span style={{
            width: 8, height: 8, borderRadius: '50%', background: '#4caf50', flexShrink: 0,
          }} />
          {session.profileName}
          <button
            onClick={(e) => handleClose(e, session.id)}
            style={{
              width: 16, height: 16, borderRadius: 4, border: 'none',
              background: 'transparent', color: '#6a6a8a', cursor: 'pointer',
              fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >×</button>
        </div>
      ))}
    </div>
  );
};

export default TabBar;
