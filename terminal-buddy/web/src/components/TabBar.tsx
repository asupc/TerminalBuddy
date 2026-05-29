import React from 'react';
import { useWebAppStore } from '../stores/appStore';
import { closeTerminal } from '../api/terminals';

const TabBar: React.FC = () => {
  const sessions = useWebAppStore((s) => s.sessions);
  const activeSessionId = useWebAppStore((s) => s.activeSessionId);
  const setActiveSession = useWebAppStore((s) => s.setActiveSession);
  const removeSession = useWebAppStore((s) => s.removeSession);
  const isMobile = useWebAppStore((s) => s.isMobile);

  const handleClose = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    try {
      await closeTerminal(id);
    } catch (err) {
      console.error('关闭终端失败:', err);
    }
    removeSession(id);
  };

  // Count occurrences per profileId to add numeric suffixes
  const profileCounts: Record<string, number> = {};
  sessions.forEach((s) => { profileCounts[s.profileId] = (profileCounts[s.profileId] || 0) + 1; });
  const profileIndex: Record<string, number> = {};

  return (
    <div style={{
      display: 'flex', background: '#16162e', borderBottom: '1px solid #2a2a4a',
      padding: isMobile ? '0 4px' : '0 8px',
      height: isMobile ? 32 : 40, gap: 2, overflowX: 'auto', flexShrink: 0,
    }}>
      {sessions.map((session) => {
        const idx = (profileIndex[session.profileId] = (profileIndex[session.profileId] || 0) + 1);
        const label = profileCounts[session.profileId] > 1
          ? `${session.profileName} (${idx})`
          : session.profileName;
        return (
        <div
          key={session.id}
          onClick={() => setActiveSession(session.id)}
          style={{
            padding: isMobile ? '3px 10px' : '6px 16px',
            borderRadius: '6px 6px 0 0',
            fontSize: isMobile ? 12 : 13,
            color: session.id === activeSessionId ? '#e0e0ff' : '#8a8aaa',
            cursor: 'pointer', whiteSpace: 'nowrap', display: 'flex',
            alignItems: 'center', gap: isMobile ? 4 : 8, transition: 'all 0.15s',
            background: session.id === activeSessionId ? '#1e1e3a' : 'transparent',
            borderBottom: session.id === activeSessionId ? '2px solid #6a6ad5' : 'none',
          }}
        >
          <span style={{
            width: isMobile ? 6 : 8, height: isMobile ? 6 : 8,
            borderRadius: '50%', background: '#4caf50', flexShrink: 0,
          }} />
          {label}
          <button
            onClick={(e) => handleClose(e, session.id)}
            style={{
              width: 16, height: 16, borderRadius: 4, border: 'none',
              background: 'transparent', color: '#6a6a8a', cursor: 'pointer',
              fontSize: isMobile ? 10 : 12, display: 'flex', alignItems: 'center',
              justifyContent: 'center',
            }}
          >×</button>
        </div>
        );
      })}
    </div>
  );
};

export default TabBar;
