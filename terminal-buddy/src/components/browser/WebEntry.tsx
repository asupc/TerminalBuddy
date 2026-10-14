import { useEffect, useState } from 'react';
import App from '../../App';
import { getToken, setToken, setServerPlatform } from '../../services/browser/connection';
import './WebEntry.css';

export default function WebEntry() {
  const [authenticated, setAuthenticated] = useState(Boolean(getToken()));
  const [ready, setReady] = useState(false);
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/runtime').then(async response => {
      if (!response.ok) throw new Error('无法连接服务端，请先启动独立 Web 服务');
      if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('当前后端版本不支持完整网页界面，请启动此分支的独立服务端');
      const runtime = await response.json() as { platform: string; fullInterface?: boolean };
      if (!runtime.fullInterface) throw new Error('服务端版本不支持完整网页界面，请启动此分支的服务端');
      setServerPlatform(runtime.platform);
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
        const response = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
        const body = await response.json() as { token?: string; message?: string };
        if (!response.ok || !body.token) throw new Error(body.message ?? '登录失败');
        setToken(body.token);
        // 清理上一次登录的组件状态，再与后端存活终端对账。
        window.location.reload();
      } catch (reason) { setError(reason instanceof Error ? reason.message : '登录失败'); }
      finally { setBusy(false); }
    }}>
      <div className="web-login-logo">⌘</div>
      <h1>终端伙伴</h1><p>登录后进入完整工作界面</p>
      <label>用户名<input autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} required /></label>
      <label>密码<input type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required /></label>
      {error && <div role="alert" className="web-login-error">{error}</div>}
      <button disabled={!ready || busy} type="submit">{busy ? '正在登录…' : ready ? '登录' : '等待服务连接'}</button>
    </form>
  </div>;
}
