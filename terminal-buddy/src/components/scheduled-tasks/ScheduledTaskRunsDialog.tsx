import { useCallback, useEffect, useState } from 'react';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { History, LoaderCircle, Square } from 'lucide-react';
import { Dialog } from '../shared/Dialog';
import { useAppStore } from '../../stores/appStore';
import { aiSessionGet, listenTauri, scheduledTaskRuns, scheduledTaskStop } from '../../services/tauri';
import { openExistingAgentSession } from '../../utils/openAgentChat';
import {
  formatDuration,
  formatRunStatus,
  formatRunTime,
  formatTrigger,
  runTokenTotal,
} from '../../utils/scheduledTaskFormat';
import {
  SCHEDULED_TASK_RUN_EVENT,
  type ScheduledRun,
  type ScheduledTaskRunEvent,
  type ScheduledTaskView,
} from '../../types/scheduledTask';

interface ScheduledTaskRunsDialogProps {
  task: ScheduledTaskView;
  onClose: () => void;
  onChanged?: () => void;
}

function isActiveRun(run: ScheduledRun): boolean {
  return run.status === 'running' || run.status === 'waitingApproval';
}

export function ScheduledTaskRunsDialog({ task, onClose, onChanged }: ScheduledTaskRunsDialogProps) {
  const showToast = useAppStore(state => state.showToast);
  const [runs, setRuns] = useState<ScheduledRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyRun, setBusyRun] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await scheduledTaskRuns(task.id, 100);
      setRuns(next);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [task.id]);

  useEffect(() => {
    void load();
    // 运行中需要看到状态流转；频率与后端轮询一致。
    const timer = window.setInterval(() => { void load(); }, 5_000);
    let cancelled = false;
    const unlisteners: UnlistenFn[] = [];
    void listenTauri<ScheduledTaskRunEvent>(SCHEDULED_TASK_RUN_EVENT, event => {
      if (event.taskId === task.id) void load();
    }).then(unlisten => {
      if (cancelled) unlisten();
      else unlisteners.push(unlisten);
    });
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      unlisteners.forEach(unlisten => unlisten());
    };
  }, [load, task.id]);

  const stopRun = async (run: ScheduledRun) => {
    setBusyRun(run.id);
    try {
      await scheduledTaskStop(task.id);
      showToast('已请求停止任务', 'success');
      await load();
      onChanged?.();
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : String(reason), 'error');
    } finally {
      setBusyRun(null);
    }
  };

  const openSession = async (run: ScheduledRun) => {
    if (!run.sessionId) return;
    try {
      const session = await aiSessionGet(run.sessionId);
      openExistingAgentSession(session);
      onClose();
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : String(reason), 'error');
    }
  };

  const openTerminal = (run: ScheduledRun) => {
    if (!run.terminalId) return;
    const store = useAppStore.getState();
    if (store.sessions.some(session => session.id === run.terminalId)) {
      store.setActiveSession(run.terminalId);
      onClose();
    } else {
      showToast('对应终端已关闭', 'info');
    }
  };

  const completed = runs.filter(run => run.status === 'completed').length;
  const failed = runs.filter(run => run.status === 'failed' || run.status === 'timeout').length;
  const finished = runs.filter(run => run.finishedAt !== null);
  const average = finished.length === 0
    ? 0
    : finished.reduce((total, run) => total + Math.max(0, (run.finishedAt ?? 0) - run.startedAt), 0) / finished.length;
  const tokens = runs.reduce((total, run) => total + runTokenTotal(run), 0);

  return (
    <Dialog
      title={(
        <div className="st-dialog-title">
          <History className="st-dialog-title-icon" aria-hidden="true" />
          <span>运行记录</span>
          <small>{task.name}</small>
        </div>
      )}
      onClose={onClose}
      className="st-runs-dialog"
      bodyClassName="st-runs-body"
      footer={(
        <div className="st-dialog-footer">
          <span className="st-dialog-hint"><History aria-hidden="true" />每个任务自动保留最近 100 条运行记录</span>
          <button type="button" className="btn-secondary" onClick={onClose}>关闭</button>
        </div>
      )}
    >
      <div className="st-runs-kpi-row">
        <div className="st-runs-kpi-tile">
          <span>总执行次数</span>
          <b>{runs.length}</b>
        </div>
        <div className="st-runs-kpi-tile">
          <span>成功</span>
          <b className="ok">{completed}</b>
        </div>
        <div className="st-runs-kpi-tile">
          <span>失败 / 超时</span>
          <b className={failed > 0 ? 'fail' : undefined}>{failed}</b>
        </div>
        <div className="st-runs-kpi-tile">
          <span>平均耗时</span>
          <b>{formatDuration(average)}</b>
        </div>
        <div className="st-runs-kpi-tile">
          <span>累计 Token</span>
          <b>{tokens.toLocaleString('zh-CN')}</b>
        </div>
      </div>

      {error && <div className="st-error-banner" role="alert">{error}</div>}
      {loading ? (
        <div className="st-runs-empty"><LoaderCircle className="st-spin" aria-hidden="true" />正在加载运行记录…</div>
      ) : runs.length === 0 ? (
        <div className="st-runs-empty">还没有运行记录。可以点击任务卡片上的「立即运行」验证配置。</div>
      ) : (
        <div className="st-runs-table-wrap">
          <table className="st-run-table">
            <thead>
              <tr>
                <th>开始时间</th>
                <th>触发方式</th>
                <th>状态</th>
                <th>耗时</th>
                <th>执行摘要 / 错误信息</th>
                <th style={{ textAlign: 'right' }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {runs.map(run => {
                const status = formatRunStatus(run.status);
                const duration = run.finishedAt ? formatDuration(run.finishedAt - run.startedAt) : '—';
                const active = isActiveRun(run);
                return (
                  <tr key={run.id}>
                    <td className="st-run-time">{formatRunTime(run.startedAt)}</td>
                    <td className="st-run-trigger">{formatTrigger(run.trigger)}</td>
                    <td>
                      <span className={`st-status-pill ${status.tone}`}>
                        {active ? <span className="st-pulse" aria-hidden="true" /> : null}
                        {status.label}
                      </span>
                    </td>
                    <td className="st-run-duration">{duration}</td>
                    <td className={`st-run-message${run.status === 'failed' || run.status === 'timeout' ? ' fail' : ''}`}>
                      {run.message || '—'}
                      {runTokenTotal(run) > 0 && (
                        <span className="st-run-tokens"> · {runTokenTotal(run).toLocaleString('zh-CN')} tokens</span>
                      )}
                    </td>
                    <td className="st-run-action">
                      {active && task.target.kind === 'agentPrompt' && (
                        <button
                          type="button"
                          className="btn-danger-outline btn-sm st-run-btn"
                          disabled={busyRun === run.id}
                          onClick={() => void stopRun(run)}
                        >
                          {busyRun === run.id ? <LoaderCircle className="st-spin" aria-hidden="true" /> : <Square aria-hidden="true" />}
                          停止
                        </button>
                      )}
                      {run.sessionId && (
                        <button type="button" className="btn-secondary btn-sm st-run-btn" onClick={() => void openSession(run)}>打开会话</button>
                      )}
                      {run.terminalId && (
                        <button type="button" className="btn-secondary btn-sm st-run-btn" onClick={() => openTerminal(run)}>查看终端</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Dialog>
  );
}
