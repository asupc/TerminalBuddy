import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpCircle, CheckCircle2, CircleAlert, Download, LoaderCircle, RefreshCw, TerminalSquare } from 'lucide-react';
import {
  getContainerCli, getContainerEnvironment, installContainerCli, updateContainerCli,
  type ContainerCli, type ContainerCliStatus, type ContainerEnvironment,
} from '../../services/browser/containerEnvironment';
import './ContainerEnvironmentSettings.css';

const tools = [
  { id: 'claude', name: 'Claude Code' },
  { id: 'codex', name: 'Codex CLI' },
] as const;
type ToolAction = 'check' | 'install' | 'update';

function isRunning(cli: ContainerCliStatus | undefined): boolean {
  return cli?.status === 'installing' || cli?.status === 'updating';
}

function preserveUpdate(previous: ContainerCliStatus | undefined, next: ContainerCliStatus): ContainerCliStatus {
  return {
    ...next,
    update: next.update ?? (
      previous?.version === next.version && previous?.status === next.status ? previous.update : null
    ),
  };
}

interface ContainerEnvironmentSettingsProps {
  active: boolean;
}

export function ContainerEnvironmentSettings({ active }: ContainerEnvironmentSettingsProps) {
  const [environment, setEnvironment] = useState<ContainerEnvironment | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [actions, setActions] = useState<Record<ContainerCli, ToolAction | null>>({ claude: null, codex: null });
  const [errors, setErrors] = useState<Record<ContainerCli, string>>({ claude: '', codex: '' });
  const [error, setError] = useState('');
  const refreshPending = useRef(false);
  const busyTools = useRef(new Set<ContainerCli>());
  const revisions = useRef<Record<ContainerCli, number>>({ claude: 0, codex: 0 });

  const refresh = useCallback(async () => {
    if (refreshPending.current) return;
    refreshPending.current = true;
    setRefreshing(true);
    const requestedRevisions = { ...revisions.current };
    try {
      const value = await getContainerEnvironment();
      setEnvironment(current => {
        if (!current) return value;
        const next = { ...current };
        for (const tool of tools) {
          // 每个条目独立合并，迟到的整体检测不能覆盖该条目刚开始或已完成的操作。
          if (requestedRevisions[tool.id] === revisions.current[tool.id] && !busyTools.current.has(tool.id)) {
            next[tool.id] = preserveUpdate(current[tool.id], value[tool.id]);
          }
        }
        return next;
      });
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '环境检测失败，请重试');
    } finally {
      refreshPending.current = false;
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

  const working = tools.some(tool => isRunning(environment?.[tool.id])
    || actions[tool.id] === 'install' || actions[tool.id] === 'update');
  useEffect(() => {
    if (!working) return;
    // 离开分区后继续轮询后台安装或更新，返回时仍能看到实际版本与任务结果。
    const timer = window.setInterval(() => { void refresh(); }, 2000);
    return () => window.clearInterval(timer);
  }, [working, refresh]);

  const runAction = async (tool: ContainerCli, action: ToolAction) => {
    if (busyTools.current.has(tool) || isRunning(environment?.[tool])) return;
    busyTools.current.add(tool);
    revisions.current[tool] += 1;
    setActions(value => ({ ...value, [tool]: action }));
    setErrors(value => ({ ...value, [tool]: '' }));
    const apply = (value: ContainerCliStatus) => {
      setEnvironment(current => current ? { ...current, [tool]: value } : current);
    };
    try {
      const value = await (action === 'check' ? getContainerCli(tool, true)
        : action === 'update' ? updateContainerCli(tool) : installContainerCli(tool));
      apply(value);
    } catch (reason) {
      if (action !== 'check') {
        // 请求响应丢失时，后台任务可能已经启动，先恢复该条目的实际状态。
        try {
          const value = await getContainerCli(tool);
          apply(value);
          if (isRunning(value) || (action === 'update' && value.updatedVersion && value.updatedVersion === value.version && value.version !== environment?.[tool]?.version)) return;
        } catch { /* 保留下方原始错误，允许重新检测或重试。 */ }
      }
      const label = action === 'check' ? '检查更新' : action === 'update' ? '更新' : '安装';
      setErrors(value => ({ ...value, [tool]: `${label}失败：${reason instanceof Error ? reason.message : '请重试'}` }));
    } finally {
      revisions.current[tool] += 1;
      busyTools.current.delete(tool);
      setActions(value => ({ ...value, [tool]: null }));
    }
  };

  return (
    <div className="container-environment-settings">
      <div className="settings-card-group container-environment-list">
        <div className="card-group-header container-environment-toolbar">
          <span className="card-group-title">命令行工具</span>
          <button type="button" className="container-environment-action" disabled={refreshing} onClick={() => { void refresh(); }}>
            <RefreshCw size={14} className={refreshing ? 'container-environment-spin' : undefined} aria-hidden="true" />
            {refreshing ? '检测中…' : '重新检测'}
          </button>
        </div>
        {error && <p className="container-environment-error container-environment-check-error" role="alert">{error}</p>}
        {tools.map(tool => {
          const cli = environment?.[tool.id];
          const action = actions[tool.id];
          const checking = action === 'check';
          const updating = action === 'update' || cli?.status === 'updating';
          const installing = action === 'install' || cli?.status === 'installing';
          const busy = checking || updating || installing;
          const update = cli?.update;
          const nextAction: ToolAction = cli?.version ? update?.state === 'available' ? 'update' : 'check' : 'install';
          const buttonText = checking ? '检查中…' : updating ? '更新中…' : installing ? '安装中…'
            : nextAction === 'update' ? '更新' : nextAction === 'check' ? '检查更新'
              : cli?.status === 'failed' ? '重试安装' : '一键安装';
          const statusText = updating ? '正在更新…' : installing ? '正在安装…'
            : cli?.status === 'installed' ? '已安装' : cli?.status === 'failed' ? '安装失败'
              : cli ? '未安装' : refreshing ? '正在检测…' : '等待检测';
          const updated = !!cli?.updatedVersion && cli.updatedVersion === cli.version && !cli.message;
          const updateText = checking ? '正在检查更新…' : updating || installing ? ''
            : update?.state === 'available' ? '发现新版本'
              : updated ? `更新成功，当前版本 ${cli.version}`
                : update?.state === 'upToDate' ? '已是最新版本'
                  : update?.state === 'ahead' ? '当前版本较新'
                    : update?.state === 'unknown' && cli?.version ? '当前构建无法比较版本' : '';
          const toolError = busy ? '' : errors[tool.id] || cli?.message
            || (update?.message ? `检查更新失败：${update.message}` : '');

          return <section key={tool.id} className="container-environment-tool" aria-label={tool.name}>
            <div className="container-environment-tool-header">
              <span className="container-environment-tool-icon"><TerminalSquare size={18} aria-hidden="true" /></span>
              <div className="container-environment-tool-details">
                <div className="container-environment-tool-name"><strong>{tool.name}</strong></div>
                <div className="container-environment-versions">
                  <span className="container-environment-version">
                    当前版本：<code>{cli?.version ?? (installing ? '安装中…' : cli ? '未安装' : refreshing ? '检测中…' : '等待检测')}</code>
                  </span>
                  {update?.latestVersion && <span className="container-environment-version">
                    最新版本：<code>{update.latestVersion}</code>
                  </span>}
                </div>
                <p className="container-environment-hint">
                  {updating ? '正在下载安装新版本，离开设置页不会中断。'
                    : installing ? '正在下载安装，离开设置页不会中断。'
                      : cli?.status === 'installed' ? <>在终端输入 <code>{tool.id}</code> 即可启动</>
                        : cli ? '使用官方安装器安装到容器用户目录' : '检测容器中的安装状态与版本'}
                </p>
                {updateText && <p className={`container-environment-update ${checking ? 'checking' : updated && update?.state !== 'available' ? 'upToDate' : update?.state}`} role="status" aria-live="polite">
                  {checking ? <LoaderCircle size={13} className="container-environment-spin" aria-hidden="true" />
                    : update?.state === 'available' ? <ArrowUpCircle size={13} aria-hidden="true" />
                      : update?.state === 'unknown' && !updated ? <CircleAlert size={13} aria-hidden="true" />
                        : <CheckCircle2 size={13} aria-hidden="true" />}
                  {updateText}
                </p>}
              </div>
              <div className="container-environment-controls">
                <span className={`container-environment-status ${updating ? 'updating' : installing ? 'installing' : cli?.status ?? 'checking'}`} role="status" aria-live="polite">
                  {updating || installing || (!cli && refreshing) ? <LoaderCircle size={14} className="container-environment-spin" aria-hidden="true" />
                    : cli?.status === 'installed' ? <CheckCircle2 size={14} aria-hidden="true" /> : <CircleAlert size={14} aria-hidden="true" />}
                  {statusText}
                </span>
                {cli && <button
                  type="button" className={`container-environment-action${nextAction === 'check' && !updating ? '' : ' primary'}`}
                  disabled={busy} onClick={() => { void runAction(tool.id, nextAction); }}
                  aria-label={`${buttonText} ${tool.name}`}
                >
                  {busy ? <LoaderCircle size={14} className="container-environment-spin" aria-hidden="true" />
                    : nextAction === 'check' ? <RefreshCw size={14} aria-hidden="true" /> : <Download size={14} aria-hidden="true" />}
                  {buttonText}
                </button>}
              </div>
            </div>
            {toolError && <p className="container-environment-error container-environment-install-error" role="alert">{toolError}</p>}
          </section>;
        })}
      </div>
      <p className="container-environment-hint container-environment-footer">每个工具可独立检查和更新；更新成功后会自动显示实际安装的版本。</p>
    </div>
  );
}
