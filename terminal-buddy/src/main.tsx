// 必须是第一个 import：局域网 http:// 访问属于非安全上下文，
// crypto.randomUUID / navigator.clipboard 缺失会让「启动终端」与复制按钮静默失败。
import './services/browser/cryptoShim';
import React, { lazy, Suspense } from 'react';
import ReactDOM from 'react-dom/client';
import './mock/setupMock';
import App from './App';
import WebEntry from './components/browser/WebEntry';
import { installBrowserKeyGuard } from './services/browserKeys';
import { installRendererMemoryGuard } from './utils/rendererMemoryGuard';
import { isBrowserClient } from './services/platform';
import './styles/global.css';
import './styles/cartoonAnime1.css';
import './components/browser/WebEntry.css';

// 桌面工作区入口仅桌面构建会渲染；browser / browser-demo 走 WebEntry。
// 通过懒加载隔离，桌面入口的 chunk 不会进入浏览器首屏执行路径。
const RemoteWorkspaceEntry = lazy(() =>
  import('./components/remote/RemoteWorkspaceEntry')
    .then(module => ({ default: module.RemoteWorkspaceEntry })));

// 输入框保留原生编辑菜单，支持密码粘贴等操作；其它区域禁用默认右键菜单。
document.addEventListener('contextmenu', (e) => {
  const target = e.target;
  if (target instanceof HTMLElement
    && (target.closest('input, textarea, [data-native-context-menu]') || target.isContentEditable)) return;
  e.preventDefault();
});

// 屏蔽 WebView2 的浏览器快捷键（F5 / Ctrl+R / Ctrl+Shift+R 刷新等）：刷新会重建页面，
// 所有终端会话与未保存内容都会丢失
installBrowserKeyGuard();
// WebView2 渲染进程 OOM 会导致 Tauri 事件在浏览器进程里无界堆积（曾达 10GB）。
// 超阈值时先压缩终端回滚，仍不回落则整页刷新，避免进程崩溃后内存不释放。
installRendererMemoryGuard();

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    {isBrowserClient()
      ? <WebEntry />
      : import.meta.env.MODE === 'browser-demo'
        ? <App />
        : <Suspense fallback={null}><RemoteWorkspaceEntry /></Suspense>}
    {import.meta.env.MODE === 'browser-demo' && <div className="web-demo-label">界面演示 · 使用示例数据，未连接真实终端</div>}
  </React.StrictMode>
);
