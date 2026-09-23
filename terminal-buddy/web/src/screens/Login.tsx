import { useState } from 'react';
import { Eye, EyeOff, LockKeyhole, TerminalSquare, UserRound } from 'lucide-react';
import { login } from '../api';
import { useStore } from '../store';

export default function Login() {
  const setAuth = useStore((s) => s.setAuth);
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

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
    <main className="login-screen">
      <form className="login-panel" onSubmit={submit}>
        <div className="login-brand">
          <span className="login-mark" aria-hidden="true">
            <TerminalSquare size={24} strokeWidth={1.8} />
          </span>
          <div>
            <h1>Terminal Buddy</h1>
            <p>连接到你的远程终端</p>
          </div>
        </div>

        <div className="login-fields">
          <div className="field">
            <label htmlFor="username">用户名</label>
            <div className="field-control">
              <UserRound size={18} aria-hidden="true" />
              <input
                id="username"
                name="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                required
              />
            </div>
          </div>
          <div className="field">
            <label htmlFor="password">密码</label>
            <div className="field-control">
              <LockKeyhole size={18} aria-hidden="true" />
              <input
                id="password"
                name="password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
              <button
                className="field-action"
                type="button"
                onClick={() => setShowPassword((visible) => !visible)}
                aria-label={showPassword ? '隐藏密码' : '显示密码'}
                title={showPassword ? '隐藏密码' : '显示密码'}
              >
                {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </div>
        </div>

        <div className="err" role="alert" aria-live="polite">
          {err}
        </div>
        <button className="btn primary login-submit" type="submit" disabled={busy}>
          {busy ? '登录中…' : '登录'}
        </button>
      </form>
    </main>
  );
}
