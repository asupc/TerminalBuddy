import React, { useState, useEffect } from 'react';
import Sidebar from './Sidebar';
import TabBar from './TabBar';
import TerminalView from './TerminalView';
import { useWebAppStore } from '../stores/appStore';

const MainLayout: React.FC = () => {
  const sidebarOpen = useWebAppStore((s) => s.sidebarOpen);
  const activeSessionId = useWebAppStore((s) => s.activeSessionId);
  const sessions = useWebAppStore((s) => s.sessions);
  const toggleSidebar = useWebAppStore((s) => s.toggleSidebar);
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return (
    <div style={{ height: '100vh', display: 'flex' }}>
      {/* Desktop sidebar */}
      {!isMobile && (
        <div style={{
          width: sidebarOpen ? 220 : 0, overflow: 'hidden',
          transition: 'width 0.2s', flexShrink: 0,
        }}>
          <Sidebar />
        </div>
      )}

      {/* Mobile drawer overlay */}
      {isMobile && sidebarOpen && (
        <>
          <div onClick={toggleSidebar} style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 200,
          }} />
          <div style={{
            position: 'fixed', left: 0, top: 0, bottom: 0, width: 260, zIndex: 300,
            background: '#16162e',
          }}>
            <Sidebar />
          </div>
        </>
      )}

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {/* Mobile header with hamburger */}
        {isMobile && (
          <div style={{
            display: 'flex', alignItems: 'center', background: '#16162e',
            borderBottom: '1px solid #2a2a4a', padding: '8px 12px', gap: 8,
          }}>
            <button onClick={toggleSidebar} style={{
              width: 36, height: 36, borderRadius: 6, border: '1px solid #3a3a5a',
              background: '#2a2a4a', color: '#a0a0d0', fontSize: 18,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>☰</button>
            <span style={{ fontSize: 13, color: '#a0a0d0' }}>连接</span>
          </div>
        )}

        <TabBar />
        <div style={{ flex: 1, background: '#0c0c1e' }}>
          {activeSession ? (
            <TerminalView session={activeSession} />
          ) : (
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              height: '100%', color: '#6a6a8a', fontSize: 14,
            }}>
              选择一个连接开始使用终端
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default MainLayout;
