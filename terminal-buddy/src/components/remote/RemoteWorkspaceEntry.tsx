import { useEffect, useState } from 'react';
import { Cloud, LoaderCircle } from 'lucide-react';
import App from '../../App';
import { RemoteWorkspaceDialog } from './RemoteWorkspaceDialog';
import { RemoteLoginDialog } from './RemoteLoginDialog';
import {
  initializeWorkspace,
  RemoteTokenExpiredError,
  type RemoteWorkspaceState,
} from '../../services/remoteWorkspace/session';
import { getRemoteWorkspaceState } from '../../services/remoteWorkspace/native';
import './RemoteWorkspaceEntry.css';

type Overlay = null | 'workspace' | 'login';

export function RemoteWorkspaceEntry() {
  const [state, setState] = useState<RemoteWorkspaceState | null>(null);
  const [initialError, setInitialError] = useState<string | null>(null);
  const [initialOverlay, setInitialOverlay] = useState<Exclude<Overlay, null> | null>(null);

  useEffect(() => {
    let cancelled = false;
    void initializeWorkspace().then(next => {
      if (!cancelled) setState(next);
    }).catch(async reason => {
      if (cancelled) return;
      // 令牌过期时保持本机工作区，但立即打开重登面板。
      if (reason instanceof RemoteTokenExpiredError) {
        const current = await getRemoteWorkspaceState().catch(() => null);
        if (!cancelled && current) {
          setState(current);
          setInitialOverlay('login');
        }
        return;
      }
      if (!cancelled) setInitialError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { cancelled = true; };
  }, []);

  if (!state) {
    return <div className="desktop-workspace-loading">
      <Cloud aria-hidden="true" />
      <h1>TerminalBuddy</h1>
      {initialError ? <>
        <p role="alert">{initialError}</p>
        <button type="button" onClick={() => window.location.reload()}>重新加载</button>
      </> : <p><LoaderCircle className="remote-workspace-spin" aria-hidden="true" />正在准备工作区…</p>}
    </div>;
  }

  return <>
    <App />
    <RemoteWorkspaceHost state={state} initialOverlay={initialOverlay} />
  </>;
}

function RemoteWorkspaceHost({ state: initialState, initialOverlay }: { state: RemoteWorkspaceState; initialOverlay: Overlay }) {
  const [state, setState] = useState(initialState);
  // 弹框内的增删改不会通知父级，这里用递增 key 在每次打开时按后端最新状态重挂载。
  const [dialogKey, setDialogKey] = useState(0);
  const [overlay, setOverlay] = useState<Overlay>(initialOverlay);
  useEffect(() => {
    const openWorkspace = () => {
      // 先同步一次连接列表，避免重新打开时展示已删除或已改名的旧条目。
      void getRemoteWorkspaceState().then(next => {
        setState(next);
        setDialogKey(key => key + 1);
        setOverlay('workspace');
      }).catch(() => setOverlay('workspace'));
    };
    const loginRequired = () => setOverlay('login');
    window.addEventListener('terminal-buddy-open-workspace', openWorkspace);
    window.addEventListener('terminal-buddy-auth-expired', loginRequired);
    window.addEventListener('terminal-buddy-remote-login-required', loginRequired);
    return () => {
      window.removeEventListener('terminal-buddy-open-workspace', openWorkspace);
      window.removeEventListener('terminal-buddy-auth-expired', loginRequired);
      window.removeEventListener('terminal-buddy-remote-login-required', loginRequired);
    };
  }, []);
  return <>
    {overlay === 'workspace' && <RemoteWorkspaceDialog key={dialogKey} state={state} onClose={() => setOverlay(null)} />}
    {overlay === 'login' && <RemoteLoginDialog username={state.connection?.username} onCancel={() => setOverlay(null)} />}
  </>;
}
