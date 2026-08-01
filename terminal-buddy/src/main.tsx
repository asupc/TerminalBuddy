import React from 'react';
import ReactDOM from 'react-dom/client';
import { getCurrentWindow } from '@tauri-apps/api/window';
import App from './App';
import { AiDeliveryApp } from "./components/ai-delivery/AiDeliveryApp";
import './styles/global.css';

// Disable default context menu (back, refresh, save as, etc.)
document.addEventListener('contextmenu', (e) => e.preventDefault());

// 根据当前窗口 label 决定渲染主应用还是 AI 交付独立窗口
const currentLabel = getCurrentWindow().label;
const RootComponent = currentLabel === 'ai-delivery' ? AiDeliveryApp : App;

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <RootComponent />
  </React.StrictMode>
);
