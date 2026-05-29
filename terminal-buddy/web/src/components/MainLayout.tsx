import React, { useEffect, useCallback, useRef, useState } from 'react';
import Sidebar from './Sidebar';
import TabBar from './TabBar';
import TerminalView from './TerminalView';
import { useWebAppStore } from '../stores/appStore';
import { listTerminals } from '../api/terminals';

const MainLayout: React.FC = () => {
  const sidebarOpen = useWebAppStore((s) => s.sidebarOpen);
  const activeSessionId = useWebAppStore((s) => s.activeSessionId);
  const sessions = useWebAppStore((s) => s.sessions);
  const toggleSidebar = useWebAppStore((s) => s.toggleSidebar);
  const isMobile = useWebAppStore((s) => s.isMobile);
  const setIsMobile = useWebAppStore((s) => s.setIsMobile);
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const autoFsRef = useRef(false);

  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement && !(document as any).webkitFullscreenElement) {
      const el = document.documentElement;
      (el.requestFullscreen || (el as any).webkitRequestFullscreen)?.call(el);
    } else {
      (document.exitFullscreen || (document as any).webkitExitFullscreen)?.call(document);
    }
  }, []);

  useEffect(() => {
    const onChange = () => setIsFullscreen(!!(document.fullscreenElement || (document as any).webkitFullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    document.addEventListener('webkitfullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      document.removeEventListener('webkitfullscreenchange', onChange);
    };
  }, []);

  // Auto-fullscreen on first terminal open (mobile only)
  useEffect(() => {
    if (isMobile && sessions.length > 0 && !autoFsRef.current && !document.fullscreenElement && !(document as any).webkitFullscreenElement) {
      autoFsRef.current = true;
      const el = document.documentElement;
      (el.requestFullscreen || (el as any).webkitRequestFullscreen)?.call(el).catch(() => {});
    }
  }, [isMobile, sessions.length]);

  useEffect(() => {
    const mql = window.matchMedia('(max-width: 767px)');
    setIsMobile(mql.matches);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [setIsMobile]);

  // Auto-load running terminals into tabs on page load
  useEffect(() => {
    listTerminals().then((terminals) => {
      const store = useWebAppStore.getState();
      for (const t of terminals) {
        const alreadyOpen = store.sessions.find((s) => s.id === t.id);
        if (!alreadyOpen) {
          store.addSession({
            id: t.id,
            profileId: t.profileId,
            profileName: t.profileName,
            terminalType: t.terminalType as any,
            owner: t.owner,
          });
        }
      }
    }).catch(() => {});
  }, []);

  return (
    <div style={{ height: 'var(--vh, 100vh)', display: 'flex' }}>
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
            borderBottom: '1px solid #2a2a4a', padding: '4px 8px', gap: 6,
          }}>
            <button onClick={toggleSidebar} style={{
              width: 32, height: 32, borderRadius: 6, border: '1px solid #3a3a5a',
              background: '#2a2a4a', color: '#a0a0d0', fontSize: 16,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>☰</button>
            <span style={{ fontSize: 12, color: '#a0a0d0', flex: 1 }}>连接</span>
            <button onClick={toggleFullscreen} style={{
              width: 32, height: 32, borderRadius: 6, border: '1px solid #3a3a5a',
              background: '#2a2a4a', color: '#a0a0d0', fontSize: 14,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>{isFullscreen ? '⊡' : '⛶'}</button>
          </div>
        )}

        <TabBar />
        <div style={{ flex: 1, background: '#0c0c1e', position: 'relative' }}>
          {sessions.length === 0 ? (
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              height: '100%', color: '#6a6a8a', fontSize: 14,
            }}>
              选择一个连接开始使用终端
            </div>
          ) : (
            sessions.map((s) => (
              <div key={s.id} style={{ position: 'absolute', inset: 0 }}>
                <TerminalView session={s} hidden={s.id !== activeSessionId} />
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};

export default MainLayout;
