import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, CircleAlert, Download, LoaderCircle, RefreshCw, TerminalSquare } from 'lucide-react';
import {
  getContainerEnvironment, installContainerClaude, installContainerCodex,
  type ContainerCli, type ContainerEnvironment,
} from '../../services/browser/containerEnvironment';
import './ContainerEnvironmentSettings.css';

const tools = [
  { id: 'claude', name: 'Claude Code', install: installContainerClaude },
  { id: 'codex', name: 'Codex CLI', install: installContainerCodex },
] as const;

interface ContainerEnvironmentSettingsProps {
  active: boolean;
}

export function ContainerEnvironmentSettings({ active }: ContainerEnvironmentSettingsProps) {
  const [environment, setEnvironment] = useState<ContainerEnvironment | null>(null);
  const [checking, setChecking] = useState(false);
  const [starting, setStarting] = useState<Record<ContainerCli, boolean>>({ claude: false, codex: false });
  const [installErrors, setInstallErrors] = useState<Record<ContainerCli, string>>({ claude: '', codex: '' });
  const [error, setError] = useState('');
  const pending = useRef(false);
  const startingTools = useRef(new Set<ContainerCli>());
  const installationRevision = useRef(0);

  const refresh = useCallback(async () => {
    if (pending.current) return;
    pending.current = true;
    setChecking(true);
    const revision = installationRevision.current;
    try {
      const value = await getContainerEnvironment();
      // 安装开始前发出的检测响应不能覆盖刚开始的安装状态。
      if (revision !== installationRevision.current) return;
      setEnvironment(value);
      setError('');
    } catch (reason) {
      if (revision === installationRevision.current) {
        setError(reason instanceof Error ? reason.message : '环境检测失败，请重试');
      }
    } finally {
      pending.current = false;
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

  const installing = starting.claude || starting.codex
    || environment?.claude.status === 'installing' || environment?.codex.status === 'installing';
  useEffect(() => {
    if (!installing) return;
    // 切换设置分区后继续轮询，返回时可查看同一安装任务的进度。
    const timer = window.setInterval(() => { void refresh(); }, 2000);
    return () => window.clearInterval(timer);
  }, [installing, refresh]);

  const install = async (tool: typeof tools[number]) => {
    if (startingTools.current.has(tool.id) || environment?.[tool.id]?.status === 'installing') return;
    startingTools.current.add(tool.id);
    installationRevision.current += 1;
    setStarting(value => ({ ...value, [tool.id]: true }));
    setInstallErrors(value => ({ ...value, [tool.id]: '' }));
    setError('');
    try {
      const value = await tool.install();
      installationRevision.current += 1;
      // 各安装任务可以同时运行，响应只更新对应项目，保留其他项目的进行中状态。
      setEnvironment(current => current ? { ...current, [tool.id]: value[tool.id] } : value);
    }
    catch (reason) {
      const message = reason instanceof Error ? reason.message : '无法开始安装，请重试';
      await refresh();
      setInstallErrors(value => ({ ...value, [tool.id]: message }));
    } finally {
      startingTools.current.delete(tool.id);
      setStarting(value => ({ ...value, [tool.id]: false }));
    }
  };

  return (
    <div className="container-environment-settings">
      <div className="settings-card-group container-environment-list">
        <div className="card-group-header container-environment-toolbar">
          <span className="card-group-title">命令行工具</span>
          <button type="button" className="container-environment-action" disabled={checking} onClick={() => { void refresh(); }}>
            <RefreshCw size={14} className={checking ? 'container-environment-spin' : undefined} aria-hidden="true" />
            {checking ? '检测中…' : '重新检测'}
          </button>
        </div>
        {error && <p className="container-environment-error container-environment-check-error" role="alert">{error}</p>}
        {tools.map(tool => {
          const cli = environment?.[tool.id];
          const toolInstalling = starting[tool.id] || cli?.status === 'installing';
          const statusText = toolInstalling ? '正在安装…'
            : cli?.status === 'installed' ? '已安装'
              : cli?.status === 'failed' ? '安装失败'
                : cli ? '未安装' : checking ? '正在检测…' : '等待检测';
          const installError = cli?.status === 'installed' ? null : installErrors[tool.id] || cli?.message;

          return <section key={tool.id} className="container-environment-tool" aria-label={tool.name}>
            <div className="container-environment-tool-header">
              <span className="container-environment-tool-icon"><TerminalSquare size={18} aria-hidden="true" /></span>
              <div className="container-environment-tool-details">
                <div className="container-environment-tool-name">
                  <strong>{tool.name}</strong>
                  {cli?.version && <span className="container-environment-version" title={`当前版本：${cli.version}`}>{cli.version}</span>}
                </div>
                <p className="container-environment-hint">
                  {toolInstalling ? '正在下载安装，离开设置页不会中断。'
                    : cli?.status === 'installed' ? <>在终端输入 <code>{tool.id}</code> 即可启动</>
                      : cli ? '使用官方安装器安装到容器用户目录'
                        : '检测容器中的安装状态与版本'}
                </p>
              </div>
              <div className="container-environment-controls">
                <span className={`container-environment-status ${toolInstalling ? 'installing' : cli?.status ?? 'checking'}`} role="status" aria-live="polite">
                  {toolInstalling || (!cli && checking) ? <LoaderCircle size={14} className="container-environment-spin" aria-hidden="true" />
                    : cli?.status === 'installed' ? <CheckCircle2 size={14} aria-hidden="true" />
                      : <CircleAlert size={14} aria-hidden="true" />}
                  {statusText}
                </span>
                {cli && cli.status !== 'installed' && <button
                  type="button" className="container-environment-action primary" disabled={toolInstalling || checking} onClick={() => { void install(tool); }}
                  aria-label={`${cli.status === 'failed' ? '重试安装' : '安装'} ${tool.name}`}
                >
                  {toolInstalling ? <LoaderCircle size={14} className="container-environment-spin" aria-hidden="true" /> : <Download size={14} aria-hidden="true" />}
                  {toolInstalling ? '安装中…' : cli.status === 'failed' ? '重试安装' : '一键安装'}
                </button>}
              </div>
            </div>
            {installError && <p className="container-environment-error container-environment-install-error" role="alert">{installError}</p>}
          </section>;
        })}
      </div>
      <p className="container-environment-hint container-environment-footer">工具安装在当前容器的用户目录中，安装完成后可直接在网页终端使用。</p>
    </div>
  );
}
