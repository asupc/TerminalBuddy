import { useEffect, useRef, useState } from 'react';
import { supportsSystemExplorerOpen } from '../../services/platform';
import {
  AlertTriangle,
  Check,
  FolderOpen,
  LoaderCircle,
  RefreshCw,
  SquareTerminal,
  Trash2,
} from 'lucide-react';
import {
  getClaudeHookSettingsStatus,
  openInExplorer,
  saveClaudeHookConfigDir,
  uninstallClaudeHooks,
  type ClaudeHookSettingsStatus,
} from '../../services/tauri';
import { useAppStore } from '../../stores/appStore';
import { getAppSettings, saveAppSettings, type AppSettings } from '../../utils/settings';
import { ConfirmDialog } from '../shared/Dialog';
import './HookSettings.css';

interface HookSettingsProps {
  settings: AppSettings;
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
}

const HOOK_CAPABILITIES = [
  { key: 'sessionStart', label: '会话识别' },
  { key: 'running', label: '运行状态' },
  { key: 'attention', label: '等待处理' },
  { key: 'decision', label: '结构化决策' },
  { key: 'completion', label: '任务完成' },
  { key: 'failure', label: '执行失败' },
  { key: 'sessionEnd', label: '会话结束' },
] as const;

/** 用户级 settings.json 中旧版 Hook 的残留状态；`notInstalled` 表示无残留（干净）。 */
const STATUS_LABELS: Record<ClaudeHookSettingsStatus['status'], string> = {
  installed: '发现旧版残留',
  partialInstalled: '发现旧版残留',
  notInstalled: '已内置',
  invalid: '配置异常',
};

function clampDelay(value: string): number {
  return Math.min(3600, Math.max(0, Number(value) || 0));
}

function normalizeConfigDir(value: string): string {
  return value.trim();
}

