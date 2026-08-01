import React from 'react';
import ReactDOM from 'react-dom/client';
import { getCurrentWindow } from '@tauri-apps/api/window';
import App from './App';
import { AiDeliveryApp } from "./components/ai-delivery/AiDeliveryApp";
import './styles/global.css';

// 禁用默认右键菜单（后退、刷新、另存为等）
document.addEventListener('contextmenu', (e) => e.preventDefault());

// 根据当前窗口 label 决定渲染主应用还是 AI 交付独立窗口
const currentLabel = getCurrentWindow().label;
const RootComponent = currentLabel === 'ai-delivery' ? AiDeliveryApp : App;

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <RootComponent />
  </React.StrictMode>
);
