import { useCallback, useEffect, useRef, useState, type FC } from 'react';
import {
  cancelAntigravityOAuthLogin,
  completeAntigravityOAuthLogin,
  deleteAntigravityAccount,
  getAntigravityAccountState,
  importLocalAntigravityAccount,
  openUrl,
  renameAntigravityAccount,
  saveAntigravityAccountToken,
  setDefaultAntigravityAccount,
  startAntigravityOAuthLogin,
  type AntigravityAccountState,
  type AntigravityAccountView,
  type AntigravityOAuthStartResult,
} from '../../services/tauri';
import { useAppStore } from '../../stores/appStore';
import {
  Copy,
  Download,
  ExternalLink,
  Globe,
  KeyRound,
  Pencil,
  RefreshCw,
  Trash2,
  User,
} from 'lucide-react';
import { ConfirmDialog, Dialog } from '../shared/Dialog';
import '../claude-panel/segments/shared.css';
import '../claude-panel/segments/LlmProvidersSegment.css';
import './CodexProvidersSettings.css';
import './AntigravityAccountsSettings.css';

interface TokenEditorState {
  id?: string;
  alias: string;
  token: string;
  clientId: string;
  clientSecret: string;
}

const AUTH_SOURCE_LABEL: Record<string, string> = {
  oauth: '浏览器 OAuth',
  token: 'Token 录入',
  local_import: '本机导入',
};

