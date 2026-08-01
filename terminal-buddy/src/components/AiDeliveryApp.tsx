import { useCallback, useEffect, useState } from 'react';
import { Bot, Minus, Square, X } from 'lucide-react';
import { listen } from '@tauri-apps/api/event';
import { AiDeliveryNav } from './AiDeliveryNav';
import { AiDeliveryWorkspace, type AiDeliveryConfigView } from './AiDeliveryWorkspace';
import { windowMinimize, windowToggleMaximize, windowClose, detectAiRuntimes } from '../services/tauri';
import { initTheme, applyTheme, initAppSettings, applyListSelectionStyle, getAppSettings } from '../utils/settings';
import type { AiRuntimeProbe } from '../types/aiDelivery';
import { GlobalDialogHost } from './GlobalDialogHost';
import { Toast } from './Toast';
import './AiDeliveryApp.css';

/** AI 交付独立窗口根组件。
 *
 * 与主窗口独立运行：窗口可以随时关闭，后台 AI 交付任务不受影响。
 * 再次打开时自动恢复全部状态（项目、交付、任务进度等）。 */
export function AiDeliveryApp() {
  const [aiDeliveryConfigView, setAiDeliveryConfigView] = useState<AiDeliveryConfigView | null>(null);
  const [aiDeliveryNotificationTargetId, setAiDeliveryNotificationTargetId] = useState('');
  const [aiRuntimeProbes, setAiRuntimeProbes] = useState<AiRuntimeProbe[]>([]);
  const [isAiRuntimeDetecting, setIsAiRuntimeDetecting] = useState(true);
  const [aiRuntimeDetectionError, setAiRuntimeDetectionError] = useState('');

  // ---- 初始化主题与设置 ----
  useEffect(() => {
    void (async () => {
      const theme = await initTheme();
      applyTheme(theme);
      await initAppSettings();
      applyListSelectionStyle(getAppSettings());
    })();
  }, []);

  // ---- AI Runtime 探测 ----
  const detectLocalAiRuntimes = useCallback(async () => {
    setIsAiRuntimeDetecting(true);
    try {
      setAiRuntimeDetectionError('');
      setAiRuntimeProbes(await detectAiRuntimes());
    } catch (reason) {
      setAiRuntimeProbes([]);
      setAiRuntimeDetectionError(String(reason));
    } finally {
      setIsAiRuntimeDetecting(false);
    }
  }, []);

  useEffect(() => {
    void detectLocalAiRuntimes();
  }, [detectLocalAiRuntimes]);

  // ---- 通知跳转处理 ----
  // 窗口刚打开时（从通知唤起），从 localStorage 读取待处理的通知目标
  useEffect(() => {
    const pending = localStorage.getItem('aiDelivery.pendingNotificationId');
    if (pending) {
      localStorage.removeItem('aiDelivery.pendingNotificationId');
      setAiDeliveryNotificationTargetId(pending);
    }
  }, []);

  // 窗口已打开时，监听实时通知事件直接跳转
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<string>('ai-delivery-notification-activated', (event) => {
      localStorage.removeItem('aiDelivery.pendingNotificationId');
      setAiDeliveryNotificationTargetId(event.payload);
    }).then((cleanup) => {
      unlisten = cleanup;
    });
    return () => unlisten?.();
  }, []);

  // ESC 关闭配置弹窗
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return;
      setAiDeliveryConfigView(null);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  // 列表选中样式跟随主题
  useEffect(() => {
    const apply = () => applyListSelectionStyle(getAppSettings());
    window.addEventListener('app-settings-changed', apply);
    window.addEventListener('app-theme-changed', apply);
    return () => {
      window.removeEventListener('app-settings-changed', apply);
      window.removeEventListener('app-theme-changed', apply);
    };
  }, []);

  return (
    <div className="ai-delivery-app">
      <div className="ai-delivery-app-titlebar" data-tauri-drag-region="deep">
        <div className="ai-delivery-app-titlebar-left">
          <Bot size={16} aria-hidden="true" />
          <span className="ai-delivery-app-titlebar-title">AI 交付</span>
        </div>
        <div className="ai-delivery-app-titlebar-controls">
          <button
            type="button"
            className="ai-delivery-app-window-btn"
            onClick={() => void windowMinimize()}
            title="最小化"
            aria-label="最小化窗口"
          >
            <Minus size={14} />
          </button>
          <button
            type="button"
            className="ai-delivery-app-window-btn"
            onClick={() => void windowToggleMaximize()}
            title="最大化"
            aria-label="最大化窗口"
          >
            <Square size={12} />
          </button>
          <button
            type="button"
            className="ai-delivery-app-window-btn ai-delivery-app-close-btn"
            onClick={() => void windowClose()}
            title="关闭"
            aria-label="关闭窗口"
          >
            <X size={14} />
          </button>
        </div>
      </div>
      <div className="ai-delivery-app-body">
        <AiDeliveryNav
          runtimes={aiRuntimeProbes}
          isDetecting={isAiRuntimeDetecting}
          error={aiRuntimeDetectionError}
          onDetect={detectLocalAiRuntimes}
          onOpenConfiguration={setAiDeliveryConfigView}
        />
        <AiDeliveryWorkspace
          runtimes={aiRuntimeProbes}
          isRuntimeDetecting={isAiRuntimeDetecting}
          notificationTargetDeliveryId={aiDeliveryNotificationTargetId}
          onNotificationTargetHandled={() => setAiDeliveryNotificationTargetId('')}
          configDialogView={aiDeliveryConfigView}
          onConfigDialogViewChange={setAiDeliveryConfigView}
        />
      </div>
      <GlobalDialogHost />
      <Toast />
    </div>
  );
}
