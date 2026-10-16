import { useEffect, useState } from 'react';
import App from '../../App';
import { getToken, setToken, setServerPlatform, setWindowsBuildNumber, setDockerRuntime, setServerUsername } from '../../services/browser/connection';
import './WebEntry.css';

export default function WebEntry() {
  const [authenticated, setAuthenticated] = useState(Boolean(getToken()));
  const [ready, setReady] = useState(false);
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [setupRequired, setSetupRequired] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const runtimeRequest = fetch('/api/runtime').then(async response => {
      if (!response.ok) throw new Error('无法连接服务端，请先启动独立 Web 服务');
      if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('当前后端版本不支持完整网页界面，请启动此分支的独立服务端');
      const runtime = await response.json() as { platform: string; fullInterface?: boolean; windowsBuildNumber?: number | null; isDocker?: boolean };
      if (!runtime.fullInterface) throw new Error('服务端版本不支持完整网页界面，请启动此分支的服务端');
      setServerPlatform(runtime.platform);
      setWindowsBuildNumber(runtime.windowsBuildNumber ?? null);
      setDockerRuntime(runtime.isDocker === true);
    });
    const statusRequest = fetch('/api/auth/status').then(async response => {
      if (!response.ok) throw new Error('无法读取管理员初始化状态');
      const status = await response.json() as { setupRequired?: boolean; username?: string };
      if (cancelled) return;
      setSetupRequired(Boolean(status.setupRequired));
      setUsername(status.username || 'admin');
      setServerUsername(status.username || 'admin');
      if (status.setupRequired) { setToken(''); setAuthenticated(false); }
    });
    void Promise.all([runtimeRequest, statusRequest]).then(() => {
      if (!cancelled) setReady(true);
    }).catch((reason: unknown) => { if (!cancelled) setError(reason instanceof Error ? reason.message : '无法连接服务端'); });
    const expired = () => { setAuthenticated(false); setPassword(''); setError('登录已过期，请重新登录；服务器终端会话仍然保留'); };
    window.addEventListener('terminal-buddy-auth-expired', expired);
    return () => { cancelled = true; window.removeEventListener('terminal-buddy-auth-expired', expired); };
  }, []);

  if (ready && authenticated) return <App />;

  return <div className="web-login-shell">
    <form className="web-login-card" onSubmit={async event => {
      event.preventDefault(); setBusy(true); setError('');
      try {
        if (setupRequired) {
          if (password.trim().length === 0 || Array.from(password).length < 8) throw new Error('管理员密码至少需要 8 个字符');
          if (new TextEncoder().encode(password).length > 72) throw new Error('管理员密码过长，请缩短后重试');
          if (password !== confirmPassword) throw new Error('两次输入的密码不一致');
        }
        const response = await fetch(setupRequired ? '/api/auth/setup' : '/api/auth/login', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(setupRequired ? { password, confirmPassword } : { username, password }),
        });
        const body = await response.json() as { token?: string; message?: string };
        if (setupRequired && response.status === 409) {
          setSetupRequired(false); setPassword(''); setConfirmPassword('');
        }
        if (!response.ok || !body.token) throw new Error(body.message ?? (setupRequired ? '创建管理员失败' : '登录失败'));
        setToken(body.token);
        // 清理上一次登录的组件状态，再与后端存活终端对账。
        window.location.reload();
      } catch (reason) { setError(reason instanceof Error ? reason.message : '登录失败'); }
      finally { setBusy(false); }
    }}>
      <div className="web-login-logo">⌘</div>
      <h1>{setupRequired ? '创建管理员密码' : '终端伙伴'}</h1>
      <p>{setupRequired ? '首次启动，请为管理员设置密码。创建后即可进入完整工作界面。' : '登录后进入完整工作界面'}</p>
      <label>{setupRequired ? '管理员密码' : '密码'}<input type="password" autoComplete={setupRequired ? 'new-password' : 'current-password'} value={password} onChange={event => setPassword(event.target.value)} required disabled={busy || !ready} /></label>
      {setupRequired && <>
        <div className="web-login-hint">密码至少需要 8 个字符</div>
        <label>确认密码<input type="password" autoComplete="new-password" value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} required disabled={busy} /></label>
      </>}
      {error && <div role="alert" className="web-login-error">{error}</div>}
      <button disabled={!ready || busy} type="submit">{busy ? (setupRequired ? '正在创建…' : '正在登录…') : ready ? (setupRequired ? '创建管理员并进入' : '登录') : '等待服务连接'}</button>
    </form>
  </div>;
}
