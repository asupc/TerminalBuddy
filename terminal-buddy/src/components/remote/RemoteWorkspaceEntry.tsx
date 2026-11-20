import { useEffect, useState } from 'react';
import { Cloud, LoaderCircle } from 'lucide-react';
import App from '../../App';
import { RemoteLoginDialog } from './RemoteLoginDialog';
import {
  initializeWorkspace,
  RemoteTokenExpiredError,
  type RemoteWorkspaceState,
} from '../../services/remoteWorkspace/session';
import { getRemoteWorkspaceState } from '../../services/remoteWorkspace/native';
import './RemoteWorkspaceEntry.css';

type Overlay = null | 'login';

export function RemoteWorkspaceEntry() {
  const [state, setState] = useState<RemoteWorkspaceState | null>(null);
  const [initialError, setInitialError] = useState<string | null>(null);
  const [initialOverlay, setInitialOverlay] = useState<Overlay>(null);

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

/** 工作区切换已在标题栏内完成，这里只负责令牌过期后的重新登录面板。 */
function RemoteWorkspaceHost({ state, initialOverlay }: { state: RemoteWorkspaceState; initialOverlay: Overlay }) {
  const [overlay, setOverlay] = useState<Overlay>(initialOverlay);
  useEffect(() => {
    const loginRequired = () => setOverlay('login');
    window.addEventListener('terminal-buddy-auth-expired', loginRequired);
    window.addEventListener('terminal-buddy-remote-login-required', loginRequired);
    return () => {
      window.removeEventListener('terminal-buddy-auth-expired', loginRequired);
      window.removeEventListener('terminal-buddy-remote-login-required', loginRequired);
    };
  }, []);
  return overlay === 'login'
    ? <RemoteLoginDialog username={state.connection?.username} onCancel={() => setOverlay(null)} />
    : null;
}
