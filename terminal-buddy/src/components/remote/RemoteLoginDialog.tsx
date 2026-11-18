import { useState, type FormEvent } from 'react';
import { LoaderCircle, LogIn } from 'lucide-react';
import { Dialog } from '../shared/Dialog';
import { authenticateRemoteWorkspace, enterRemoteWorkspace } from '../../services/remoteWorkspace/session';
import './RemoteWorkspaceDialog.css';

/** 令牌过期只做增量重新登录；已运行的远程终端保留，不重新创建。 */
export function RemoteLoginDialog({ username, onCancel }: { username?: string; onCancel: () => void }) {
  const [account, setAccount] = useState(username ?? 'admin');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await authenticateRemoteWorkspace({ username: account, password });
      await enterRemoteWorkspace();
      window.location.reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  };
  return <Dialog title="远程登录已过期" onClose={busy ? () => {} : onCancel} style={{ width: 420 }}>
    <form className="remote-workspace-dialog" onSubmit={submit}>
      <p className="remote-workspace-intro">重新登录后继续管理远程服务；已经运行的终端不会被中断。</p>
      <label>账号<input value={account} onChange={event => setAccount(event.target.value)} required disabled={busy} /></label>
      <label>密码<input type="password" autoFocus required value={password} onChange={event => setPassword(event.target.value)} disabled={busy} /></label>
      {error && <div className="remote-workspace-error" role="alert">{error}</div>}
      <div className="remote-workspace-actions">
        <button type="button" className="dialog-button" disabled={busy} onClick={onCancel}>取消</button>
        <button type="submit" className="dialog-button primary" disabled={busy}>
          {busy ? <LoaderCircle className="remote-workspace-spin" aria-hidden="true" /> : <LogIn aria-hidden="true" />}
          {busy ? '正在登录…' : '重新登录'}
        </button>
      </div>
    </form>
  </Dialog>;
}
