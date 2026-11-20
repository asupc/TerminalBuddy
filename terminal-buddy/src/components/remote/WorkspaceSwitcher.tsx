import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  Check,
  ChevronDown,
  Cloud,
  LoaderCircle,
  LogIn,
  Plus,
  Server,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import {
  getRemoteWorkspaceState,
  type RemoteConnectionInfo,
  type RemoteWorkspaceState,
} from '../../services/remoteWorkspace/native';
import { isRemoteWorkspace } from '../../services/remoteWorkspace/config';
import {
  connectRemoteWorkspace,
  enterRemoteWorkspace,
  RemoteTokenExpiredError,
  removeRemoteWorkspaceConnection,
  returnToLocalWorkspace,
} from '../../services/remoteWorkspace/session';
import { flushPendingSaveTabsIfAny } from '../../stores/slices/sessionsSlice';
import { useAppStore } from '../../stores/appStore';
import './WorkspaceSwitcher.css';

type Busy = null | 'enter' | 'local' | 'add' | 'remove';

/**
 * 标题栏工作区控件：开关直接切换本地 / 远程，远程时右侧下拉直接选择服务器；
 * 下拉面板内可添加、重新登录与删除远程服务器，不再弹出独立对话框。
 */
export function WorkspaceSwitcher() {
  const [active, setActive] = useState(isRemoteWorkspace);
  const [workspace, setWorkspace] = useState<RemoteWorkspaceState | null>(null);
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [formMode, setFormMode] = useState<'add' | 'relogin'>('add');
  const [form, setForm] = useState({ name: '', server: '', username: 'admin', password: '' });
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  const connections = workspace?.connections ?? [];
  const current = workspace?.connection ?? null;
  const currentId = current?.id ?? '';
  // 没有任何服务器时直接展开添加表单，避免空面板。
  const showForm = adding || connections.length === 0;
  const disabled = busy !== null;

  const refresh = useCallback(async () => {
    try {
      const next = await getRemoteWorkspaceState();
      setWorkspace(next);
      setActive(next.active);
    } catch {
      // 读取失败时保留上一次状态；真正不可用时后续切换会给出错误。
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // 点击面板外部或按 Esc 关闭。
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  /**
   * 需要整页重载的操作统一走这里：切回本机、进入远程、切换服务器。
   * 重载前只冲刷已排队的页签变更，避免启动恢复尚未完成时把旧快照覆盖成空。
   */
  const runReloading = async (kind: Busy, action: () => Promise<unknown | 'keep-open'>) => {
    setBusy(kind);
    setError('');
    try {
      await flushPendingSaveTabsIfAny().catch(() => {});
      if (await action() === 'keep-open') { setBusy(null); return; }
      window.location.reload();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      if (open) setError(message);
      else useAppStore.getState().showToast(message, 'error');
      setBusy(null);
    }
  };

  const enterConnection = (id: string) => {
    void runReloading('enter', async () => {
      // 后端在同一次调用里完成「切换连接 + 校验令牌」，失败会回滚。
      try {
        await enterRemoteWorkspace(id);
      } catch (reason) {
        if (reason instanceof RemoteTokenExpiredError) {
          const target = connections.find(item => item.id === id);
          if (target) {
            // 令牌过期直接在面板内重新登录，确保登录的是刚才选中的服务器。
            setOpen(true);
            setForm({
              name: target.name === target.server ? '' : target.name,
              server: target.server,
              username: target.username,
              password: '',
            });
            setFormMode('relogin');
            setAdding(true);
            setError('远程登录已过期，请重新输入密码');
          } else {
            setOpen(false);
            window.dispatchEvent(new Event('terminal-buddy-remote-login-required'));
          }
          return 'keep-open' as const;
        }
        throw reason;
      }
    });
  };

  const openPopover = () => {
    if (disabled) return;
    setOpen(true);
    setError('');
    setFormMode('add');
    void refresh();
  };

  /** 开关直接切换：关闭回到本机；打开连接当前选中的服务器。 */
  const toggleWorkspace = () => {
    if (disabled) return;
    if (active) {
      void runReloading('local', returnToLocalWorkspace);
      return;
    }
    if (connections.length === 0) {
      // 没有服务器可连：展开面板引导添加，添加成功后由后端直接激活远程工作区。
      setOpen(true);
      setAdding(true);
      setFormMode('add');
      setError('');
      void refresh();
      return;
    }
    const target = current ?? connections[0];
    enterConnection(target.id);
  };

  const selectConnection = (connection: RemoteConnectionInfo) => {
    if (disabled) return;
    if (active && current?.id === connection.id) {
      setOpen(false);
      return;
    }
    enterConnection(connection.id);
  };

  const removeConnection = (connection: RemoteConnectionInfo) => {
    if (disabled) return;
    const removingActive = active && current?.id === connection.id;
    void runReloading('remove', async () => {
      const next = await removeRemoteWorkspaceConnection(connection.id);
      // 删掉正在使用的连接必须回到本机，走整页重载。
      if (removingActive) return;
      setWorkspace(next);
      setActive(next.active);
      return 'keep-open' as const;
    });
  };

  /** 重新登录同样在面板内完成：预填服务器信息，提交后更新令牌并进入。 */
  const relogin = (connection: RemoteConnectionInfo) => {
    setForm({
      name: connection.name === connection.server ? '' : connection.name,
      server: connection.server,
      username: connection.username,
      password: '',
    });
    setFormMode('relogin');
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

  return (
    <div className="workspace-switcher" ref={rootRef}>
      <button
        type="button"
        role="switch"
        aria-checked={active}
        className={`workspace-mode-toggle ${active ? 'is-remote' : ''}`}
        onClick={toggleWorkspace}
        disabled={disabled}
        title={active ? '当前在远程工作区，点击切回本机' : '点击进入远程工作区'}
        aria-label={active ? '当前远程工作区，点击切换到本地' : '当前本地工作区，点击切换到远程'}
      >
        <span className="workspace-mode-track" aria-hidden="true">
          <span className="workspace-mode-thumb" />
        </span>
        <span className="workspace-mode-label">
          {busy === 'local' ? '切换中' : busy === 'enter' ? '连接中' : active ? '远程' : '本地'}
        </span>
      </button>

      <button
        type="button"
        className={`workspace-server-trigger ${active ? '' : 'is-compact'} ${open ? 'is-open' : ''}`}
        onClick={() => { if (open) setOpen(false); else openPopover(); }}
        disabled={disabled}
        title={active ? `远程服务器：${current?.name ?? '未选择'}` : '选择或管理远程服务器'}
        aria-label="选择或管理远程服务器"
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        {busy === 'enter' || busy === 'add' || busy === 'remove'
          ? <LoaderCircle className="workspace-spin" aria-hidden="true" />
          : <Cloud aria-hidden="true" />}
        {active && <span className="workspace-server-name">{current?.name ?? '选择服务器'}</span>}
        {active && <ChevronDown className="workspace-server-chevron" aria-hidden="true" />}
      </button>

      {open && (
        <div className="workspace-popover" role="dialog" aria-label="远程服务器">
          <div className="workspace-popover-head">
            <span className="workspace-popover-title">
              <Server aria-hidden="true" />
              远程服务器
            </span>
            {connections.length > 0 && (
              <span className="workspace-popover-count">{connections.length}</span>
            )}
          </div>

          {connections.length > 0 && (
            <div className="workspace-popover-list" role="listbox" aria-label="已保存的远程服务器">
              {connections.map(connection => {
                const isCurrent = connection.id === currentId;
                const isRunning = active && isCurrent;
                return (
                  <div
                    key={connection.id}
                    role="option"
                    aria-selected={isCurrent}
                    tabIndex={0}
                    className={`workspace-popover-item ${isCurrent ? 'is-current' : ''}`}
                    onClick={() => selectConnection(connection)}
                    onKeyDown={event => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        selectConnection(connection);
                      }
                    }}
                  >
                    <span className="workspace-popover-icon"><Server aria-hidden="true" /></span>
                    <span className="workspace-popover-main">
                      <span className="workspace-popover-name">
                        {connection.name}
                        {isRunning && <span className="workspace-popover-running">运行中</span>}
                      </span>
                      <span className="workspace-popover-address">{connection.server}</span>
                      <span className="workspace-popover-meta">
                        {connection.username}
                        {connection.platform ? ` · ${connection.platform}` : ''}
                        {connection.isDocker ? ' · Docker' : ''}
                      </span>
                    </span>
                    <span className="workspace-popover-tools">
                      <button
                        type="button"
                        className="workspace-popover-tool"
                        title="重新登录"
                        aria-label={`重新登录 ${connection.name}`}
                        disabled={disabled}
                        onClick={event => { event.stopPropagation(); relogin(connection); }}
                      ><LogIn aria-hidden="true" /></button>
                      <button
                        type="button"
                        className="workspace-popover-tool danger"
                        title="删除连接"
                        aria-label={`删除连接 ${connection.name}`}
                        disabled={disabled}
                        onClick={event => { event.stopPropagation(); removeConnection(connection); }}
                      ><Trash2 aria-hidden="true" /></button>
                    </span>
                    {isRunning && <Check className="workspace-popover-check" aria-hidden="true" />}
                  </div>
                );
              })}
            </div>
          )}

          {connections.length === 0 && (
            <div className="workspace-popover-empty">
              <Cloud aria-hidden="true" />
              <span>还没有远程服务器，添加后可在这里直接选择并进入。</span>
            </div>
          )}

          {showForm ? (
            <form className="workspace-popover-form" onSubmit={submitForm}>
              <div className="workspace-popover-form-title">
                <span>
                  {formMode === 'relogin'
                    ? '重新登录服务器'
                    : connections.length > 0 ? '添加新的服务器' : '添加远程服务器'}
                </span>
                {connections.length > 0 && (
                  <button
                    type="button"
                    className="workspace-popover-cancel"
                    disabled={disabled}
                    onClick={() => { setAdding(false); setFormMode('add'); setError(''); }}
                  >取消</button>
                )}
              </div>
              <label>连接名称（可选）
                <input
                  value={form.name}
                  onChange={event => setForm({ ...form, name: event.target.value })}
                  placeholder="例如：飞牛 Docker"
                  disabled={disabled}
                />
              </label>
              <label>服务地址
                <input
                  value={form.server}
                  onChange={event => setForm({ ...form, server: event.target.value })}
                  placeholder="https://192.168.1.10:9600"
                  required
                  disabled={disabled}
                />
              </label>
              <div className="workspace-popover-form-row">
                <label>账号
                  <input
                    value={form.username}
                    onChange={event => setForm({ ...form, username: event.target.value })}
                    required
                    disabled={disabled}
                  />
                </label>
                <label>密码
                  <input
                    type="password"
                    value={form.password}
                    onChange={event => setForm({ ...form, password: event.target.value })}
                    autoComplete="current-password"
                    required
                    disabled={disabled}
                  />
                </label>
              </div>
              <div className="workspace-popover-security">
                <ShieldCheck aria-hidden="true" />密码仅用于登录；登录令牌使用 Windows DPAPI 加密保存。
              </div>
              <div className="workspace-popover-actions">
                <button type="submit" className="btn-primary btn-sm" disabled={disabled}>
                  {busy === 'add'
                    ? <LoaderCircle className="workspace-spin" aria-hidden="true" />
                    : <Cloud aria-hidden="true" />}
                  {busy === 'add'
                    ? '正在连接…'
                    : formMode === 'relogin' ? '登录并进入' : '连接并进入'}
                </button>
              </div>
            </form>
          ) : (
            <div className="workspace-popover-actions">
              <button
                type="button"
                className="btn-secondary btn-sm"
                disabled={disabled}
                onClick={() => { setFormMode('add'); setAdding(true); setError(''); }}
              >
                <Plus aria-hidden="true" />添加服务器
              </button>
            </div>
          )}

          {error && <div className="workspace-popover-error" role="alert">{error}</div>}
        </div>
      )}
    </div>
  );
}
