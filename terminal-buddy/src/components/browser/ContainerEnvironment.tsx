import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, CircleAlert, Container, Download, LoaderCircle, RefreshCw, TerminalSquare } from 'lucide-react';
import { Dialog } from '../shared/Dialog';
import { serverUsername } from '../../services/browser/connection';
import {
  getContainerEnvironment, installContainerClaude, installContainerCodex,
  type ContainerCli, type ContainerEnvironment,
} from '../../services/browser/containerEnvironment';
import { useAppStore } from '../../stores/appStore';
import './ContainerEnvironment.css';

// localStorage 按网页源隔离，再按账号区分；退出、刷新和重新登录均不重复自动展示。
const shownInMemory = new Set<string>();
const tools = [
  { id: 'claude', name: 'Claude Code', install: installContainerClaude },
  { id: 'codex', name: 'Codex CLI', install: installContainerCodex },
] as const;

function showFirstTime(): boolean {
  const key = `terminalBuddy.containerEnvironment.shown.v1:${serverUsername}`;
  if (shownInMemory.has(key)) return false;
  shownInMemory.add(key);
  try {
    if (localStorage.getItem(key) === '1') return false;
    localStorage.setItem(key, '1');
  } catch { /* 禁用本地存储时，至少保证本次页面生命周期只自动展示一次。 */ }
  return true;
}

export function ContainerEnvironmentButton() {
  const [open, setOpen] = useState(false);
  const [environment, setEnvironment] = useState<ContainerEnvironment | null>(null);
  const [checking, setChecking] = useState(false);
  const [starting, setStarting] = useState<Record<ContainerCli, boolean>>({ claude: false, codex: false });
  const [installErrors, setInstallErrors] = useState<Record<ContainerCli, string>>({ claude: '', codex: '' });
  const [error, setError] = useState('');
  const pending = useRef(false);
  const startingTools = useRef(new Set<ContainerCli>());
  const installationRevision = useRef(0);
  const openSettingsDialog = useAppStore(s => s.openSettingsDialog);

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
    let cancelled = false;
    pending.current = true;
    setChecking(true);
    void getContainerEnvironment().then(value => {
      if (cancelled) return;
      setEnvironment(value);
      // 探测同时验证了登录状态，认证成功后才消耗首次弹框标记。
      if (showFirstTime()) setOpen(true);
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : '环境检测失败，请重试');
    }).finally(() => {
      if (!cancelled) { pending.current = false; setChecking(false); }
    });
    return () => { cancelled = true; };
  }, []);

  const installing = starting.claude || starting.codex
    || environment?.claude.status === 'installing' || environment?.codex.status === 'installing';
  useEffect(() => {
    if (!installing) return;
    // 关闭对话框仍轮询，重新打开可以看到同一安装任务的进度。
    const timer = window.setInterval(() => { void refresh(); }, 2000);
    return () => window.clearInterval(timer);
  }, [installing, refresh]);

  const install = async (tool: typeof tools[number]) => {
    if (startingTools.current.has(tool.id) || environment?.[tool.id].status === 'installing') return;
    startingTools.current.add(tool.id);
    installationRevision.current += 1;
    setStarting(value => ({ ...value, [tool.id]: true }));
    setInstallErrors(value => ({ ...value, [tool.id]: '' }));
    setError('');
    try {
      const value = await tool.install();
      installationRevision.current += 1;
      // 两种工具可以同时安装，各自的响应只更新对应工具。
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

  /** 模型配置入口：关掉本弹窗，跳到设置页的「模型供应商」分项。 */
  const gotoProvidersSettings = () => {
    setOpen(false);
    openSettingsDialog('llm-providers');
  };

  return <>
    <button
      type="button"
      className={`titlebar-btn titlebar-action-btn${open ? ' active' : ''}`}
      title="容器环境"
      aria-label="容器环境"
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={() => { setOpen(true); void refresh(); }}
    >
      <Container aria-hidden="true" />
    </button>
    {open && <Dialog
      title="容器环境检测"
      ariaLabel="容器环境检测"
      className="container-environment-dialog"
      onClose={() => setOpen(false)}
      footer={<>
        <span className="container-environment-footer-note">此提示仅首次自动弹出</span>
        <button type="button" className="container-environment-action" onClick={() => setOpen(false)}>关闭</button>
      </>}
    >
      <p className="container-environment-intro">检测当前容器中的命令行工具，按需安装后即可在网页终端使用。</p>
      {error && <p className="container-environment-error" role="alert">{error}</p>}
      {tools.map(tool => {
        const cli = environment?.[tool.id];
        const toolInstalling = starting[tool.id] || cli?.status === 'installing';
        const statusText = toolInstalling ? '正在安装…'
          : cli?.status === 'installed' ? '已经安装'
            : cli?.status === 'failed' ? '安装失败'
              : cli ? '没有安装' : checking ? '正在检测…' : '等待检测';
        const installError = cli?.status === 'installed' ? null : installErrors[tool.id] || cli?.message;

        return <section key={tool.id} className="container-environment-tool" aria-label={tool.name}>
          <div className="container-environment-tool-header">
            <span className="container-environment-tool-icon"><TerminalSquare size={22} aria-hidden="true" /></span>
            <div className="container-environment-tool-name"><strong>{tool.name}</strong><span>AI 编程助手</span></div>
            <span className={`container-environment-status ${toolInstalling ? 'installing' : cli?.status ?? 'checking'}`} role="status" aria-live="polite">
              {toolInstalling ? <LoaderCircle size={14} className="container-environment-spin" aria-hidden="true" />
                : cli?.status === 'installed' ? <CheckCircle2 size={14} aria-hidden="true" />
                  : <CircleAlert size={14} aria-hidden="true" />}
              {statusText}
            </span>
          </div>
          {cli?.version && <p className="container-environment-version">当前版本：{cli.version}</p>}
          {toolInstalling && <p className="container-environment-hint">正在下载并安装，请稍候。关闭此窗口不会中断安装。</p>}
          {cli?.status === 'installed' && <p className="container-environment-hint">在网页终端输入 <code>{tool.id}</code> 即可启动。</p>}
          {installError && <p className="container-environment-error" role="alert">{installError}</p>}
          <div className="container-environment-actions">
            {tool.id === 'claude' && <button type="button" className="container-environment-action" onClick={gotoProvidersSettings}>模型配置</button>}
            <button type="button" className="container-environment-action" disabled={checking || toolInstalling} onClick={() => { void refresh(); }}>
              <RefreshCw size={14} className={checking ? 'container-environment-spin' : undefined} aria-hidden="true" />
              {checking ? '检测中…' : '重新检测'}
            </button>
            {cli && cli.status !== 'installed' && <button
              type="button" className="container-environment-action primary" disabled={toolInstalling || checking} onClick={() => { void install(tool); }}
            >
              {toolInstalling ? <LoaderCircle size={14} className="container-environment-spin" aria-hidden="true" /> : <Download size={14} aria-hidden="true" />}
              {toolInstalling ? '安装中…' : cli.status === 'failed' ? '重试安装' : '一键安装'}
            </button>}
          </div>
        </section>;
      })}
      <p className="container-environment-hint">通过各工具的官方安装器安装，程序保存在容器的用户目录中。</p>
    </Dialog>}
  </>;
}
