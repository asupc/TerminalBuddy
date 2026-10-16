import { useEffect, useRef, useState } from 'react';
import { Check, ChevronRight, Download, FileJson, LoaderCircle, Plus, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import { Dialog, ConfirmDialog } from '../shared/Dialog';
import {
  activateClaudeProvider, createClaudeProvider, deactivateClaudeProvider, deleteClaudeProvider,
  getClaudeProviders, importCurrentClaudeProvider, updateClaudeProvider,
  type ClaudeAuthType, type ClaudeProvider, type ClaudeProviderInput, type ClaudeProviderList,
} from '../../services/browser/claudeProviders';
import './ClaudeProviders.css';

const emptyDraft = (): ClaudeProviderInput => ({
  name: '', baseUrl: '', authType: 'ANTHROPIC_AUTH_TOKEN', apiKey: '',
  model: '', opusModel: '', sonnetModel: '', haikuModel: '', extraEnv: {},
});
function errorText(reason: unknown) { return reason instanceof Error ? reason.message : '操作失败，请重试'; }
function parseEnv(text: string): Record<string, string> {
  let value: unknown;
  try { value = JSON.parse(text || '{}'); }
  catch { throw new Error('JSON 格式无效，请检查引号、逗号和括号'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.values(value).some(item => typeof item !== 'string')) {
    throw new Error('环境变量必须是 JSON 对象，所有值都应为字符串');
  }
  return value as Record<string, string>;
}

export function ClaudeProvidersDialog({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<ClaudeProviderList | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ClaudeProviderInput>(emptyDraft);
  const [extraText, setExtraText] = useState('{}');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dirty, setDirty] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importError, setImportError] = useState('');
  const [confirm, setConfirm] = useState<{ message: string; action: () => void; label: string } | null>(null);
  const operation = useRef(false);
  const selected = data?.providers.find(provider => provider.id === selectedId);
  const active = data?.providers.find(provider => provider.id === data.activeProviderId);

  const select = (provider?: ClaudeProvider) => {
    setSelectedId(provider?.id ?? null);
    setDraft(provider ? { ...provider, apiKey: '' } : emptyDraft());
    setExtraText(JSON.stringify(provider?.extraEnv ?? {}, null, 2));
    setDirty(false); setError(''); setNotice('');
  };
  const afterDiscard = (action: () => void) => {
    if (!dirty) { action(); return; }
    setConfirm({ message: '当前修改尚未保存，是否放弃修改？', label: '放弃修改', action: () => { select(selected); action(); } });
  };
  const close = () => { if (!operation.current) afterDiscard(onClose); };
  useEffect(() => {
    let cancelled = false;
    void getClaudeProviders().then(value => {
      if (cancelled) return;
      setData(value);
      select(value.providers.find(provider => provider.id === value.activeProviderId) ?? value.providers[0]);
    }).catch(reason => { if (!cancelled) setError(errorText(reason)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const perform = async (label: string, action: () => Promise<ClaudeProviderList>, message: string,
    choose?: (value: ClaudeProviderList) => ClaudeProvider | undefined) => {
    if (operation.current) return;
    operation.current = true; setBusy(label); setError(''); setNotice('');
    try {
      const value = await action();
      setData(value);
      if (choose) select(choose(value));
      setNotice(message);
    } catch (reason) { setError(errorText(reason)); }
    finally { operation.current = false; setBusy(''); }
  };
  const save = async () => {
    let input: ClaudeProviderInput;
    try {
      input = {
        name: draft.name, baseUrl: draft.baseUrl, authType: draft.authType,
        apiKey: draft.apiKey?.trim() || null, model: draft.model,
        opusModel: draft.opusModel, sonnetModel: draft.sonnetModel, haikuModel: draft.haikuModel,
        extraEnv: parseEnv(extraText),
      };
    } catch (reason) { setError(errorText(reason)); return; }
    const existing = new Set(data?.providers.map(provider => provider.id));
    const current = selectedId !== null && selectedId === data?.activeProviderId;
    await perform('save', () => selectedId ? updateClaudeProvider(selectedId, input) : createClaudeProvider(input),
      current ? '已保存并应用。请退出正在运行的 Claude，再输入 claude 启动。' : '已保存到数据库，点击“启用”即可切换。',
      value => value.providers.find(provider => selectedId ? provider.id === selectedId : !existing.has(provider.id)));
  };
  const field = (key: keyof ClaudeProviderInput, value: string) => {
    setDraft(previous => ({ ...previous, [key]: value })); setDirty(true); setNotice('');
  };
  const applyImportedJson = () => {
    try {
      let parsed: unknown;
      try { parsed = JSON.parse(importText); }
      catch { throw new Error('JSON 格式无效，请检查引号、逗号和括号'); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('请输入 JSON 对象');
      const source = parsed as Record<string, unknown>;
      const env = parseEnv(JSON.stringify(source.env ?? source));
      const take = (key: string) => { const value = env[key] ?? ''; delete env[key]; return value; };
      const token = take('ANTHROPIC_AUTH_TOKEN');
      const key = take('ANTHROPIC_API_KEY');
      if (token && key) throw new Error('请仅保留 ANTHROPIC_AUTH_TOKEN 或 ANTHROPIC_API_KEY 中的一项');
      const baseUrl = take('ANTHROPIC_BASE_URL');
      const model = take('ANTHROPIC_MODEL') || (typeof source.model === 'string' ? source.model : '');
      const opusModel = take('ANTHROPIC_DEFAULT_OPUS_MODEL');
      const sonnetModel = take('ANTHROPIC_DEFAULT_SONNET_MODEL');
      const haikuModel = take('ANTHROPIC_DEFAULT_HAIKU_MODEL');
      if (!baseUrl) throw new Error('JSON 中缺少 ANTHROPIC_BASE_URL');
      setDraft(previous => ({ ...previous, baseUrl, apiKey: token || key || previous.apiKey,
        authType: token ? 'ANTHROPIC_AUTH_TOKEN' : key ? 'ANTHROPIC_API_KEY' : previous.authType,
        model, opusModel, sonnetModel, haikuModel, extraEnv: env }));
      setExtraText(JSON.stringify(env, null, 2)); setDirty(true);
      setImportOpen(false); setImportText(''); setImportError(''); setNotice('JSON 已填入表单，确认后点击保存。');
    } catch (reason) { setImportError(errorText(reason)); }
  };
  const disabled = loading || Boolean(busy) || !data;

  return <>
    <Dialog title="Claude 模型配置" ariaLabel="Claude 模型配置" className="claude-providers-dialog"
      bodyClassName="claude-providers-body" onClose={close} closeDisabled={Boolean(busy)}
      onSubmit={event => { event.preventDefault(); if (!disabled) void save(); }}
      footer={<>
        <span className="claude-providers-storage">配置保存到服务器数据库 · 密钥加密存储</span>
        {busy && <LoaderCircle size={15} className="container-environment-spin" aria-label="正在处理" />}
        <button type="button" className="btn-secondary" disabled={Boolean(busy)} onClick={close}>关闭</button>
        <button type="submit" className="btn-primary" disabled={disabled || !draft.name.trim() || !draft.baseUrl.trim() || (!selected?.hasApiKey && !draft.apiKey?.trim())}>
          {busy === 'save' ? '保存中…' : selectedId === data?.activeProviderId && selectedId ? '保存并应用' : '保存配置'}
        </button>
      </>}
    >
      <div className="claude-providers-summary">
        <div><span className="claude-providers-eyebrow">自定义 API · Anthropic Messages 协议</span>
          <p>{active ? <>当前启用 <strong>{active.name}</strong></> : '添加自定义 API 配置，按需切换模型。'}</p>
        </div>
        <div className="claude-providers-toolbar">
          {active && <button type="button" className="claude-provider-quiet" disabled={disabled} onClick={() => setConfirm({
            message: `${dirty ? '尚未保存的修改将被放弃。' : ''}恢复启用前的 API 配置；已保存的条目仍会保留。运行中的 Claude 需要重新启动。`, label: '恢复原配置',
            action: () => { select(selected); void perform('restore', deactivateClaudeProvider, '已恢复原配置，请重新启动 Claude。'); },
          })}><RotateCcw size={14} />恢复原配置</button>}
          <button type="button" className="claude-provider-quiet" disabled={loading || Boolean(busy)} aria-label="刷新模型配置"
            onClick={() => afterDiscard(() => { void perform('refresh', getClaudeProviders, '', value => value.providers.find(p => p.id === selectedId)); })}>
            <RefreshCw size={15} /></button>
        </div>
      </div>
      {active && !data?.applied && <p className="claude-providers-warning" role="status">容器配置已在外部修改，点击当前条目的“重新应用”可恢复。</p>}
      {error && <p className="claude-providers-message error" role="alert">{error}</p>}
      {notice && <p className="claude-providers-message success" role="status">{notice}</p>}
      <div className="claude-providers-layout">
        <aside className="claude-providers-sidebar" aria-label="已保存的模型配置">
          <div className="claude-providers-list-heading"><span>配置条目 <b>{data?.providers.length ?? 0}</b></span>
            <button type="button" className="claude-provider-quiet" disabled={disabled} onClick={() => afterDiscard(() => select())}><Plus size={14} />新增</button></div>
          {loading ? <p className="claude-providers-empty">正在加载…</p> : !data?.providers.length && <p className="claude-providers-empty">还没有保存的配置<br />填写右侧表单，或导入当前配置。</p>}
          <div className="claude-providers-list">
            {data?.providers.map(provider => <div key={provider.id} className={`claude-provider-item${provider.id === selectedId ? ' selected' : ''}`}>
              <button type="button" className="claude-provider-select" disabled={Boolean(busy)} onClick={() => afterDiscard(() => select(provider))}>
                <span className="claude-provider-name">{provider.name}{provider.id === data.activeProviderId && <span className="claude-provider-active"><Check size={11} />已启用</span>}</span>
                <span className="claude-provider-endpoint">{provider.baseUrl}</span>
                <span className="claude-provider-model">{provider.model || '使用默认模型映射'}</span>
              </button>
              <div className="claude-provider-item-actions">
                <button type="button" className="claude-provider-quiet apply" disabled={Boolean(busy) || (provider.id === data.activeProviderId && data.applied)}
                  aria-label={`${provider.id === data.activeProviderId && !data.applied ? '重新应用' : '启用'} ${provider.name}`}
                  onClick={() => afterDiscard(() => { void perform('activate', () => activateClaudeProvider(provider.id), '已切换配置。请退出正在运行的 Claude，再输入 claude 启动。', value => value.providers.find(p => p.id === provider.id)); })}>
                  {provider.id === data.activeProviderId ? data.applied ? <><Check size={13} />使用中</> : '重新应用' : <>启用<ChevronRight size={13} /></>}
                </button>
                <button type="button" className="claude-provider-quiet delete" aria-label={`删除 ${provider.name}`}
                  disabled={Boolean(busy) || provider.id === data.activeProviderId} title={provider.id === data.activeProviderId ? '请先切换条目或恢复原配置' : '删除配置'}
                  onClick={() => setConfirm({ message: `${dirty ? '尚未保存的修改将被放弃。' : ''}确定删除“${provider.name}”吗？此操作无法撤销。`, label: '删除配置', action: () => {
                    void perform('delete', () => deleteClaudeProvider(provider.id), '配置已删除。', value => value.providers.find(p => p.id === selectedId) ?? value.providers[0]);
                  } })}><Trash2 size={13} /></button>
              </div>
            </div>)}
          </div>
          <button type="button" className="claude-provider-import" disabled={disabled || !data?.canImport}
            title={data?.canImport ? '将容器现有的 API 配置保存为新条目' : '当前容器没有可导入的第三方 API 配置'}
            onClick={() => afterDiscard(() => {
              const existing = new Set(data?.providers.map(p => p.id));
              void perform('import', importCurrentClaudeProvider, '当前配置已保存到数据库。', value => value.providers.find(p => !existing.has(p.id)));
            })}><Download size={14} />导入当前容器配置</button>
        </aside>
        <section className="claude-provider-editor" aria-label="配置编辑器">
          <div className="claude-provider-editor-heading"><div><h3>{selected ? '编辑配置' : '新增配置'}</h3><span>{selected ? '更新条目信息和模型映射' : '填写服务商提供的 API 信息'}</span></div>
            <button type="button" className="claude-provider-quiet" disabled={disabled} onClick={() => { setImportOpen(true); setImportError(''); }}><FileJson size={14} />从 JSON 填入</button></div>
          <fieldset disabled={disabled} className="claude-provider-fields">
            <label>配置名称 <span>*</span><input value={draft.name} maxLength={80} placeholder="例如：我的 DeepSeek" onChange={event => field('name', event.target.value)} required /></label>
            <label>API 地址 <span>*</span><input type="url" value={draft.baseUrl} maxLength={2048} placeholder="https://api.example.com/anthropic" onChange={event => field('baseUrl', event.target.value)} required />
              <small>填写 Anthropic 兼容的基础地址，请勿包含 /v1/messages。</small></label>
            <div className="claude-provider-auth-row">
              <label>认证方式<select value={draft.authType} onChange={event => field('authType', event.target.value as ClaudeAuthType)}>
                <option value="ANTHROPIC_AUTH_TOKEN">AUTH_TOKEN（Bearer）</option><option value="ANTHROPIC_API_KEY">API_KEY（x-api-key）</option>
              </select></label>
              <label>API 密钥 <span>*</span><input type="password" autoComplete="new-password" value={draft.apiKey ?? ''} maxLength={8192}
                placeholder={selected?.hasApiKey ? '已保存，留空保持不变' : '输入服务商 API Key'} onChange={event => field('apiKey', event.target.value)} required={!selected?.hasApiKey} /></label>
            </div>
            <label>默认模型<input value={draft.model} maxLength={256} placeholder="填写服务商模型 ID，如 deepseek-v4-pro[1m]" onChange={event => field('model', event.target.value)} />
              <small>使用服务商给出的准确模型 ID；留空时沿用 Claude 的默认选择。</small></label>
            <details className="claude-provider-advanced" open={Boolean(draft.opusModel || draft.sonnetModel || draft.haikuModel) || undefined}>
              <summary>模型映射与高级配置</summary>
              <div className="claude-provider-mappings">
                {([['opusModel', 'Opus 模型'], ['sonnetModel', 'Sonnet 模型'], ['haikuModel', 'Haiku 模型']] as const).map(([key,label]) =>
                  <label key={key}>{label}<input value={draft[key]} maxLength={256} placeholder="可选：对应档位使用的模型 ID" onChange={event => field(key,event.target.value)} /></label>)}
              </div>
              <label>额外环境变量（JSON）<textarea className="claude-provider-json" value={extraText} spellCheck={false} rows={5}
                onChange={event => { setExtraText(event.target.value); setDirty(true); setNotice(''); }} />
                <small>例如 {`{"API_TIMEOUT_MS":"600000"}`}。地址、密钥和默认模型请在上方填写。</small></label>
            </details>
          </fieldset>
          <p className="claude-provider-restart-note">切换后请重新启动 Claude。项目配置、终端环境变量和启动参数也可能影响最终使用的模型。</p>
        </section>
      </div>
    </Dialog>
    {importOpen && <Dialog title="从 JSON 填入" ariaLabel="从 JSON 填入" className="claude-provider-json-dialog"
      onClose={() => { setImportOpen(false); setImportText(''); }} footer={<>
        <button type="button" className="btn-secondary" onClick={() => { setImportOpen(false); setImportText(''); }}>取消</button>
        <button type="button" className="btn-primary" onClick={applyImportedJson}>填入表单</button>
      </>}>
      <p className="claude-providers-json-hint">支持 CC Switch / Claude settings.json 中的 env 对象，也可以直接粘贴环境变量 JSON。仅提取 API 和模型配置。</p>
      <textarea aria-label="供应商 JSON" className="claude-provider-json" rows={12} spellCheck={false} value={importText} maxLength={65536}
        placeholder={'{\n  "env": {\n    "ANTHROPIC_BASE_URL": "https://api.example.com",\n    "ANTHROPIC_AUTH_TOKEN": "your-api-key",\n    "ANTHROPIC_MODEL": "your-model"\n  }\n}'}
        onChange={event => setImportText(event.target.value)} />
      {importError && <p className="claude-providers-message error" role="alert">{importError}</p>}
    </Dialog>}
    {confirm && <ConfirmDialog title="确认操作" message={confirm.message} confirmText={confirm.label}
      onClose={() => setConfirm(null)} onConfirm={() => { const action = confirm.action; setConfirm(null); action(); }} />}
  </>;
}
