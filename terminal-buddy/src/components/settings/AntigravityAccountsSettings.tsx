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
  ShieldCheck,
  Star,
  Trash2,
} from 'lucide-react';
import { ConfirmDialog, Dialog } from '../shared/Dialog';
import '../claude-panel/segments/shared.css';
import '../claude-panel/segments/LlmProvidersSegment.css';
import './AntigravityAccountsSettings.css';

interface TokenEditorState {
  id?: string;
  alias: string;
  token: string;
  clientId: string;
  clientSecret: string;
  showAdvanced: boolean;
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

  const accounts = state?.accounts ?? [];

  return (
    <div className="ag-accounts-settings">
      <div className="ag-accounts-notice">
        <ShieldCheck size={15} className="ag-accounts-notice-icon" />
        <span>
          授权 Token 仅用于解析 Google 账号身份（邮箱/昵称）并写入独立隔离目录，绝不用于任何 LLM 模型调用；不同账号会话可同时并行运行。
        </span>
      </div>

      <div className="ag-accounts-toolbar">
        <button
          type="button"
          className="tb-btn tb-btn-primary"
          disabled={pending !== null}
          onClick={() => void handleStartOAuth()}
        >
          <Globe size={14} />
          <span>{pending === 'oauth-start' ? '正在获取授权链接…' : '浏览器 OAuth 登录'}</span>
        </button>
        <button
          type="button"
          className="tb-btn"
          disabled={pending !== null}
          onClick={() =>
            setTokenEditor({
              alias: '',
              token: '',
              clientId: '',
              clientSecret: '',
              showAdvanced: false,
            })
          }
        >
          <KeyRound size={14} />
          <span>录入授权 Token</span>
        </button>
        <button
          type="button"
          className="tb-btn"
          disabled={pending !== null}
          onClick={() =>
            void mutate('import', importLocalAntigravityAccount, '已导入本机当前 Antigravity 账号')
          }
          title="从 ~/.gemini/antigravity-cli/antigravity-oauth-token 导入"
        >
          <Download size={14} />
          <span>导入本机登录</span>
        </button>
        <button
          type="button"
          className="tb-btn tb-btn-icon"
          disabled={pending !== null}
          onClick={() => void load()}
          title="刷新账号列表"
        >
          <RefreshCw size={14} className={pending === 'load' ? 'spin' : undefined} />
        </button>
      </div>

      {loadError && <div className="ag-accounts-error">{loadError}</div>}

      {accounts.length === 0 ? (
        <div className="ag-accounts-empty">
          <p>暂未录入 Antigravity 账号。</p>
          <p className="ag-accounts-empty-sub">
            可通过上方「浏览器 OAuth 登录」或「录入授权 Token」添加多个账号，添加后在项目右键菜单选择 Antigravity 即可指定账号并行启动。
          </p>
        </div>
      ) : (
        <div className="ag-accounts-list">
          {accounts.map(account => {
            const initial = (account.alias || account.email || 'A').slice(0, 1).toUpperCase();
            return (
              <div
                key={account.id}
                className={`ag-account-card${account.isDefault ? ' is-default' : ''}`}
              >
                <div className="ag-account-main">
                  <div className="ag-account-avatar">
                    {account.picture ? (
                      <img src={account.picture} alt="" referrerPolicy="no-referrer" />
                    ) : (
                      <span>{initial}</span>
                    )}
                  </div>
                  <div className="ag-account-meta">
                    <div className="ag-account-title-row">
                      <span className="ag-account-alias">{account.alias}</span>
                      {account.isDefault && <span className="ag-account-badge default">默认</span>}
                      <span className="ag-account-badge">
                        {AUTH_SOURCE_LABEL[account.authSource] ?? account.authSource}
                      </span>
                    </div>
                    <div className="ag-account-sub">
                      <span>{account.email || account.name || '未返回邮箱'}</span>
                      {account.tokenHint && <span className="ag-account-hint">Token: {account.tokenHint}</span>}
                    </div>
                  </div>
                </div>
                <div className="ag-account-actions">
                  <button
                    type="button"
                    className="tb-btn tb-btn-sm"
                    disabled={pending !== null}
                    onClick={() =>
                      void mutate(
                        'default',
                        () => setDefaultAntigravityAccount(account.isDefault ? null : account.id),
                        account.isDefault ? '已取消默认账号（改用系统当前登录）' : `已设为默认账号：${account.alias}`,
                      )
                    }
                    title={account.isDefault ? '取消默认账号' : '设为默认账号'}
                  >
                    <Star size={13} />
                    <span>{account.isDefault ? '取消默认' : '设为默认'}</span>
                  </button>
                  <button
                    type="button"
                    className="tb-btn tb-btn-sm tb-btn-icon"
                    disabled={pending !== null}
                    onClick={() =>
                      setTokenEditor({
                        id: account.id,
                        alias: account.alias,
                        token: '',
                        clientId: '',
                        clientSecret: '',
                        showAdvanced: false,
                      })
                    }
                    title="编辑别名或更新 Token"
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    type="button"
                    className="tb-btn tb-btn-sm tb-btn-icon danger"
                    disabled={pending !== null}
                    onClick={() => setDeleteTarget(account)}
                    title="删除账号"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {tokenEditor && (
        <Dialog
          title={tokenEditor.id ? '编辑 Antigravity 账号' : '录入 Antigravity 授权 Token'}
          onClose={() => pending === null && setTokenEditor(null)}
        >
          <div className="ag-dialog-body">
            <label className="ag-field">
              <span>账号别名（可选，默认使用 Google 名称/邮箱）</span>
              <input
                type="text"
                value={tokenEditor.alias}
                placeholder="例如：个人 Pro / 公司账号"
                onChange={e => setTokenEditor({ ...tokenEditor, alias: e.target.value })}
              />
            </label>
            <label className="ag-field">
              <span>
                {tokenEditor.id
                  ? '新授权 Token（留空则仅修改别名）'
                  : '授权 Token（支持完整 antigravity-oauth-token JSON、access_token 或 refresh_token）'}
              </span>
              <textarea
                rows={5}
                value={tokenEditor.token}
                placeholder='{"access_token":"ya29...","refresh_token":"1//...","id_token":"eyJ..."}'
                onChange={e => setTokenEditor({ ...tokenEditor, token: e.target.value })}
              />
            </label>
            <button
              type="button"
              className="ag-advanced-toggle"
              onClick={() =>
                setTokenEditor({ ...tokenEditor, showAdvanced: !tokenEditor.showAdvanced })
              }
            >
              {tokenEditor.showAdvanced ? '收起高级 OAuth 参数' : '仅录入 refresh_token 时展开 OAuth Client 参数'}
            </button>
            {tokenEditor.showAdvanced && (
              <div className="ag-advanced-fields">
                <label className="ag-field">
                  <span>OAuth Client ID（可选）</span>
                  <input
                    type="text"
                    value={tokenEditor.clientId}
                    onChange={e => setTokenEditor({ ...tokenEditor, clientId: e.target.value })}
                  />
                </label>
                <label className="ag-field">
                  <span>OAuth Client Secret（可选）</span>
                  <input
                    type="password"
                    value={tokenEditor.clientSecret}
                    onChange={e => setTokenEditor({ ...tokenEditor, clientSecret: e.target.value })}
                  />
                </label>
              </div>
            )}
            <div className="ag-dialog-footer">
              <button
                type="button"
                className="tb-btn"
                disabled={pending !== null}
                onClick={() => setTokenEditor(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="tb-btn tb-btn-primary"
                disabled={pending !== null}
                onClick={() => void handleSaveToken()}
              >
                {pending === 'save-token' ? '正在验证账号信息…' : '保存'}
              </button>
            </div>
          </div>
        </Dialog>
      )}

      {oauthSession && (
        <Dialog title="浏览器 OAuth 授权登录" onClose={handleCloseOAuth}>
          <div className="ag-dialog-body">
            <p className="ag-oauth-steps">
              1. 已尝试在系统浏览器打开 Google 授权页；如未自动弹出，可点击下方按钮打开或复制链接。
              <br />
              2. 完成 Google 账号登录后，将页面显示的授权码粘贴到下方即可自动获取账号信息并保存。
            </p>
            <div className="ag-oauth-url-row">
              <input type="text" readOnly value={oauthSession.authUrl} />
              <button
                type="button"
                className="tb-btn tb-btn-sm"
                onClick={() => void openUrl(oauthSession.authUrl)}
                title="在浏览器打开"
              >
                <ExternalLink size={13} />
                <span>打开</span>
              </button>
              <button
                type="button"
                className="tb-btn tb-btn-sm"
                onClick={() => {
                  navigator.clipboard.writeText(oauthSession.authUrl).catch(() => {});
                  showToast('授权链接已复制', 'success');
                }}
                title="复制授权链接"
              >
                <Copy size={13} />
              </button>
            </div>
            <label className="ag-field">
              <span>授权码（Authorization Code）</span>
              <input
                type="text"
                value={oauthCode}
                placeholder="粘贴浏览器回调页面上的授权码"
                autoFocus
                onChange={e => setOauthCode(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && oauthCode.trim()) void handleCompleteOAuth();
                }}
              />
            </label>
            <label className="ag-field">
              <span>账号别名（可选）</span>
              <input
                type="text"
                value={oauthAlias}
                placeholder="留空则默认使用 Google 名称/邮箱"
                onChange={e => setOauthAlias(e.target.value)}
              />
            </label>
            <div className="ag-dialog-footer">
              <button
                type="button"
                className="tb-btn"
                disabled={pending === 'oauth-complete'}
                onClick={handleCloseOAuth}
              >
                取消
              </button>
              <button
                type="button"
                className="tb-btn tb-btn-primary"
                disabled={pending === 'oauth-complete' || !oauthCode.trim()}
                onClick={() => void handleCompleteOAuth()}
              >
                {pending === 'oauth-complete' ? '正在换取凭据并识别账号…' : '完成授权'}
              </button>
            </div>
          </div>
        </Dialog>
      )}

      {deleteTarget && (
        <ConfirmDialog
          title="删除 Antigravity 账号"
          message={`确定删除账号「${deleteTarget.alias}」（${deleteTarget.email || deleteTarget.id}）吗？其本地加密凭据与隔离配置目录将一并清除。`}
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
