import './mock/setupMock';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import WebEntry from './components/browser/WebEntry';
import { installBrowserKeyGuard } from './services/browserKeys';
import './styles/global.css';
import './styles/cartoonAnime1.css';
import './components/browser/WebEntry.css';

// 禁用默认右键菜单（后退、刷新、另存为等）
document.addEventListener('contextmenu', (e) => e.preventDefault());

// 屏蔽 WebView2 的浏览器快捷键（F5 / Ctrl+R / Ctrl+Shift+R 刷新等）：刷新会重建页面，
// 所有终端会话与未保存内容都会丢失
installBrowserKeyGuard();

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    {import.meta.env.MODE === 'browser' ? <WebEntry /> : <App />}
    {import.meta.env.MODE === 'browser-demo' && <div className="web-demo-label">界面演示 · 使用示例数据，未连接真实终端</div>}
  </React.StrictMode>
);
