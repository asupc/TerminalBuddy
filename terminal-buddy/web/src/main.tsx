import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

// --vh 由 index.html 的内联 setVH 脚本在所有模块加载之前就同步执行（详见 index.html 注释）；
// App 挂载后 useVisualViewport 会接管监听器，避免双跑逻辑。

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
