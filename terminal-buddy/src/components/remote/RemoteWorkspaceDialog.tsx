import { useState, type FormEvent } from 'react';
import {
  ArrowRight,
  Check,
  Cloud,
  LoaderCircle,
  LogIn,
  Monitor,
  Plus,
  Server,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { Dialog } from '../shared/Dialog';
import type { RemoteConnectionInfo, RemoteWorkspaceState } from '../../services/remoteWorkspace/native';
import {
  connectRemoteWorkspace,
  enterRemoteWorkspace,
  RemoteTokenExpiredError,
  removeRemoteWorkspaceConnection,
  returnToLocalWorkspace,
} from '../../services/remoteWorkspace/session';
import './RemoteWorkspaceDialog.css';

interface Props {
  state: RemoteWorkspaceState;
  onClose: () => void;
}

type Mode = 'local' | 'remote';
type Busy = null | 'enter' | 'local' | 'add' | 'remove';

export function RemoteWorkspaceDialog({ state: initial, onClose }: Props) {
  // 连接列表与当前选中项都会随操作变化，弹框内部维护一份副本。
  const [state, setState] = useState(initial);
  const [mode, setMode] = useState<Mode>(initial.active ? 'remote' : 'local');
  const [selectedId, setSelectedId] = useState(initial.connection?.id ?? '');
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({
    name: '',
    server: '',
    username: 'admin',
    password: '',
  });
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState('');

  const selected = state.connections.find(item => item.id === selectedId) ?? null;
  const activeId = state.active ? state.connection?.id : undefined;
  // 列表为空时直接展示添加表单，避免空面板。
  const showForm = adding || state.connections.length === 0;

  /** 需要整页重载的操作（进入/切回远程或本机）统一走这里。 */
  const runReloading = async (kind: Busy, action: () => Promise<unknown | 'keep-open'>) => {
    setBusy(kind);
    setError('');
    try {
      if (await action() === 'keep-open') { setBusy(null); return; }
      window.location.reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(null);
    }
  };

  const switchToLocal = () => {
    void runReloading('local', returnToLocalWorkspace);
  };

  const enterSelected = () => {
    if (!selected) return;
    void runReloading('enter', async () => {
      // 后端在同一次调用里完成「切换连接 + 校验令牌」，失败会回滚，不会丢掉正在用的远程工作区。
      try {
        await enterRemoteWorkspace(selected.id);
      } catch (reason) {
        if (reason instanceof RemoteTokenExpiredError) {
          onClose();
          window.dispatchEvent(new Event('terminal-buddy-remote-login-required'));
          return 'keep-open' as const;
        }
        throw reason;
      }
    });
  };

  const removeConnection = (connection: RemoteConnectionInfo) => {
    const removingActive = state.active && state.connection?.id === connection.id;
    void runReloading('remove', async () => {
      const next = await removeRemoteWorkspaceConnection(connection.id);
      // 删掉正在使用的连接必须回到本机，走整页重载。
      if (removingActive) return;
      setState(next);
      setSelectedId(current => (
        next.connections.some(item => item.id === current) ? current : (next.connection?.id ?? '')
      ));
      return 'keep-open' as const;
    });
  };

  /** 当前连接的令牌过期可在原地重登；其他连接则按「添加连接」流程重新填写密码。 */
  const relogin = (connection: RemoteConnectionInfo) => {
    if (state.connection?.id === connection.id) {
      onClose();
      window.dispatchEvent(new Event('terminal-buddy-remote-login-required'));
      return;
    }
    setForm({
      name: connection.name === connection.server ? '' : connection.name,
      server: connection.server,
      username: connection.username,
      password: '',
    });
    setAdding(true);
    setError('');
  };

  const submitForm = (event: FormEvent) => {
    event.preventDefault();
    void runReloading('add', () => connectRemoteWorkspace({
      name: form.name.trim(),
      server: form.server,
      username: form.username,
      password: form.password,
    }));
  };

  const disabled = busy !== null;

  return (
    <Dialog title="工作区切换" onClose={disabled ? () => {} : onClose} style={{ width: 560 }}>
      <div className="remote-workspace-dialog">
        <div className="workspace-switch-tabs" role="tablist" aria-label="工作区模式">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'local'}
            className={`workspace-switch-tab ${mode === 'local' ? 'is-active' : ''}`}
            onClick={() => setMode('local')}
            disabled={disabled}
          >
            <Monitor aria-hidden="true" />
            <span>本地模式</span>
            {!state.active && <span className="workspace-switch-dot" title="当前工作区" />}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'remote'}
            className={`workspace-switch-tab ${mode === 'remote' ? 'is-active' : ''}`}
            onClick={() => setMode('remote')}
            disabled={disabled}
          >
            <Cloud aria-hidden="true" />
            <span>远程模式</span>
            {state.active && <span className="workspace-switch-dot" title="当前工作区" />}
          </button>
        </div>

        {mode === 'local' ? (
          <div className="workspace-mode-panel">
            <div className={`workspace-mode-card ${!state.active ? 'is-current' : ''}`}>
              <span className="workspace-mode-icon"><Monitor aria-hidden="true" /></span>
              <div className="workspace-mode-text">
                <strong>本机工作区</strong>
                <span>终端、项目、文件与 AI 会话都在此 Windows 电脑上执行</span>
              </div>
              {!state.active && <span className="workspace-mode-badge">当前</span>}
            </div>
            <div className="workspace-mode-actions">
              {state.active
                ? <button type="button" className="btn-primary" disabled={disabled} onClick={switchToLocal}>
                    {busy === 'local' ? <LoaderCircle className="remote-workspace-spin" aria-hidden="true" /> : <Monitor aria-hidden="true" />}
                    {busy === 'local' ? '正在切换…' : '切换到本地模式'}
                  </button>
                : <span className="workspace-mode-hint"><Check aria-hidden="true" />已在本机工作区运行</span>}
            </div>
          </div>
        ) : (
          <div className="workspace-mode-panel">
            {state.connections.length > 0 ? (
              <>
                <div className="workspace-conn-list-title">
                  <span>已保存的连接</span>
                  <span className="workspace-conn-count">{state.connections.length}</span>
                </div>
                <div className="workspace-conn-list" role="listbox" aria-label="远程连接">
                  {state.connections.map(connection => {
                    const isSelected = connection.id === selectedId;
                    const isRunning = connection.id === activeId;
                    return (
                      <div
                        key={connection.id}
                        role="option"
                        aria-selected={isSelected}
                        tabIndex={0}
                        className={`workspace-conn-item ${isSelected ? 'is-selected' : ''} ${isRunning ? 'is-running' : ''}`}
                        onClick={() => { if (!disabled) { setSelectedId(connection.id); setError(''); } }}
                        onKeyDown={event => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            if (!disabled) setSelectedId(connection.id);
                          }
                        }}
                      >
                        <span className="workspace-conn-icon"><Server aria-hidden="true" /></span>
                        <span className="workspace-conn-main">
                          <strong>{connection.name}</strong>
                          <span className="workspace-conn-address">{connection.server}</span>
                          <span className="workspace-conn-meta">
                            {connection.username}
                            {connection.platform ? ` · ${connection.platform}` : ''}
                            {connection.isDocker ? ' · Docker' : ''}
                          </span>
                        </span>
                        {isRunning && <span className="workspace-conn-running">运行中</span>}
                        {isSelected && <Check className="workspace-conn-check" aria-hidden="true" />}
                        <span className="workspace-conn-tools">
                          <button
                            type="button"
                            className="workspace-conn-tool"
                            title="重新登录"
                            aria-label={`重新登录 ${connection.name}`}
                            disabled={disabled}
                            onClick={event => { event.stopPropagation(); relogin(connection); }}
                          ><LogIn aria-hidden="true" /></button>
                          <button
                            type="button"
                            className="workspace-conn-tool danger"
                            title="删除连接"
                            aria-label={`删除连接 ${connection.name}`}
                            disabled={disabled}
                            onClick={event => { event.stopPropagation(); removeConnection(connection); }}
                          ><Trash2 aria-hidden="true" /></button>
                        </span>
                      </div>
                    );
                  })}
                </div>
                <div className="workspace-mode-actions">
                  {!showForm && (
                    <button type="button" className="btn-secondary" disabled={disabled} onClick={() => { setAdding(true); setError(''); }}>
                      <Plus aria-hidden="true" />添加连接
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={disabled || !selected}
                    onClick={enterSelected}
                  >
                    {busy === 'enter'
                      ? <LoaderCircle className="remote-workspace-spin" aria-hidden="true" />
                      : <ArrowRight aria-hidden="true" />}
                    {busy === 'enter'
                      ? '正在连接…'
                      : selected && state.active && selected.id === activeId
                        ? '重新校验并连接'
                        : '进入远程工作区'}
                  </button>
                </div>
              </>
            ) : (
              <div className="workspace-conn-empty">
                <Cloud aria-hidden="true" />
                <strong>还没有远程连接</strong>
                <span>添加一个 TerminalBuddy 服务地址，即可在客户端中管理它的终端、项目与 AI 会话。</span>
              </div>
            )}

            {showForm && (
              <form className="workspace-add-form" onSubmit={submitForm}>
                <div className="workspace-add-form-title">
                  <span>{state.connections.length > 0 ? '添加新的连接' : '添加远程服务'}</span>
                  {state.connections.length > 0 && (
                    <button
                      type="button"
                      className="workspace-add-cancel"
                      disabled={disabled}
                      onClick={() => { setAdding(false); setError(''); }}
                    >取消</button>
                  )}
                </div>
                <label>连接名称（可选）
                  <input value={form.name} onChange={event => setForm({ ...form, name: event.target.value })}
                    placeholder="例如：飞牛 Docker" disabled={disabled} />
                </label>
                <label>服务地址
                  <input value={form.server} onChange={event => setForm({ ...form, server: event.target.value })}
                    placeholder="https://192.168.1.10:9600" required disabled={disabled} />
                </label>
                <div className="remote-workspace-form-row">
                  <label>账号
                    <input value={form.username} onChange={event => setForm({ ...form, username: event.target.value })}
                      required disabled={disabled} />
                  </label>
                  <label>密码
                    <input type="password" value={form.password}
                      onChange={event => setForm({ ...form, password: event.target.value })}
                      autoComplete="current-password" required disabled={disabled} />
                  </label>
                </div>
                <div className="remote-workspace-security"><ShieldCheck aria-hidden="true" />密码仅用于登录；登录令牌使用 Windows DPAPI 加密保存，不会写入页面存储。</div>
                <div className="workspace-mode-actions">
                  <button type="submit" className="btn-primary" disabled={disabled}>
                    {busy === 'add' ? <LoaderCircle className="remote-workspace-spin" aria-hidden="true" /> : <Cloud aria-hidden="true" />}
                    {busy === 'add' ? '正在连接…' : '连接并进入'}
                  </button>
                </div>
              </form>
            )}
          </div>
        )}

        {error && <div className="remote-workspace-error" role="alert">{error}</div>}
      </div>
    </Dialog>
  );
}
