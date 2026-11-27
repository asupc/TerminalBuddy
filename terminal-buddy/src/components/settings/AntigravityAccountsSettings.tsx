import { useCallback, useEffect, useRef, useState, type FC } from 'react';
import {
  cancelAntigravityOAuthLogin,
  completeAntigravityOAuthLogin,
  deleteAntigravityAccount,
  getAntigravityAccountQuota,
  getAntigravityAccountState,
  importLocalAntigravityAccount,
  openUrl,
  saveAntigravityAccountToken,
  setDefaultAntigravityAccount,
  startAntigravityOAuthLogin,
  type AntigravityAccountState,
  type AntigravityAccountView,
  type AntigravityOAuthStartResult,
  type AntigravityQuotaSummary,
  type AntigravityQuotaWindow,
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
  planTier: '' | 'Plus' | 'Pro' | 'Ultra';
}

const AUTH_SOURCE_LABEL: Record<string, string> = {
  oauth: '浏览器 OAuth',
  token: 'Token 录入',
  local_import: '本机导入',
};

interface AccountQuotaEntry {
  data?: AntigravityQuotaSummary;
  loading: boolean;
  error?: string;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function formatQuotaResetDetail(raw?: string | null): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const ms = /^\d{10,13}$/.test(trimmed)
    ? (trimmed.length === 10 ? Number(trimmed) * 1000 : Number(trimmed))
    : Date.parse(trimmed);
  if (!Number.isNaN(ms)) {
    const d = new Date(ms);
    const clock = `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    const diffSec = Math.floor((ms - Date.now()) / 1000);
    if (diffSec <= 0) return `已刷新（${clock}）`;
    const days = Math.floor(diffSec / 86400);
    const hours = Math.floor((diffSec % 86400) / 3600);
    const mins = Math.floor((diffSec % 3600) / 60);
    const rel = days > 0 ? `${days}天${hours}小时` : hours > 0 ? `${hours}小时${mins}分` : `${Math.max(1, mins)}分钟`;
    return `${rel}后刷新（${clock}）`;
  }
  const cleaned = trimmed.replace(/^(?:resets?\s+(?:in|at)\s+|in\s+|刷新于\s*|重置于\s*)/i, '').trim() || trimmed;
  return `刷新：${cleaned}`;
}

function quotaWindowLabel(w: AntigravityQuotaWindow): string {
  if (w.kind === 'session_5h') return w.label || '5小时额度';
  if (w.kind === 'weekly') return w.label || '周额度';
  return w.label || 'Gemini 额度';
}

function normalizeTierLabel(raw?: string | null): 'Plus' | 'Pro' | 'Ultra' | null {
  if (!raw) return null;
  const lower = raw.trim().toLowerCase();
  if (lower.includes('ultra')) return 'Ultra';
  if (lower.includes('pro')) return 'Pro';
  if (lower.includes('plus')) return 'Plus';
  return null;
}

function quotaLevelClass(percent: number | null): string {
  if (percent == null) return '';
  if (percent < 15) return ' is-low';
  if (percent < 40) return ' is-warn';
  return ' is-ok';
}

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
  const [quotas, setQuotas] = useState<Record<string, AccountQuotaEntry>>({});
  const pendingRef = useRef(false);
  const quotaInFlightRef = useRef<Set<string>>(new Set());

  const fetchAccountQuota = useCallback(async (accountId: string, forceRefresh = false) => {
    if (quotaInFlightRef.current.has(accountId)) return;
    quotaInFlightRef.current.add(accountId);
    setQuotas(prev => ({
      ...prev,
      [accountId]: { ...prev[accountId], loading: true, error: undefined },
    }));
    try {
      const data = await getAntigravityAccountQuota(accountId, forceRefresh);
      setQuotas(prev => ({
        ...prev,
        [accountId]: { data, loading: false, error: undefined },
      }));
    } catch (error) {
      setQuotas(prev => ({
        ...prev,
        [accountId]: { ...prev[accountId], loading: false, error: error instanceof Error ? error.message : String(error) },
      }));
    } finally {
      quotaInFlightRef.current.delete(accountId);
    }
  }, []);

  const load = useCallback(async (forceQuotaRefresh = false) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending('load');
    try {
      const next = await getAntigravityAccountState();
      setState(next);
      setAntigravityAccountState(next);
      setLoadError('');
      for (const account of next.accounts) {
        void fetchAccountQuota(account.id, forceQuotaRefresh);
      }
    } catch (error) {
      setLoadError(String(error));
    } finally {
      pendingRef.current = false;
      setPending(null);
    }
  }, [fetchAccountQuota, setAntigravityAccountState]);

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
        () =>
          saveAntigravityAccountToken({
            id: tokenEditor.id,
            alias,
            token: '',
            planTier: tokenEditor.planTier,
          }),
        '账号信息已更新',
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
          planTier: tokenEditor.planTier || undefined,
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
                planTier: '',
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
              void mutate('import', importLocalAntigravityAccount, '已导入本机 Antigravity CLI 登录账号')
            }
            title="从本机 Antigravity CLI（agy）的系统凭据管理器或 ~/.gemini/antigravity-cli 导入"
          >
            <Download size={14} /> 导入本机 CLI 登录
          </button>
          <button
            type="button"
            className="claude-segment-btn"
            disabled={busy}
            title="刷新账号列表与全部额度"
            aria-label="刷新 Antigravity 账号"
            onClick={() => void load(true)}
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
              {(() => {
                const tier = normalizeTierLabel(quotas[account.id]?.data?.planTier ?? account.planTier);
                return tier ? (
                  <span className={`llm-badge ag-tier-badge tier-${tier.toLowerCase()}`} title={`Google AI ${tier}`}>
                    {tier}
                  </span>
                ) : null;
              })()}
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
            {(() => {
              const q = quotas[account.id];
              const windows = q?.data?.geminiWindows ?? [];
              return (
                <div className="ag-account-quota">
                  <div className="ag-account-quota-head">
                    <span className="ag-account-quota-title">Gemini 额度</span>
                    <button
                      type="button"
                      className={`ag-account-quota-refresh${q?.loading ? ' is-spinning' : ''}`}
                      disabled={q?.loading}
                      title="刷新该账号 5小时/周额度"
                      onClick={() => void fetchAccountQuota(account.id, true)}
                    >
                      <RefreshCw size={12} />
                      <span>{q?.loading ? '查询中…' : '刷新额度'}</span>
                    </button>
                  </div>
                  {q?.loading && !q.data ? (
                    <div className="ag-account-quota-empty">正在查询 5小时 / 周额度…</div>
                  ) : windows.length > 0 ? (
                    <div className="ag-account-quota-grid">
                      {windows.map((w, idx) => {
                        const pct = w.remainingPercent;
                        const resetDetail = formatQuotaResetDetail(w.resetText);
                        return (
                          <div key={`${w.kind}-${w.label}-${idx}`} className="ag-account-quota-window">
                            <div className="ag-account-quota-row">
                              <span className="ag-account-quota-label">{quotaWindowLabel(w)}</span>
                              <span className={`ag-account-quota-value${quotaLevelClass(pct)}`}>
                                {pct != null ? `剩余 ${pct}%` : '—'}
                              </span>
                            </div>
                            {pct != null && (
                              <div className="ag-account-quota-bar" aria-hidden="true">
                                <span
                                  className={`ag-account-quota-bar-fill${quotaLevelClass(pct)}`}
                                  style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
                                />
                              </div>
                            )}
                            {resetDetail && (
                              <div className="ag-account-quota-reset" title={w.resetText ?? undefined}>
                                {resetDetail}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ) : q?.data?.geminiPercent != null ? (
                    <div className="ag-account-quota-empty">剩余 {q.data.geminiPercent}%</div>
                  ) : q?.error ? (
                    <div className="ag-account-quota-error" title={q.error}>查询失败：{q.error}</div>
                  ) : q?.data?.rawSummary ? (
                    <div className="ag-account-quota-empty" title={q.data.rawSummary}>{q.data.rawSummary}</div>
                  ) : (
                    <div className="ag-account-quota-empty">暂无额度数据，点击「刷新额度」重试</div>
                  )}
                </div>
              );
            })()}
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
                    planTier: normalizeTierLabel(quotas[account.id]?.data?.planTier ?? account.planTier) ?? '',
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