export const AntigravityAccountsSettings: FC<{ active: boolean }> = ({ active }) => {
  const showToast = useAppStore(s => s.showToast);
  const setAntigravityAccountState = useAppStore(s => s.setAntigravityAccountState);
  const [state, setState] = useState<AntigravityAccountState | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [loadError, setLoadError] = useState('');
  const [tokenEditor, setTokenEditor] = useState<TokenEditorState | null>(null);
  const [oauthSession, setOauthSession] = useState<AntigravityOAuthStartResult | null>(null);
  const [oauthCode, setOauthCode] = useState('');
  const [oauthAlias, setOauthAlias] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<AntigravityAccountView | null>(null);
  const pendingRef = useRef(false);

  const load = useCallback(async () => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending('load');
    try {
      const next = await getAntigravityAccountState();
      setState(next);
      setAntigravityAccountState(next);
      setLoadError('');
    } catch (error) {
      setLoadError(String(error));
    } finally {
      pendingRef.current = false;
      setPending(null);
    }
  }, [setAntigravityAccountState]);

  useEffect(() => {
    if (active) void load();
  }, [active, load]);

  const mutate = async (
    name: string,
    task: () => Promise<AntigravityAccountState>,
    successMsg: string,
    onDone?: () => void,
  ) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(name);
    try {
      const next = await task();
      setState(next);
      setAntigravityAccountState(next);
      setLoadError('');
      onDone?.();
      showToast(successMsg, 'success');
    } catch (error) {
      showToast(String(error), 'error');
    } finally {
      pendingRef.current = false;
      setPending(null);
    }
  };

  const handleStartOAuth = async () => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending('oauth-start');
    try {
      const started = await startAntigravityOAuthLogin();
      setOauthSession(started);
      setOauthCode('');
      setOauthAlias('');
      void openUrl(started.authUrl);
    } catch (error) {
      showToast(String(error), 'error');
    } finally {
      pendingRef.current = false;
      setPending(null);
    }
  };

  const handleCloseOAuth = () => {
    if (pending === 'oauth-complete') return;
    const id = oauthSession?.loginId;
    setOauthSession(null);
    setOauthCode('');
    setOauthAlias('');
    if (id) void cancelAntigravityOAuthLogin(id).catch(() => {});
  };

  const handleCompleteOAuth = async () => {
    if (!oauthSession) return;
    const code = oauthCode.trim();
    if (!code) {
      showToast('请粘贴浏览器授权后显示的授权码', 'error');
      return;
    }
    const loginId = oauthSession.loginId;
    const alias = oauthAlias.trim() || undefined;
    await mutate(
      'oauth-complete',
      () => completeAntigravityOAuthLogin({ loginId, code, alias }),
      'Antigravity 账号授权并录入成功',
      () => {
        setOauthSession(null);
        setOauthCode('');
        setOauthAlias('');
      },
    );
  };

  const handleSaveToken = async () => {
    if (!tokenEditor) return;
    const isEditOnly = Boolean(tokenEditor.id) && !tokenEditor.token.trim();
    if (isEditOnly) {
      const alias = tokenEditor.alias.trim();
      if (!alias) {
        showToast('账号别名不能为空', 'error');
        return;
      }
      await mutate(
        'rename',
        () => renameAntigravityAccount(tokenEditor.id!, alias),
        '账号别名已更新',
        () => setTokenEditor(null),
      );
      return;
    }
    await mutate(
      'save-token',
      () =>
        saveAntigravityAccountToken({
          id: tokenEditor.id,
          alias: tokenEditor.alias.trim() || undefined,
          token: tokenEditor.token.trim(),
          clientId: tokenEditor.clientId.trim() || undefined,
          clientSecret: tokenEditor.clientSecret.trim() || undefined,
        }),
      tokenEditor.id ? '账号凭据已更新' : '已获取账号信息并保存',
      () => setTokenEditor(null),
    );
  };

  const busy = pending !== null;
  const accounts = state?.accounts ?? [];

  return (
    <div className="claude-segment llm-providers-segment codex-providers-settings ag-accounts-settings" aria-busy={busy}>
      <div className="claude-segment-toolbar">
        <span className="claude-segment-title">Antigravity 账号</span>
        <span className="claude-segment-actions">
          <button
            type="button"
            className="claude-segment-btn"
            disabled={busy}
            onClick={() => void handleStartOAuth()}
          >
            <Globe size={14} />
            {pending === 'oauth-start' ? '正在获取链接…' : '浏览器 OAuth 登录'}
          </button>
          <button
            type="button"
            className="claude-segment-btn"
            disabled={busy}
            onClick={() =>
              setTokenEditor({
                alias: '',
                token: '',
                clientId: '',
                clientSecret: '',
              })
            }
          >
            <KeyRound size={14} /> 录入授权 Token
          </button>
          <button
            type="button"
            className="claude-segment-btn"
            disabled={busy}
            onClick={() =>
              void mutate('import', importLocalAntigravityAccount, '已导入本机当前 Antigravity 账号')
            }
            title="从 ~/.gemini/antigravity-cli/antigravity-oauth-token 导入"
          >
            <Download size={14} /> 导入本机登录
          </button>
          <button
            type="button"
            className="claude-segment-btn"
            disabled={busy}
            aria-label="刷新 Antigravity 账号"
            onClick={() => void load()}
          >
            <RefreshCw size={14} />
          </button>
        </span>
      </div>

      <p className="codex-provider-description">
        管理多个 Google Antigravity 账号。授权凭据仅用于解析账号身份并写入独立隔离目录，绝不用于任何 LLM 调用；右键项目选择 Antigravity 即可指定不同账号并行启动。
      </p>

      {loadError && <div className="codex-provider-error" role="alert">{loadError}</div>}
      {pending === 'load' && !state && <div className="claude-segment-empty">正在读取 Antigravity 账号…</div>}

      {state && accounts.length === 0 && (
        <div className="claude-segment-empty">
          还没有录入 Antigravity 账号
          <small>点击「浏览器 OAuth 登录」或「录入授权 Token」添加账号，未录入时右键启动默认沿用本机系统登录</small>
        </div>
      )}

      <div className="llm-provider-list">
        {accounts.map(account => (
          <div
            key={account.id}
            className={`llm-provider-card codex-provider-card${account.isDefault ? ' is-active' : ''}`}
          >
            <div className="llm-provider-head">
              <span className="codex-provider-avatar ag-account-avatar">
                {account.picture ? (
                  <img src={account.picture} alt="" referrerPolicy="no-referrer" />
                ) : (
                  <User size={16} />
                )}
              </span>
              <span className="llm-provider-name" title={account.alias}>{account.alias}</span>
              {account.isDefault && <span className="llm-badge default">默认</span>}
              <span className="llm-badge">{AUTH_SOURCE_LABEL[account.authSource] ?? account.authSource}</span>
            </div>
            <div className="llm-provider-meta">
              <span title={account.email || account.name}>{account.email || account.name || '已通过官方 OAuth 授权'}</span>
            </div>
            {account.tokenHint && (
              <div className="llm-provider-meta">
                <span className="llm-key-tail">凭据已加密保存 ····{account.tokenHint}</span>
              </div>
            )}
            <div className="llm-provider-actions">
              {account.isDefault ? (
                <button
                  type="button"
                  className="claude-segment-btn mini"
                  disabled={busy}
                  onClick={() =>
                    void mutate('default', () => setDefaultAntigravityAccount(null), '已取消默认账号（改用系统当前登录）')
                  }
                >
                  取消默认
                </button>
              ) : (
                <button
                  type="button"
                  className="claude-segment-btn mini"
                  disabled={busy}
                  onClick={() =>
                    void mutate('default', () => setDefaultAntigravityAccount(account.id), `「${account.alias}」已设为默认账号`)
                  }
                >
                  设为默认
                </button>
              )}
              <button
                type="button"
                className="claude-segment-btn mini"
                disabled={busy}
                onClick={() =>
                  setTokenEditor({
                    id: account.id,
                    alias: account.alias,
                    token: '',
                    clientId: '',
                    clientSecret: '',
                  })
                }
              >
                <Pencil size={12} /> 编辑
              </button>
              <button
                type="button"
                className="claude-segment-btn mini danger"
                disabled={busy}
                onClick={() => setDeleteTarget(account)}
              >
                <Trash2 size={12} /> 删除
              </button>
            </div>
          </div>
        ))}
      </div>

      {tokenEditor && (
        <Dialog
          title={tokenEditor.id ? '编辑 Antigravity 账号' : '录入 Antigravity 授权 Token'}
          className="codex-provider-dialog ag-account-dialog"
          closeDisabled={busy}
          onClose={() => setTokenEditor(null)}
          onSubmit={event => {
            event.preventDefault();
            void handleSaveToken();
          }}
          footer={
            <>
              <button type="button" className="btn-secondary" disabled={busy} onClick={() => setTokenEditor(null)}>
                取消
              </button>
              <button type="submit" className="btn-primary" disabled={busy}>
                {pending === 'save-token' ? '正在验证账号…' : '保存'}
              </button>
            </>
          }
        >
          <fieldset className="codex-provider-fields" disabled={busy}>
            <label className="claude-form-row">
              账号别名（可选）
              <input
                type="text"
                maxLength={80}
                value={tokenEditor.alias}
                onChange={e => setTokenEditor({ ...tokenEditor, alias: e.target.value })}
                placeholder="例如：个人 Pro / 工作账号（留空自动取 Google 名称或邮箱）"
              />
            </label>
            <label className="claude-form-row">
              {tokenEditor.id ? '新授权 Token（留空则仅修改别名）' : '授权 Token'}
              <textarea
                rows={5}
                value={tokenEditor.token}
                onChange={e => setTokenEditor({ ...tokenEditor, token: e.target.value })}
                placeholder='粘贴完整的 antigravity-oauth-token JSON、access_token 或 refresh_token'
                spellCheck={false}
              />
            </label>
            <details className="codex-provider-advanced">
              <summary>高级选项（仅单独录入 refresh_token 时填写）</summary>
              <div className="codex-provider-fields">
                <label className="claude-form-row">
                  OAuth Client ID
                  <input
                    type="text"
                    value={tokenEditor.clientId}
                    onChange={e => setTokenEditor({ ...tokenEditor, clientId: e.target.value })}
                    spellCheck={false}
                  />
                </label>
                <label className="claude-form-row">
                  OAuth Client Secret
                  <input
                    type="password"
                    value={tokenEditor.clientSecret}
                    onChange={e => setTokenEditor({ ...tokenEditor, clientSecret: e.target.value })}
                    spellCheck={false}
                  />
                </label>
              </div>
            </details>
          </fieldset>
        </Dialog>
      )}

      {oauthSession && (
        <Dialog
          title="浏览器 OAuth 授权登录"
          className="codex-provider-dialog ag-account-dialog"
          closeDisabled={pending === 'oauth-complete'}
          onClose={handleCloseOAuth}
          onSubmit={event => {
            event.preventDefault();
            if (oauthCode.trim()) void handleCompleteOAuth();
          }}
          footer={
            <>
              <button
                type="button"
                className="btn-secondary"
                disabled={pending === 'oauth-complete'}
                onClick={handleCloseOAuth}
              >
                取消
              </button>
              <button
                type="submit"
                className="btn-primary"
                disabled={pending === 'oauth-complete' || !oauthCode.trim()}
              >
                {pending === 'oauth-complete' ? '正在完成授权…' : '完成授权'}
              </button>
            </>
          }
        >
          <p className="codex-provider-description">
            1. 已尝试在系统浏览器中打开 Google 授权页；如未自动打开，可点击下方按钮打开或复制链接。
            <br />
            2. 登录并同意授权后，将页面显示的授权码（4/0A…）粘贴到下方即可完成绑定。
          </p>
          <fieldset className="codex-provider-fields" disabled={pending === 'oauth-complete'}>
            <div className="claude-form-row">
              <span>授权链接</span>
              <div className="ag-oauth-url-row">
                <input type="text" readOnly value={oauthSession.authUrl} />
                <button
                  type="button"
                  className="claude-segment-btn"
                  onClick={() => void openUrl(oauthSession.authUrl)}
                  title="在浏览器打开"
                >
                  <ExternalLink size={13} /> 打开
                </button>
                <button
                  type="button"
                  className="claude-segment-btn"
                  onClick={() => {
                    navigator.clipboard.writeText(oauthSession.authUrl).catch(() => {});
                    showToast('授权链接已复制', 'success');
                  }}
                  title="复制授权链接"
                >
                  <Copy size={13} /> 复制
                </button>
              </div>
            </div>
            <label className="claude-form-row">
              授权码（Authorization Code）
              <input
                type="text"
                required
                autoFocus
                value={oauthCode}
                onChange={e => setOauthCode(e.target.value)}
                placeholder="粘贴 Google 授权回调页上的代码（例如 4/0A...）"
                spellCheck={false}
              />
            </label>
            <label className="claude-form-row">
              账号别名（可选）
              <input
                type="text"
                maxLength={80}
                value={oauthAlias}
                onChange={e => setOauthAlias(e.target.value)}
                placeholder="留空则默认使用 Google 名称或邮箱"
              />
            </label>
          </fieldset>
        </Dialog>
      )}

      {deleteTarget && (
        <ConfirmDialog
          title="删除 Antigravity 账号"
          message={`确定删除账号「${deleteTarget.alias}」${deleteTarget.email ? `（${deleteTarget.email}）` : ''}吗？其本地加密凭据与隔离配置目录将一并清除。`}
          confirmText="删除"
          confirmVariant="danger"
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => {
            const id = deleteTarget.id;
            setDeleteTarget(null);
            void mutate('delete', () => deleteAntigravityAccount(id), '已删除 Antigravity 账号');
          }}
        />
      )}
    </div>
  );
};
