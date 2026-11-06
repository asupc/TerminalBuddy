import { useState } from 'react';
import { ChevronRight, Folder, FolderOpen } from 'lucide-react';
import { mobileAiIndicator, mobileAiStatus } from '../../services/mobileAi';
import { useAppStore } from '../../stores/appStore';
import { openMobileAiSession, useMobileAiStore } from '../../stores/mobileAiStore';
import { getIndicatorClassName, getIndicatorColor } from '../../utils/claudeIndicator';
import { SessionTaskLabel } from '../shell/SessionTaskLabel';
import './MobileSessions.css';

export function MobileSessionList({ layout = 'list' }: { layout?: 'list' | 'tabs' }) {
  const sessions = useMobileAiStore(state => state.sessions);
  const activeMobileId = useAppStore(state => state.sessions.find(session => session.id === state.activeSessionId)?.mobileAiSessionId);
  const openingIds = useMobileAiStore(state => state.openingIds);
  const error = useMobileAiStore(state => state.error);
  const active = useAppStore(state => state.activeSpecialTab);
  const [collapsed, setCollapsed] = useState(false);
  if (!sessions.length && !error) return null;
  const tabs = layout === 'tabs';

  return (
    <div className={tabs ? 'mobile-session-tabs' : 'tab-nav-group'} onContextMenu={event => event.stopPropagation()}>
      {!tabs && (
        <div className="tree-item tree-group-item" role="button" tabIndex={0} aria-expanded={!collapsed}
          onClick={() => setCollapsed(value => !value)}
          onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setCollapsed(value => !value); } }}>
          <span className={`tree-arrow${collapsed ? '' : ' expanded'}`}><ChevronRight aria-hidden="true" /></span>
          <span className="tree-group-icon">{collapsed ? <Folder aria-hidden="true" /> : <FolderOpen aria-hidden="true" />}</span>
          <span className="tree-group-name">移动端会话</span>
          <span className="tree-item-count">{sessions.length}</span>
        </div>
      )}
      {error && <div className="mobile-session-error" role="status">移动端会话同步：{error}</div>}
      {(tabs || !collapsed) && sessions.map(session => {
        const selected = active === null && activeMobileId === session.id;
        const opening = openingIds.includes(session.id);
        const light = mobileAiIndicator(session.status, session.resultRevision);
        return (
          <div key={session.id} role="button" tabIndex={0} aria-pressed={selected} aria-busy={opening}
            className={`${tabs ? 'terminal-tab' : 'tree-item tab-nav-item tab-nav-task-item'}${selected ? ' active' : ''}`}
            title={`${session.title}\n${session.projectPath}\n${opening ? '正在恢复到终端…' : mobileAiStatus(session.status)}`}
            onMouseDown={() => useAppStore.getState().setLastClickRegion('tab')}
            onClick={() => openMobileAiSession(session.id)}
            onKeyDown={event => {
              if (event.target !== event.currentTarget) return;
              if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openMobileAiSession(session.id); }
            }}>
            <span className={`${tabs ? 'terminal-tab-dot' : 'tab-nav-dot'}${getIndicatorClassName(light)}`}
              style={{ background: getIndicatorColor(light) }} title={mobileAiStatus(session.status)} />
            {tabs ? (
              <>
                {session.model && <span className="terminal-tab-model-chip">{session.model}</span>}
                <span className="terminal-tab-name">{session.title}</span>
              </>
            ) : (
              <SessionTaskLabel fallbackName={session.title} fallbackProvider={session.provider === 'codex' ? 'codex' : 'claude'} fallbackModel={session.model ?? undefined} />
            )}
            <span className={tabs ? 'terminal-owner-badge' : 'tab-nav-owner-badge'}>移动端</span>
          </div>
        );
      })}
    </div>
  );
}
