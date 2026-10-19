import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { reconnectBrowserAfterUpdate } from '../../services/sessionRestore';
import { getTerminalBuddyUpdateStatus, terminalBuddyUpdateText } from '../../services/browser/updateMonitor';
import {
  getTerminalBuddyUpdate,
  markTerminalUpdating,
  patchTerminalBuddyUpdate,
  subscribeTerminalBuddyUpdate,
} from '../../services/browser/updateState';
import './TerminalUpdateMonitor.css';

/** 独立于 PTY 和页签生命周期，服务切换后继续保留完整更新日志。 */
export function TerminalUpdateMonitor() {
  const update = useSyncExternalStore(subscribeTerminalBuddyUpdate, getTerminalBuddyUpdate);
  const [collapsed, setCollapsed] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);
  const followLogRef = useRef(true);
  const updateId = update?.id;

  useEffect(() => {
    setCollapsed(false);
    followLogRef.current = true;
  }, [updateId]);

  useEffect(() => {
    if (!updateId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let sawOutage = false;
    let healthyCount = 0;

    const reconnect = async () => {
      if (!(await reconnectBrowserAfterUpdate()) || stopped) return false;
      const current = getTerminalBuddyUpdate();
      if (current?.id !== updateId) return false;
      markTerminalUpdating(current.terminalId, false);
      patchTerminalBuddyUpdate(updateId, { reconnected: true });
      return true;
    };

    const poll = async () => {
      const current = getTerminalBuddyUpdate();
      if (stopped || !current || current.id !== updateId || current.reconnected) return;
      try {
        const result = await getTerminalBuddyUpdateStatus(updateId);
        if (stopped || getTerminalBuddyUpdate()?.reconnected) return;
        sawOutage = false;
        healthyCount = 0;
        patchTerminalBuddyUpdate(updateId, {
          online: true, status: result.status, serverLog: terminalBuddyUpdateText(result.log),
        });
        // 回退仍在重试时继续监视，不能把健康接口短暂可用当成更新完成。
        if (result.status === 'updated' || result.status === 'rolled-back') {
          if (await reconnect()) return;
        }
      } catch {
        if (stopped) return;
        patchTerminalBuddyUpdate(updateId, { online: false });
        // 回退到不提供更新接口的旧版本时，连续健康检查通过后恢复网页会话。
        if (current.phase === 'switch') {
          try {
            const health = await fetch('/api/health', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
            if (!health.ok) {
              sawOutage = true;
              healthyCount = 0;
            } else if (sawOutage && ++healthyCount >= 3) {
              patchTerminalBuddyUpdate(updateId, { online: true, status: 'recovered' });
              if (await reconnect()) return;
            }
          } catch {
            sawOutage = true;
            healthyCount = 0;
          }
        }
      }
      if (!stopped) timer = setTimeout(() => { void poll(); }, 2000);
    };

    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [updateId]);

  useEffect(() => {
    const element = logRef.current;
    if (element && followLogRef.current) element.scrollTop = element.scrollHeight;
  }, [update?.localLog, update?.serverLog, collapsed]);

  if (!update) return null;
  // 服务端日志已包含构建阶段，取代本地副本，避免重连回放造成重复日志。
  const log = update.serverLog || update.localLog;
  const status = update.status === 'failed'
    ? '更新失败，原服务保持运行'
    : update.reconnected
      ? update.status === 'rolled-back' ? '更新失败，已回退并重新连接' : update.status === 'recovered' ? '服务已恢复，终端已重新连接' : '更新完成，终端已重新连接'
      : update.status === 'rollback-failed'
        ? '回退未完成，正在继续恢复…'
        : update.status === 'updated' || update.status === 'rolled-back' || update.status === 'recovered'
          ? '服务已恢复，正在重新连接终端…'
          : update.online || update.phase === 'start' ? '更新中' : '服务暂不可用，持续自动重连…';

  const downloadLog = () => {
    const url = URL.createObjectURL(new Blob([log], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `terminal-buddy-update-${update.id}.log`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className={`terminal-update-monitor${collapsed ? ' is-collapsed' : ''}`}>
      <div className="terminal-update-header" role="status" aria-live="polite">
        <span className="terminal-update-dot" data-online={update.online} />
        <span className="terminal-update-title">
          {update.reconnected ? 'TerminalBuddy 更新日志' : `TerminalBuddy 正在自更新（${update.phase === 'start' ? '构建镜像' : '切换服务'}）`}
        </span>
        <span className="terminal-update-status">{status}</span>
        <button type="button" onClick={downloadLog}>下载日志</button>
        <button type="button" onClick={() => setCollapsed(value => !value)}>
          {collapsed ? '查看更新日志' : update.reconnected ? '继续使用终端' : '收起日志'}
        </button>
      </div>
      {!collapsed && (
        <pre className="terminal-update-log" ref={logRef} onScroll={() => {
          const element = logRef.current;
          if (element) followLogRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
        }}>{log || '正在等待更新日志…'}</pre>
      )}
    </div>
  );
}
