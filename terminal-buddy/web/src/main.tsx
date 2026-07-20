import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

// 早期挂一次 --vh，避免首屏出现 100vh 的"压缩"高度（iOS Safari / 某些 Android WebView）
if (typeof window !== 'undefined') {
  const vv = window.visualViewport;
  const h = vv?.height ?? window.innerHeight;
  if (Number.isFinite(h) && h > 0) {
    document.documentElement.style.setProperty('--vh', `${Math.round(h)}px`);
  }
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