export function HookSettings({ settings, updateSetting }: HookSettingsProps) {
  const showToast = useAppStore(state => state.showToast);
  const [status, setStatus] = useState<ClaudeHookSettingsStatus | null>(null);
  const [configDir, setConfigDir] = useState(settings.claudeHookConfigDir);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState<'cleanup' | null>(null);
  const [error, setError] = useState('');
  const [confirmCleanup, setConfirmCleanup] = useState(false);
  const statusRequestRef = useRef(0);
  const configDirRef = useRef(configDir);
  const committedConfigDirRef = useRef(normalizeConfigDir(configDir));
  const lastSettingsConfigDirRef = useRef(normalizeConfigDir(settings.claudeHookConfigDir));
  const configSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const initialConfigSaveRef = useRef<Promise<void> | null>(null);
  const configCommitRef = useRef(0);
  const draftDirtyRef = useRef(false);
  const mountedRef = useRef(true);

  const enqueueConfigDirSave = (directory: string): Promise<void> => {
    const operation = configSaveQueueRef.current
      .catch(() => undefined)
      .then(() => saveClaudeHookConfigDir(directory || undefined));
    configSaveQueueRef.current = operation.then(() => undefined, () => undefined);
    return operation;
  };

  const refreshStatus = async (directory = configDir) => {
    if (!mountedRef.current) return;
    const normalizedDirectory = normalizeConfigDir(directory);
    const requestId = ++statusRequestRef.current;
    setLoading(true);
    setError('');
    try {
      const next = await getClaudeHookSettingsStatus(normalizedDirectory || undefined);
      if (!mountedRef.current || requestId !== statusRequestRef.current) return;
      setStatus(next);
      if (!normalizedDirectory && !draftDirtyRef.current) {
        const resolvedDirectory = normalizeConfigDir(next.configDir);
        configDirRef.current = resolvedDirectory;
        committedConfigDirRef.current = resolvedDirectory;
        setConfigDir(resolvedDirectory);
      }
    } catch (reason) {
      if (!mountedRef.current || requestId !== statusRequestRef.current) return;
      setError(String(reason));
    } finally {
      if (mountedRef.current && requestId === statusRequestRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      statusRequestRef.current += 1;
      if (!draftDirtyRef.current) return;

      const normalized = normalizeConfigDir(configDirRef.current);
      draftDirtyRef.current = false;
      committedConfigDirRef.current = normalized;
      saveAppSettings({ ...getAppSettings(), claudeHookConfigDir: normalized });
      void enqueueConfigDirSave(normalized).catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const requestedDirectory = normalizeConfigDir(configDirRef.current);
    const requestId = ++statusRequestRef.current;
    if (requestedDirectory && !initialConfigSaveRef.current) {
      initialConfigSaveRef.current = enqueueConfigDirSave(requestedDirectory);
    }
    const persistInitialDirectory = initialConfigSaveRef.current ?? Promise.resolve();
    void persistInitialDirectory
      .then(() => getClaudeHookSettingsStatus(requestedDirectory || undefined))
      .then(next => {
        if (cancelled || !mountedRef.current || requestId !== statusRequestRef.current || draftDirtyRef.current) return;
        const resolvedDirectory = requestedDirectory || normalizeConfigDir(next.configDir);
        setStatus(next);
        configDirRef.current = resolvedDirectory;
        committedConfigDirRef.current = resolvedDirectory;
        setConfigDir(resolvedDirectory);
      })
      .catch(reason => {
        if (!cancelled && mountedRef.current && requestId === statusRequestRef.current && !draftDirtyRef.current) {
          setError(String(reason));
        }
      })
      .finally(() => {
        if (!cancelled && mountedRef.current && requestId === statusRequestRef.current) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const incomingDirectory = normalizeConfigDir(settings.claudeHookConfigDir);
    if (incomingDirectory === lastSettingsConfigDirRef.current) return;

    lastSettingsConfigDirRef.current = incomingDirectory;
    committedConfigDirRef.current = incomingDirectory;
    const currentDirectory = normalizeConfigDir(configDirRef.current);
    if (draftDirtyRef.current && currentDirectory !== incomingDirectory) return;

    draftDirtyRef.current = false;
    configDirRef.current = incomingDirectory;
    setConfigDir(incomingDirectory);
    const requestId = ++statusRequestRef.current;
    setLoading(true);
    setError('');
    void (async () => {
      try {
        if (incomingDirectory) await enqueueConfigDirSave(incomingDirectory);
      } catch (reason) {
        if (
          mountedRef.current
          && requestId === statusRequestRef.current
          && normalizeConfigDir(configDirRef.current) === incomingDirectory
        ) {
          setError(`保存配置目录失败：${String(reason)}`);
          setLoading(false);
        }
        return;
      }

      if (
        mountedRef.current
        && requestId === statusRequestRef.current
        && !draftDirtyRef.current
        && normalizeConfigDir(configDirRef.current) === incomingDirectory
      ) {
        await refreshStatus(incomingDirectory);
      } else if (mountedRef.current && requestId === statusRequestRef.current) {
        setLoading(false);
      }
    })();
  }, [settings.claudeHookConfigDir]);

  const commitConfigDir = async (
    directory: string,
    shouldRefresh = true,
    forceSave = false,
  ): Promise<boolean> => {
    const normalized = normalizeConfigDir(directory);
    const statusGeneration = statusRequestRef.current;
    const previousCommittedDirectory = committedConfigDirRef.current;
    const shouldSave = forceSave || draftDirtyRef.current || normalized !== committedConfigDirRef.current;

    configDirRef.current = normalized;
    committedConfigDirRef.current = normalized;
    draftDirtyRef.current = false;
    setConfigDir(normalized);

    if (shouldSave) {
      const commitId = ++configCommitRef.current;
      try {
        await enqueueConfigDirSave(normalized);
      } catch (reason) {
        if (commitId === configCommitRef.current) {
          const currentDirectory = normalizeConfigDir(configDirRef.current);
          committedConfigDirRef.current = previousCommittedDirectory;
          draftDirtyRef.current = currentDirectory !== previousCommittedDirectory;
          if (mountedRef.current && currentDirectory === normalized) {
            const message = String(reason);
            setError(`保存配置目录失败：${message}`);
            showToast(`保存 Claude Code 配置目录失败：${message}`, 'error');
          }
        }
        return false;
      }
      lastSettingsConfigDirRef.current = normalized;
      updateSetting('claudeHookConfigDir', normalized);
      if (commitId === configCommitRef.current) {
        draftDirtyRef.current = normalizeConfigDir(configDirRef.current) !== normalized;
      }
    }

    if (
      shouldRefresh
      && mountedRef.current
      && statusGeneration === statusRequestRef.current
      && normalizeConfigDir(configDirRef.current) === normalized
    ) {
      await refreshStatus(normalized);
    }
    return true;
  };

  /** 清理旧版写进用户级 settings.json 的 Hook 残留（新版随模型终端临时注入，无需安装）。 */
  const cleanup = async () => {
    const requestId = ++statusRequestRef.current;
    setLoading(false);
    setConfirmCleanup(false);
    setWorking('cleanup');
    setError('');
    try {
      const directory = normalizeConfigDir(configDirRef.current);
      if (!await commitConfigDir(directory, false, true)) return;
      const next = await uninstallClaudeHooks(directory || undefined);
      if (!mountedRef.current || requestId !== statusRequestRef.current) return;
      setStatus(next);
      showToast('已清理旧版 Hook 残留', 'success');
    } catch (reason) {
      if (!mountedRef.current || requestId !== statusRequestRef.current) return;
      const message = String(reason);
      setError(message);
      showToast(`清理 Claude Code Hook 残留失败：${message}`, 'error');
    } finally {
      if (mountedRef.current && requestId === statusRequestRef.current) {
        setWorking(null);
        setLoading(false);
      }
    }
  };

  const revealInvalidSettings = async () => {
    if (!status?.settingsPath) return;
    if (!supportsSystemExplorerOpen()) {
      showToast('浏览器模式暂不支持打开本地文件夹', 'info');
      return;
    }
    try {
      await openInExplorer(status.settingsPath);
    } catch (reason) {
      const message = String(reason);
      setError(`定位 settings.json 失败：${message}`);
      showToast(`定位 Claude Code settings.json 失败：${message}`, 'error');
    }
  };

  const hasLeftovers = (status?.installedEvents.length ?? 0) > 0;
  const displayedError = error || (status?.status === 'invalid' ? '' : status?.error ?? '');

  return (
    <div className="hook-settings">
      <div className="hook-provider-tabs" role="tablist" aria-label="Hook 提供方">
        <button
          id="claude-hook-provider-tab"
          type="button"
          className="hook-provider-tab active"
          role="tab"
          aria-selected="true"
          aria-controls="claude-hook-provider-panel"
        >
          <SquareTerminal size={15} aria-hidden="true" />
          <span>Claude Code</span>
        </button>
      </div>

      <div
        id="claude-hook-provider-panel"
        className="hook-provider-panel"
        role="tabpanel"
        aria-labelledby="claude-hook-provider-tab"
      >
      <div className="hook-status-panel" aria-busy={loading || working !== null}>
        <div className="hook-status-heading">
          <div className="hook-status-title">
            <span>Hook 桥接</span>
            {loading ? (
              <span className="hook-status-badge neutral"><LoaderCircle className="spin" size={13} aria-hidden="true" />检测中</span>
            ) : status ? (
              <span className={`hook-status-badge ${status.status === 'invalid' ? 'invalid' : hasLeftovers ? 'partialInstalled' : 'installed'}`}>
                {hasLeftovers || status.status === 'invalid' ? <AlertTriangle size={13} aria-hidden="true" /> : <Check size={13} aria-hidden="true" />}
                {STATUS_LABELS[status.status]}
              </span>
            ) : null}
          </div>
          <div className="hook-status-actions">
            <button
              type="button"
              className="hook-icon-button"
              title="刷新 Hook 状态"
              aria-label="刷新 Hook 状态"
              disabled={loading || working !== null}
              onClick={() => void refreshStatus()}
            >
              <RefreshCw size={15} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="hook-action-button danger"
              disabled={loading || working !== null || !hasLeftovers || status?.status === 'invalid'}
              onClick={() => setConfirmCleanup(true)}
            >
              {working === 'cleanup' ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : <Trash2 size={15} aria-hidden="true" />}
              清理残留
            </button>
          </div>
        </div>

        <p className="settings-desc">Hook 随模型终端的临时启动配置自动注入，不再修改 Claude Code 用户级 settings.json。</p>

        <div className="hook-capability-list" role="list" aria-label="Hook 模块状态">
          {HOOK_CAPABILITIES.map(capability => (
            <span key={capability.key} className="installed" role="listitem">
              <Check size={12} aria-hidden="true" />
              <span>{capability.label}</span>
              <span className="hook-sr-only">，已启用</span>
            </span>
          ))}
        </div>

        <div className={`hook-server-state ${status?.serverRunning ? 'online' : 'offline'}`}>
          <span aria-hidden="true" />
          本地桥接服务{status?.serverRunning ? `运行中（127.0.0.1:${status.serverPort}）` : '未运行'}
        </div>
        {status?.status === 'invalid' && (
          <div className="hook-invalid-help" role="alert">
            <div className="hook-invalid-heading">
              <AlertTriangle size={16} aria-hidden="true" />
              <div>
                <strong>settings.json 无法解析</strong>
                <p>TerminalBuddy 不会覆盖损坏的 JSON。请先修复文件内容，再刷新 Hook 状态。</p>
              </div>
            </div>
            <code title={status.settingsPath}>{status.settingsPath}</code>
            {status.error && <p className="hook-invalid-detail">{status.error}</p>}
            <button type="button" className="hook-action-button" onClick={() => void revealInvalidSettings()}>
              <FolderOpen size={15} aria-hidden="true" />
              定位 settings.json
            </button>
          </div>
        )}
        {displayedError && <p className="hook-error" role="alert">{displayedError}</p>}
      </div>

      <div className="settings-section">
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={settings.claudeDecisionNotifications}
            onChange={event => updateSetting('claudeDecisionNotifications', event.target.checked)}
          />
          <span>等待处理通知</span>
        </label>
        <div className="hook-delay-row">
          <label htmlFor="claude-decision-delay">通知延迟</label>
          <input
            id="claude-decision-delay"
            type="number"
            min="0"
            max="3600"
            disabled={!settings.claudeDecisionNotifications}
            value={settings.claudeDecisionNotificationDelaySeconds}
            onChange={event => updateSetting('claudeDecisionNotificationDelaySeconds', clampDelay(event.target.value))}
          />
          <span>秒</span>
        </div>
        <p className="settings-desc">包括权限确认、等待输入和 Claude Code 主动提问。</p>
      </div>

      <div className="settings-section">
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={settings.claudeCompletionNotifications}
            onChange={event => updateSetting('claudeCompletionNotifications', event.target.checked)}
          />
          <span>任务结束通知</span>
        </label>
        <div className="hook-delay-row">
          <label htmlFor="claude-completion-delay">通知延迟</label>
          <input
            id="claude-completion-delay"
            type="number"
            min="0"
            max="3600"
            disabled={!settings.claudeCompletionNotifications}
            value={settings.claudeCompletionNotificationDelaySeconds}
            onChange={event => updateSetting('claudeCompletionNotificationDelaySeconds', clampDelay(event.target.value))}
          />
          <span>秒</span>
        </div>
        <p className="settings-desc">完成和失败使用 Hook 精确判断；正在查看的终端不会发送通知。</p>
      </div>

      {confirmCleanup && (
        <ConfirmDialog
          title="清理旧版 Hook 残留"
          message="将移除旧版写进 Claude Code 用户级 settings.json 的 TerminalBuddy Hook；其他 Claude Code 配置和第三方 Hook 会保留。当前版本的 Hook 随模型终端自动注入，无需重新安装。"
          onClose={() => setConfirmCleanup(false)}
          onConfirm={() => void cleanup()}
        />
      )}
      </div>
    </div>
  );
}
