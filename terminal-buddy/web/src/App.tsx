import { useStore } from './store';
import Login from './screens/Login';
import Nav from './screens/Nav';
import Terminal from './screens/Terminal';

// 解码 JWT payload 取 sub（用户名），失败返回 null。
function decodeJwtSub(token: string): string | null {
  try {
    const payload = token.split('.')[1];
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    return (JSON.parse(json).sub as string) ?? null;
  } catch {
    return null;
  }
}

// 免密快速访问：URL 带 ?token=<jwt> 时（PC 端生成的二维码/链接携带）直接登录，
// 随后抹掉 URL 里的 token 防泄露。模块加载时执行一次，避免登录页闪烁。
function applyUrlTokenOnce() {
  const urlToken = new URLSearchParams(window.location.search).get('token');
  if (!urlToken) return;
  const username = decodeJwtSub(urlToken) ?? 'web';
  useStore.getState().setAuth(urlToken, username);
  window.history.replaceState({}, '', window.location.pathname);
}

applyUrlTokenOnce();

export default function App() {
  const token = useStore((s) => s.token);
  const view = useStore((s) => s.view);

  if (!token) return <Login />;
  if (view.screen === 'terminal') {
    return (
      <Terminal
        terminalId={view.terminalId}
        profileName={view.profileName}
        owner={view.owner}
      />
    );
  }
  return <Nav />;
}
