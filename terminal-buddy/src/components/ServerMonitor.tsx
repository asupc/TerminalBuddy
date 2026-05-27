import { FC, useEffect, useRef, useState, useCallback } from 'react';
import { getServerStats } from '../services/tauri';
import type { ServerStats } from '../types';

interface ServerMonitorProps {
  terminalId: string;
  isSsh: boolean;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'K';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + 'M';
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + 'G';
}

function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec < 1024) return bytesPerSec.toFixed(0) + ' B/s';
  if (bytesPerSec < 1024 * 1024) return (bytesPerSec / 1024).toFixed(1) + ' KB/s';
  return (bytesPerSec / (1024 * 1024)).toFixed(1) + ' MB/s';
}

export const ServerMonitor: FC<ServerMonitorProps> = ({ terminalId, isSsh }) => {
  const [expanded, setExpanded] = useState(false);
  const [stats, setStats] = useState<ServerStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [interval, setInterval_] = useState(3);
  const [consecutiveErrors, setConsecutiveErrors] = useState(0);
  const timerRef = useRef<number | null>(null);

  const fetchStats = useCallback(async () => {
    try {
      const data = await getServerStats(terminalId);
      setStats(data);
      setError(null);
      setConsecutiveErrors(0);
    } catch (err) {
      setConsecutiveErrors(prev => prev + 1);
      if (consecutiveErrors >= 2) {
        setError('连接断开');
      }
    }
  }, [terminalId, consecutiveErrors]);

  useEffect(() => {
    if (!isSsh || !expanded || interval <= 0) {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      return;
    }

    fetchStats();
    timerRef.current = window.setInterval(fetchStats, interval * 1000);

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [isSsh, expanded, interval, fetchStats]);

  if (!isSsh) return null;

  const summary = stats
    ? `CPU ${stats.cpuUsage.toFixed(0)}% | Mem ${stats.memory.usagePercent.toFixed(0)}% | ${stats.disk[0] ? `Disk ${stats.disk[0].usagePercent.toFixed(0)}%` : ''} | ↑${formatSpeed(stats.network.txSpeed)} ↓${formatSpeed(stats.network.rxSpeed)}`
    : error || '加载中...';

  return (
    <div style={{
      borderTop: '1px solid var(--border-color, #3c3c3c)',
      background: 'var(--panel-bg, #252526)',
      fontSize: '12px',
      userSelect: 'none',
    }}>
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          padding: '4px 12px',
          cursor: 'pointer',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <span>
          <span style={{ marginRight: 6 }}>{expanded ? '▼' : '▶'}</span>
          <span style={{ color: error ? '#f44747' : '#4ec9b0', marginRight: 4 }}>●</span>
          {!expanded && <span>{summary}</span>}
        </span>
        {expanded && (
          <span style={{ color: '#808080', fontSize: '11px' }}>
            刷新间隔:
            <select
              value={interval}
              onChange={e => setInterval_(Number(e.target.value))}
              style={{
                background: '#3c3c3c',
                color: '#cccccc',
                border: '1px solid #555',
                borderRadius: 3,
                padding: '1px 4px',
                fontSize: '11px',
                marginLeft: 4,
              }}
            >
              <option value={1}>1s</option>
              <option value={3}>3s</option>
              <option value={5}>5s</option>
              <option value={10}>10s</option>
              <option value={0}>关闭</option>
            </select>
          </span>
        )}
      </div>
      {expanded && stats && (
        <div style={{ padding: '4px 12px 8px' }}>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', padding: '2px 0' }}>
            <span><span style={{ color: '#808080' }}>Uptime:</span> {stats.uptime}</span>
            <span><span style={{ color: '#808080' }}>CPU:</span> {stats.cpuUsage.toFixed(1)}%</span>
            <span><span style={{ color: '#808080' }}>Mem:</span> {formatBytes(stats.memory.used)}/{formatBytes(stats.memory.total)} ({stats.memory.usagePercent.toFixed(0)}%)</span>
            <span><span style={{ color: '#808080' }}>Swap:</span> {formatBytes(stats.memory.swapUsed)}/{formatBytes(stats.memory.swapTotal)}</span>
          </div>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', padding: '2px 0' }}>
            {stats.disk.slice(0, 2).map(d => (
              <span key={d.mount}>
                <span style={{ color: '#808080' }}>Disk {d.mount}:</span> {formatBytes(d.used)}/{formatBytes(d.total)} ({d.usagePercent.toFixed(0)}%)
              </span>
            ))}
            <span><span style={{ color: '#808080' }}>Net ↑:</span> {formatSpeed(stats.network.txSpeed)}</span>
            <span><span style={{ color: '#808080' }}>Net ↓:</span> {formatSpeed(stats.network.rxSpeed)}</span>
          </div>
        </div>
      )}
      {expanded && error && (
        <div style={{ padding: '4px 12px 8px', color: '#f44747' }}>{error}</div>
      )}
    </div>
  );
};
