import { useState, type FormEvent } from 'react';
import { CheckCircle2, Cloud, LoaderCircle, LogOut, Monitor, ShieldCheck } from 'lucide-react';
import { Dialog } from '../shared/Dialog';
import type { RemoteWorkspaceState } from '../../services/remoteWorkspace/native';
import {
  connectRemoteWorkspace,
  disconnectRemoteWorkspace,
  enterRemoteWorkspace,
  RemoteTokenExpiredError,
  returnToLocalWorkspace,
} from '../../services/remoteWorkspace/session';
import './RemoteWorkspaceDialog.css';

interface Props {
  state: RemoteWorkspaceState;
  onClose: () => void;
}

export function RemoteWorkspaceDialog({ state, onClose }: Props) {
  const saved = state.connection;
  const [name, setName] = useState(saved?.name ?? '');
  const [server, setServer] = useState(saved?.server ?? '');
  const [username, setUsername] = useState(saved?.username ?? 'admin');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<'connect' | 'activate' | 'disconnect' | null>(null);
  const [error, setError] = useState('');

  const run = async (kind: 'connect' | 'activate' | 'disconnect', action: () => Promise<unknown | 'keep-open'>) => {
    setBusy(kind);
    setError('');
    try {
      // 令牌过期分支只切换界面，不重载页面；复位 busy 以便上层面板可交互。
      if (await action() === 'keep-open') { setBusy(null); return; }
      window.location.reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(null);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run('connect', () => connectRemoteWorkspace({
      name: name.trim(), server, username, password,
    }));
  };

  return (
    <Dialog title="工作区连接" onClose={busy ? () => {} : onClose} style={{ width: 520 }}>
      <div className="remote-workspace-dialog">
        <p className="remote-workspace-intro">连接远程 TerminalBuddy 服务，在 Windows 客户端中管理其终端、项目、文件、Git 与 AI 会话。</p>
        <div className={`remote-workspace-current ${state.active ? 'is-remote' : ''}`}>
          {state.active ? <Cloud aria-hidden="true" /> : <Monitor aria-hidden="true" />}
          <div>
            <strong>{state.active ? saved?.name : '本机工作区'}</strong>
            <span>{state.active ? saved?.server : '终端与文件操作均在此 Windows 电脑执行'}</span>
          </div>
          <span className="remote-workspace-current-badge">当前</span>
        </div>

        {saved && (
          <div className="remote-workspace-saved">
            <div className="remote-workspace-saved-title"><CheckCircle2 aria-hidden="true" /><span>已保存的远程连接</span></div>
            <div className="remote-workspace-saved-address">{saved.server}</div>
            <div className="remote-workspace-saved-actions">
              {state.active
                ? <button type="button" className="dialog-button" disabled={busy !== null} onClick={() => void run('activate', returnToLocalWorkspace)}><Monitor aria-hidden="true" />返回本机工作区</button>
                : <button type="button" className="dialog-button" disabled={busy !== null} onClick={() => void run('activate', async () => {
                  try { await enterRemoteWorkspace(); }
                  catch (reason) {
                    if (reason instanceof RemoteTokenExpiredError) {
                      window.dispatchEvent(new Event('terminal-buddy-remote-login-required'));
                      return 'keep-open' as const;
                    }
                    throw reason;
                  }
                })}><Cloud aria-hidden="true" />进入远程工作区</button>}
            </div>
          </div>
        )}

        <form className="remote-workspace-form" onSubmit={submit}>
          <div className="remote-workspace-section-title">{saved ? '更换服务或重新登录' : '添加远程服务'}</div>
          <label>连接名称（可选）<input value={name} onChange={event => setName(event.target.value)} placeholder="例如：飞牛 Docker" disabled={busy !== null} /></label>
          <label>服务地址<input value={server} onChange={event => setServer(event.target.value)} placeholder="https://192.168.1.10:9600" required disabled={busy !== null} /></label>
          <div className="remote-workspace-form-row">
            <label>账号<input value={username} onChange={event => setUsername(event.target.value)} required disabled={busy !== null} /></label>
            <label>密码<input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" required disabled={busy !== null} /></label>
          </div>
          <div className="remote-workspace-security"><ShieldCheck aria-hidden="true" />密码仅用于登录；登录令牌使用 Windows DPAPI 加密保存，不会写入页面存储。</div>
          {error && <div className="remote-workspace-error" role="alert">{error}</div>}
          <div className="remote-workspace-actions">
            {saved && <button type="button" className="dialog-button danger" disabled={busy !== null} onClick={() => void run('disconnect', disconnectRemoteWorkspace)}><LogOut aria-hidden="true" />{state.active ? '断开并删除登录' : '删除登录'}</button>}
            <button type="submit" className="dialog-button primary" disabled={busy !== null}>
              {busy === 'connect' ? <LoaderCircle className="remote-workspace-spin" aria-hidden="true" /> : <Cloud aria-hidden="true" />}
              {busy === 'connect' ? '正在连接…' : saved ? '重新登录并连接' : '连接远程服务'}
            </button>
          </div>
        </form>
      </div>
    </Dialog>
  );
}
