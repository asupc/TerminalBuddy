import { useEffect, useState } from 'react';
import { Eye, EyeOff, LockKeyhole, TerminalSquare } from 'lucide-react';
import { getAuthStatus, login, setupAdmin } from '../api';
import { useStore } from '../store';

const DEFAULT_TITLE = 'Terminal Buddy';

export default function Login() {
  const setAuth = useStore((s) => s.setAuth);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  // 服务端状态：setupRequired（Docker 版首次）→ 创建管理员；username 免输入；
  // pageTitle 自定义标题（与完整界面的登录页保持一致）
  const [statusReady, setStatusReady] = useState(false);
  const [setupRequired, setSetupRequired] = useState(false);
  const [username, setUsername] = useState('admin');
  const [pageTitle, setPageTitle] = useState('');

  useEffect(() => {
    let cancelled = false;
    getAuthStatus()
      .then((status) => {
        if (cancelled) return;
        setSetupRequired(status.setupRequired);
        setUsername(status.username);
        setPageTitle(status.pageTitle);
      })
      .catch(() => {
        /* 状态拉取失败（旧后端/离线）时按默认登录表单继续 */
      })
      .finally(() => {
        if (!cancelled) setStatusReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 自定义标题同时作用于浏览器标签页
  useEffect(() => {
    document.title = pageTitle || DEFAULT_TITLE;
  }, [pageTitle]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      if (setupRequired) {
        if (password.trim().length < 8) throw new Error('管理员密码至少需要 8 个字符');
        if (password !== confirmPassword) throw new Error('两次输入的密码不一致');
        const result = await setupAdmin(password, confirmPassword);
        setAuth(result.token, result.username);
      } else {
        const result = await login(username.trim(), password);
        setAuth(result.token, result.username);
      }
    } catch (loginError) {
      setErr(loginError instanceof Error ? loginError.message : '登录失败');
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
            <h1>{setupRequired ? '创建管理员密码' : pageTitle || DEFAULT_TITLE}</h1>
            <p>{setupRequired ? '首次启动，请为管理员设置密码' : '连接到你的远程终端'}</p>
          </div>
        </div>

        <div className="login-fields">
          <div className="field">
            <label htmlFor="password">{setupRequired ? '管理员密码' : '密码'}</label>
            <div className="field-control">
              <LockKeyhole size={18} aria-hidden="true" />
              <input
                id="password"
                name="password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={setupRequired ? 'new-password' : 'current-password'}
                required
                disabled={busy || !statusReady}
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
          {setupRequired && (
            <div className="field">
              <label htmlFor="confirmPassword">确认密码</label>
              <div className="field-control">
                <LockKeyhole size={18} aria-hidden="true" />
                <input
                  id="confirmPassword"
                  name="confirmPassword"
                  type={showPassword ? 'text' : 'password'}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  autoComplete="new-password"
                  required
                  disabled={busy}
                />
              </div>
              <small className="field-hint">密码至少需要 8 个字符</small>
            </div>
          )}
        </div>

        <div className="err" role="alert" aria-live="polite">
          {err}
        </div>
        <button className="btn primary login-submit" type="submit" disabled={busy || !statusReady}>
          {busy
            ? setupRequired
              ? '正在创建…'
              : '登录中…'
            : statusReady
              ? setupRequired
                ? '创建并进入'
                : '登录'
              : '等待服务连接'}
        </button>
      </form>
    </main>
  );
}
