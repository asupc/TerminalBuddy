import { useState } from 'react';
import { login } from '../api';
import { useStore } from '../store';

export default function Login() {
  const setAuth = useStore((s) => s.setAuth);
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      const { token, username: u } = await login(username.trim(), password);
      setAuth(token, u);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '登录失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="login-wrap" onSubmit={submit}>
      <div className="login-brand">
        <span className="login-mark" aria-hidden="true">&gt;_</span>
        <h1>TerminalBuddy</h1>
      </div>
      <div className="sub">远程终端</div>
      <div className="field">
        <label>用户名</label>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
      </div>
      <div className="field">
        <label>密码</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      <div className="err">{err}</div>
      <button className="btn primary" type="submit" disabled={busy}>
        {busy ? '登录中…' : '登录'}
      </button>
    </form>
  );
}
