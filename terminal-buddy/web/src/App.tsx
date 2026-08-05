import { useEffect } from 'react';
import { useStore } from './store';
import { useDualPane } from './hooks/useMediaQuery';
import { useVisualViewport } from './hooks/useVisualViewport';
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
  const dualPane = useDualPane();
  const navCollapsed = useStore((s) => s.navCollapsed);
  const setNavCollapsed = useStore((s) => s.setNavCollapsed);

  // 同步 --vh 到 visualViewport，让 --vh 跟随软键盘实时收紧；详见 hook 注释
  useVisualViewport();

  // 单列 + 未进入 terminal：若 navCollapsed=true 自动展开（没有主区可看）
  useEffect(() => {
    if (!dualPane && view.screen === 'nav' && navCollapsed) {
      setNavCollapsed(false);
    }
  }, [dualPane, view.screen, navCollapsed, setNavCollapsed]);

  if (!token) return <Login />;

  // ≥960px：侧边栏（Nav）+ 主区（Terminal 或占位）并排；navCollapsed 控制 sidebar 折叠
  if (dualPane) {
    return (
      <div className={`app-dual-pane${navCollapsed ? ' nav-collapsed' : ''}`}>
        <aside className="app-sidebar">
          <Nav variant="sidebar" />
        </aside>
        <main className="app-main">
          {view.screen === 'terminal' ? (
            <Terminal
              terminalId={view.terminalId}
              profileName={view.profileName}
              loadingMode={view.loadingMode}
              owner={view.owner}
            />
          ) : (
            <div className="main-placeholder">
              <span>选择左侧的连接开始</span>
              {navCollapsed && (
                <button
                  type="button"
                  className="btn primary placeholder-expand-btn"
                  onClick={() => setNavCollapsed(false)}
                >
                  展开导航
                </button>
              )}
            </div>
          )}
        </main>
      </div>
    );
  }

  // <960px：单列全屏切换
  if (view.screen === 'terminal') {
    return (
      <Terminal
        terminalId={view.terminalId}
        profileName={view.profileName}
        loadingMode={view.loadingMode}
        owner={view.owner}
      />
    );
  }
  return <Nav />;
}
