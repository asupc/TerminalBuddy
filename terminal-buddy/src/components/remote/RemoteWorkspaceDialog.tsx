import { useState, type FormEvent } from 'react';
import {
  Check,
  Cloud,
  LoaderCircle,
  LogIn,
  Monitor,
  Plus,
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
import { flushPendingSaveTabsIfAny } from '../../stores/slices/sessionsSlice';
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
  const [selectedId, setSelectedId] = useState(initial.connection?.id ?? initial.connections[0]?.id ?? '');
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
  const disabled = busy !== null;

  /**
   * 需要整页重载的操作（进入/切回远程或本机）统一走这里。
   * 重载前先落盘当前后端身份下的页签快照：桌面端与远程服务端各有一份 saved_tabs，
   * 不落盘会丢掉切换前最后几秒内的页签变更。
   */
  const runReloading = async (kind: Busy, action: () => Promise<unknown | 'keep-open'>) => {
    setBusy(kind);
    setError('');
    try {
      // 只冲刷已排队的变更：启动恢复尚未完成时不能无条件写盘，否则会把旧快照覆盖成空。
      await flushPendingSaveTabsIfAny().catch(() => {});
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

  /** 进入（或切换到）指定远程服务器；令牌过期时转去登录面板。 */
  const enterConnection = (id: string) => {
    if (!state.connections.some(item => item.id === id)) return;
    if (state.active && state.connection?.id === id) return;
    setSelectedId(id);
    void runReloading('enter', async () => {
      // 后端在同一次调用里完成「切换连接 + 校验令牌」，失败会回滚，不会丢掉正在用的远程工作区。
      try {
        await enterRemoteWorkspace(id);
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

  /** 单个开关直接切换本地 / 远程：打开即连接当前选中的远程服务器，关闭即回到本机。 */
  const toggleWorkspace = () => {
    if (disabled) return;
    setError('');
    if (mode === 'remote') {
      setMode('local');
      if (state.active) switchToLocal();
      return;
    }
    setMode('remote');
    const target = state.connections.find(item => item.id === selectedId) ?? state.connections[0];
    if (!target) {
      // 还没有任何远程连接：展开添加表单，保存成功后由后端直接激活远程工作区。
      setSelectedId('');
      setAdding(true);
      return;
    }
    setSelectedId(target.id);
    enterConnection(target.id);
  };

  const chooseConnection = (id: string) => {
    if (disabled) return;
    setSelectedId(id);
    setError('');
    enterConnection(id);
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

  const statusText = busy === 'local'
    ? '正在切回本地…'
    : busy === 'enter'
      ? '正在连接远程服务器…'
      : busy === 'add'
        ? '正在连接并进入…'
        : busy === 'remove'
          ? '正在删除连接…'
          : state.active
            ? `当前：远程 · ${state.connection?.name ?? '已连接'}`
            : '当前：本地工作区';

  return (
    <Dialog title="工作区切换" onClose={disabled ? () => {} : onClose} style={{ width: 560 }}>
      <div className="remote-workspace-dialog">
        <div className="workspace-switch-bar">
          <span className={`workspace-switch-label ${mode === 'local' ? 'is-active' : ''}`}>
            <Monitor aria-hidden="true" />
            <span>本地</span>
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={mode === 'remote'}
            aria-label="切换到远程工作区"
            className={`workspace-switch ${mode === 'remote' ? 'is-on' : ''}`}
            onClick={toggleWorkspace}
            disabled={disabled}
          >
            <span className="workspace-switch-thumb" />
          </button>
          <span className={`workspace-switch-label ${mode === 'remote' ? 'is-active' : ''}`}>
            <Cloud aria-hidden="true" />
            <span>远程</span>
          </span>
          <span className={`workspace-switch-status ${busy ? 'is-busy' : ''}`} role="status">
            {busy && <LoaderCircle className="remote-workspace-spin" aria-hidden="true" />}
            {statusText}
          </span>
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
            {state.active && (
              <div className="workspace-mode-hint-row">
                <span className="workspace-mode-hint">
                  <Check aria-hidden="true" />
                  关闭上方开关即可切回本机，已打开的终端会原样保留
                </span>
              </div>
            )}
          </div>
        ) : (
          <div className="workspace-mode-panel">
            {state.connections.length > 0 ? (
              <div className="workspace-server-picker">
                <label htmlFor="workspace-server-select">远程服务器</label>
                <select
                  id="workspace-server-select"
                  className="workspace-server-select"
                  value={selectedId}
                  disabled={disabled}
                  onChange={event => chooseConnection(event.target.value)}
                >
                  {state.connections.map(connection => (
                    <option key={connection.id} value={connection.id}>
                      {connection.name}{connection.id === activeId ? '（当前）' : ''} — {connection.server}
                    </option>
                  ))}
                </select>
                {selected ? (
                  <div className="workspace-server-meta">
                    <span className="workspace-server-meta-text">
                      {selected.username}
                      {selected.platform ? ` · ${selected.platform}` : ''}
                      {selected.isDocker ? ' · Docker' : ''}
                      {selected.id === activeId ? ' · 运行中' : ''}
                    </span>
                    <span className="workspace-conn-tools">
                      <button
                        type="button"
                        className="workspace-conn-tool"
                        title="重新登录"
                        aria-label={`重新登录 ${selected.name}`}
                        disabled={disabled}
                        onClick={() => relogin(selected)}
                      ><LogIn aria-hidden="true" /></button>
                      <button
                        type="button"
                        className="workspace-conn-tool danger"
                        title="删除连接"
                        aria-label={`删除连接 ${selected.name}`}
                        disabled={disabled}
                        onClick={() => removeConnection(selected)}
                      ><Trash2 aria-hidden="true" /></button>
                    </span>
                  </div>
                ) : (
                  <span className="workspace-server-meta-text">请选择一个远程服务器</span>
                )}
                <p className="workspace-server-tip">
                  切换服务器会立即连接并重新加载界面；关闭上方开关即可回到本机。
                </p>
                <div className="workspace-mode-actions">
                  {!showForm && (
                    <button type="button" className="btn-secondary" disabled={disabled} onClick={() => { setAdding(true); setError(''); }}>
                      <Plus aria-hidden="true" />添加连接
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div className="workspace-conn-empty">
                <Cloud aria-hidden="true" />
                <strong>还没有远程连接</strong>
                <span>在下方添加一个 TerminalBuddy 服务地址，保存后会自动进入它的终端、项目与 AI 会话。</span>
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
