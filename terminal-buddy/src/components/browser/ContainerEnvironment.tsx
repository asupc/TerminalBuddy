import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, CircleAlert, Container, Download, LoaderCircle, RefreshCw, TerminalSquare } from 'lucide-react';
import { Dialog } from '../shared/Dialog';
import { serverUsername } from '../../services/browser/connection';
import { getContainerEnvironment, installContainerClaude, type ContainerEnvironment } from '../../services/browser/containerEnvironment';
import { useAppStore } from '../../stores/appStore';
import './ContainerEnvironment.css';

// localStorage 按网页源隔离，再按账号区分；退出、刷新和重新登录均不重复自动展示。
const shownInMemory = new Set<string>();
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
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const openSettingsDialog = useAppStore(s => s.openSettingsDialog);

  const refresh = useCallback(async () => {
    if (pending.current) return;
    pending.current = true;
    setChecking(true);
    try {
      setEnvironment(await getContainerEnvironment());
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '环境检测失败，请重试');
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

  const claude = environment?.claude;
  const installing = starting || claude?.status === 'installing';
  useEffect(() => {
    if (claude?.status !== 'installing') return;
    // 关闭对话框仍轮询，重新打开可以看到同一安装任务的进度。
    const timer = window.setInterval(() => { void refresh(); }, 2000);
    return () => window.clearInterval(timer);
  }, [claude?.status, refresh]);

  const install = async () => {
    if (installing) return;
    setStarting(true);
    setError('');
    try { setEnvironment(await installContainerClaude()); }
    catch (reason) {
      const message = reason instanceof Error ? reason.message : '无法开始安装，请重试';
      await refresh();
      setError(message);
    } finally { setStarting(false); }
  };

  /** 模型配置入口：关掉本弹窗，跳到设置页的「模型供应商」分项。 */
  const gotoProvidersSettings = () => {
    setOpen(false);
    openSettingsDialog('llm-providers');
  };

  const statusText = installing ? '正在安装…'
    : claude?.status === 'installed' ? '已经安装'
      : claude?.status === 'failed' ? '安装失败'
        : claude ? '没有安装' : checking ? '正在检测…' : '等待检测';

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
      <section className="container-environment-tool" aria-label="Claude Code">
        <div className="container-environment-tool-header">
          <span className="container-environment-tool-icon"><TerminalSquare size={22} aria-hidden="true" /></span>
          <div className="container-environment-tool-name"><strong>Claude Code</strong><span>AI 编程助手</span></div>
          <span className={`container-environment-status ${claude?.status ?? 'checking'}`} role="status" aria-live="polite">
            {installing ? <LoaderCircle size={14} className="container-environment-spin" aria-hidden="true" />
              : claude?.status === 'installed' ? <CheckCircle2 size={14} aria-hidden="true" />
                : <CircleAlert size={14} aria-hidden="true" />}
            {statusText}
          </span>
        </div>
        {claude?.version && <p className="container-environment-version">当前版本：{claude.version}</p>}
        {installing && <p className="container-environment-hint">正在下载并安装，请稍候。关闭此窗口不会中断安装。</p>}
        {claude?.status === 'installed' && <p className="container-environment-hint">在网页终端输入 <code>claude</code> 即可启动。</p>}
        {(error || claude?.message) && <p className="container-environment-error" role="alert">{error || claude?.message}</p>}
        <div className="container-environment-actions">
          <button type="button" className="container-environment-action" onClick={gotoProvidersSettings}>模型配置</button>
          <button type="button" className="container-environment-action" disabled={checking || installing} onClick={() => { void refresh(); }}>
            <RefreshCw size={14} className={checking ? 'container-environment-spin' : undefined} aria-hidden="true" />
            {checking ? '检测中…' : '重新检测'}
          </button>
          {claude && claude.status !== 'installed' && <button
            type="button" className="container-environment-action primary" disabled={installing || checking} onClick={() => { void install(); }}
          >
            {installing ? <LoaderCircle size={14} className="container-environment-spin" aria-hidden="true" /> : <Download size={14} aria-hidden="true" />}
            {installing ? '安装中…' : claude.status === 'failed' ? '重试安装' : '一键安装'}
          </button>}
        </div>
      </section>
      <p className="container-environment-hint">通过 Claude 官方安装器安装，程序保存在容器的用户目录中。</p>
    </Dialog>}
  </>;
}
