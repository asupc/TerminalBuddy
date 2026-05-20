import React, { useState } from 'react';
import { login } from '../api/auth';
import { getApiStatus } from '../api/auth';
import { useWebAppStore } from '../stores/appStore';

const LoginPage: React.FC = () => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const setAuth = useWebAppStore((s) => s.setAuth);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const status = await getApiStatus();
      if (!status.enabled) {
        setError('Web API 服务未启用');
        return;
      }
      const result = await login(username, password);
      setAuth(result.token, result.username);
    } catch (err: any) {
      setError(err.response?.data?.message || '登录失败，请检查用户名和密码');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
    }}>
      <form onSubmit={handleSubmit} style={{
        background: '#1e1e3a', border: '1px solid #3a3a5a', borderRadius: 12,
        padding: 40, width: 360, boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
      }}>
        <h1 style={{ textAlign: 'center', marginBottom: 8, fontSize: 22, color: '#a0a0ff' }}>
          TerminalBuddy
        </h1>
        <p style={{ textAlign: 'center', color: '#7a7a9a', fontSize: 13, marginBottom: 32 }}>
          Web 远程终端管理
        </p>
        <label style={{ display: 'block', fontSize: 13, color: '#8a8aaa', marginBottom: 6 }}>用户名</label>
        <input
          type="text" value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="请输入用户名"
          style={{ marginBottom: 20 }}
        />
        <label style={{ display: 'block', fontSize: 13, color: '#8a8aaa', marginBottom: 6 }}>密码</label>
        <input
          type="password" value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="请输入密码"
          style={{ marginBottom: 24 }}
        />
        <button type="submit" disabled={loading} style={{
          width: '100%', padding: 12, border: 'none', borderRadius: 8,
          background: 'linear-gradient(135deg, #5b5bb5, #4a4aaa)',
          color: '#fff', fontSize: 15, opacity: loading ? 0.7 : 1,
        }}>
          {loading ? '登录中...' : '登 录'}
        </button>
        {error && (
          <p style={{ color: '#ff6b6b', fontSize: 13, textAlign: 'center', marginTop: 12 }}>{error}</p>
        )}
      </form>
    </div>
  );
};

export default LoginPage;
