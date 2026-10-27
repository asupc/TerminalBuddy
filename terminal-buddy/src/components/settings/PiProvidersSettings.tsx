import { useCallback, useEffect, useRef, useState, type FC } from 'react';
import {
  PI_API_OPTIONS,
  PI_KEY_MODE_OPTIONS,
  PI_THINKING_FORMAT_OPTIONS,
  activatePiProvider,
  clearDefaultPiProvider,
  deletePiProvider,
  emptyPiCompat,
  fetchPiProviderModels,
  getPiProviderState,
  importPiProvider,
  savePiProvider,
  type PiCompatConfig,
  type PiKeyMode,
  type PiModelConfig,
  type PiProviderInput,
  type PiProviderState,
  type PiProviderView,
} from '../../services/tauri';
import { useAppStore } from '../../stores/appStore';
import { Plus, RefreshCw, Download, Pencil, Trash2, Server } from 'lucide-react';
import { PiModelPicker } from './PiModelPicker';
import { ConfirmDialog, Dialog } from '../shared/Dialog';
import '../claude-panel/segments/shared.css';
import '../claude-panel/segments/LlmProvidersSegment.css';
import './PiProvidersSettings.css';

interface Editor extends PiProviderInput {
  apiKey: string;
  keySet: boolean;
  /** env/command 形态沿用时展示旧原文；literal 形态为末 4 位。 */
  keyTail: string;
  compatExtraText: string;
}

function emptyEditor(): Editor {
  return {
    name: '', piProviderId: '', baseUrl: '', apiKey: '', keyMode: 'literal',
    api: 'openai-completions', authHeader: false, headers: {},
    model: '', models: [], availableModels: [], compat: emptyPiCompat(),
    keySet: false, keyTail: '', compatExtraText: '',
  };
}

function compatToText(compat: PiCompatConfig): string {
  // 后端序列化会省略空 extra；此处按空对象处理。
  const extra = compat.extra ?? {};
  const keys = Object.keys(extra);
  return keys.length ? JSON.stringify(extra, null, 2) : '';
}

/** 归一化后端视图：空字段（compat.extra / thinkingLevelMap.levels）会被省略，编辑器需要空对象兜底。 */
function normalizeModel(model: PiModelConfig): PiModelConfig {
  return {
    ...model,
    defaultThinking: model.defaultThinking ?? null,
    thinkingLevelMap: { levels: model.thinkingLevelMap?.levels ?? {} },
    compat: { ...model.compat, extra: model.compat?.extra ?? {} },
  };
}

function editorFrom(provider: PiProviderView): Editor {
  return {
    ...provider,
    compat: { ...provider.compat, extra: provider.compat?.extra ?? {} },
    models: provider.models.map(normalizeModel),
    headers: { ...provider.headers },
    apiKey: '',
    compatExtraText: compatToText(provider.compat),
  };
}

export const PiProvidersSettings: FC<{ active: boolean }> = ({ active }) => {
  const showToast = useAppStore(s => s.showToast);
  const refreshPiModels = useAppStore(s => s.refreshPiModels);
  const [state, setState] = useState<PiProviderState | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [loadError, setLoadError] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<PiProviderView | null>(null);
  const [importTarget, setImportTarget] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const requestVersion = useRef(0);

  const load = useCallback(async () => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending('load');
    try {
      const next = await getPiProviderState();
      setState(next);
      setLoadError('');
    } catch (error) {
      setLoadError(String(error));
    } finally {
      pendingRef.current = false;
      setPending(null);
    }
  }, []);

  useEffect(() => {
    if (active) void load();
  }, [active, load]);

  useEffect(() => () => { requestVersion.current += 1; }, []);

  const mutate = async (name: string, task: () => Promise<PiProviderState>, message: string, closeEditor = false) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(name);
    try {
      const next = await task();
      setState(next);
      setLoadError('');
      if (closeEditor) { setEditor(null); setModels([]); }
      // models.json 已同步，强制刷新右键菜单的 Pi 模型缓存以回显生效结果。
      void refreshPiModels(true).catch(() => undefined);
      showToast(message, 'success');
    } catch (error) {
      showToast(String(error), 'error');
    } finally {
      pendingRef.current = false;
      setPending(null);
    }
  };

  const edit = (provider?: PiProviderView) => {
    requestVersion.current += 1;
    setModels(provider?.availableModels ?? []);
    setEditor(provider ? editorFrom(provider) : emptyEditor());
  };

  const save = async (activate: boolean) => {
    if (!editor) return;
    let compatExtra: Record<string, unknown> = {};
    const extraText = editor.compatExtraText.trim();
    if (extraText) {
      try {
        const parsed: unknown = JSON.parse(extraText);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not-object');
        compatExtra = parsed as Record<string, unknown>;
      } catch {
        showToast('compat 透传必须是 JSON 对象', 'error');
        return;
      }
    }
    const configured = editor.models.filter(model => model.id.trim());
    if (!editor.name.trim() || !editor.piProviderId.trim() || !editor.baseUrl.trim() || configured.length === 0) {
      showToast('请填写供应商名称、Pi 供应商 ID、API 地址，并至少配置一个模型', 'error');
      return;
    }
    if (!editor.keySet && !editor.apiKey.trim()) {
      showToast('请填写 API 密钥', 'error');
      return;
    }
    const input: PiProviderInput = {
      id: editor.id,
      name: editor.name.trim(), piProviderId: editor.piProviderId.trim(), baseUrl: editor.baseUrl.trim(),
      apiKey: editor.apiKey.trim() || undefined, keyMode: editor.keyMode,
      api: editor.api, authHeader: editor.authHeader, headers: editor.headers,
      model: editor.model.trim(), models: configured,
      availableModels: models,
      compat: { ...editor.compat, extra: compatExtra },
    };
    const willActivate = activate || state?.providers.length === 0 || (!!editor.id && state?.activeProviderId === editor.id);
    await mutate('save', () => savePiProvider(input, activate),
      willActivate ? 'Pi 供应商已保存并设为默认，同步到 models.json' : 'Pi 供应商已保存并同步到 models.json', true);
  };

  const fetchModels = async () => {
    if (!editor || pendingRef.current) return;
    if (!editor.baseUrl.trim() || (!editor.apiKey.trim() && !editor.keySet)) {
      showToast('请先填写 API 地址和密钥', 'error');
      return;
    }
    pendingRef.current = true;
    setPending('fetch');
    const version = ++requestVersion.current;
    try {
      const fetched = await fetchPiProviderModels(editor.baseUrl.trim(), editor.apiKey.trim(), editor.id);
      const next = editor.id ? await getPiProviderState() : null;
      if (version !== requestVersion.current) return;
      const ids = [...new Set(fetched.map(model => model.id))];
      setModels(ids);
      if (next) setState(next);
      showToast(fetched.length ? `已更新 ${fetched.length} 个模型，可在模型行中选择` : '未获取到模型，可手动填写模型 ID', fetched.length ? 'success' : 'info');
    } catch (error) {
      if (version === requestVersion.current) showToast(`${String(error)}；也可手动填写模型 ID`, 'error');
    } finally {
      pendingRef.current = false;
      setPending(null);
    }
  };

  const busy = pending !== null;

  return (
    <div className="claude-segment llm-providers-segment pi-providers-settings" aria-busy={busy}>
      <div className="claude-segment-toolbar">
        <span className="claude-segment-title">Pi 供应商</span>
        <span className="claude-segment-actions">
          <button type="button" className="claude-segment-btn" disabled={busy || !state} onClick={() => edit()}><Plus size={14} /> 添加供应商</button>
          <button type="button" className="claude-segment-btn" disabled={busy} aria-label="刷新 Pi 供应商" onClick={() => void load()}><RefreshCw size={14} /></button>
        </span>
      </div>

      <p className="pi-provider-description">
        管理 Pi 的兼容端点：保存后自动同步到 Pi 的 models.json，Pi 多 provider 并存、保存即生效（打开 /model 可见）。
        设为默认后右键启动菜单会平铺该供应商的模型；已用 /login 登录的内置供应商不受影响，auth.json 凭证优先于此处配置的密钥。
      </p>
      {state && state.providers.length > 0 && !state.activeProviderId && !state.configError && (
        <p className="pi-provider-description">当前未设置默认供应商，可选择一项设为默认；右键菜单仍可按供应商选择模型启动。</p>
      )}
      {state && <p className="pi-provider-path" title={state.modelsPath}>配置文件：{state.modelsPath}</p>}
      {(loadError || state?.configError) && <div className="pi-provider-error" role="alert">{loadError || state?.configError}</div>}
      {pending === 'load' && !state && <div className="claude-segment-empty">正在读取 Pi 配置…</div>}
      {state?.providers.length === 0 && !editor && (
        <div className="claude-segment-empty">
          还没有配置 Pi 供应商
          <small>新增 API 地址、密钥与模型，或从 models.json 导入已有的兼容端点</small>
        </div>
      )}

      <div className="llm-provider-list">
        {state?.providers.map(provider => {
          const isActive = state.activeProviderId === provider.id;
          return (
          <div key={provider.id} className={`llm-provider-card pi-provider-card${isActive ? ' is-active' : ''}`}>
            <div className="llm-provider-head">
              <span className="pi-provider-avatar"><Server size={18} /></span>
              <span className="llm-provider-name" title={provider.name}>{provider.name}</span>
              {isActive && <span className="llm-badge default">默认</span>}
              {editor?.id === provider.id && <span className="llm-badge editing">编辑中</span>}
            </div>
            <div className="llm-provider-meta"><span title={provider.baseUrl}>{provider.baseUrl}</span></div>
            <div className="llm-provider-meta">
              <span title={`Pi 供应商 ID：${provider.piProviderId}`}>ID：{provider.piProviderId}</span>
              <span title={provider.api}>{provider.api}</span>
            </div>
            <div className="llm-provider-meta">
              <span title={provider.model}>默认：{provider.model}</span>
            </div>
            <div className="pi-provider-model-tags">
              {provider.models.map(model => (
                <span key={model.id} className="llm-badge" title={`${model.id}${model.reasoning ? ' · 推理' : ''}`}>
                  {model.id}{model.reasoning ? ' · 推理' : ''}
                </span>
              ))}
            </div>
            <div className="llm-provider-meta">
              <span className="llm-key-tail">
                {provider.keySet
                  ? provider.keyMode === 'literal'
                    ? `密钥已保存${provider.keyTail ? ` ····${provider.keyTail}` : ''}`
                    : `密钥：${provider.keyTail}`
                  : '未设置密钥'}
              </span>
            </div>
            <div className="llm-provider-actions">
              {isActive
                ? <button type="button" className="claude-segment-btn mini" disabled={busy} onClick={() => { void mutate('clear-default', clearDefaultPiProvider, '已取消默认供应商，右键菜单不再平铺模型'); }}>取消默认</button>
                : <button type="button" className="claude-segment-btn mini" disabled={busy} onClick={() => { void mutate('activate', () => activatePiProvider(provider.id), `「${provider.name}」已设为默认供应商`); }}>设为默认</button>}
              <button type="button" className="claude-segment-btn mini" disabled={busy} onClick={() => edit(provider)}><Pencil size={12} /> 编辑</button>
              <button type="button" className="claude-segment-btn mini danger" disabled={busy || isActive} title={isActive ? '请先取消默认后再删除' : undefined} onClick={() => setDeleteTarget(provider)}><Trash2 size={12} /> 删除</button>
            </div>
          </div>
          );
        })}
      </div>

      {state && state.externalProviderIds.length > 0 && (
        <div className="pi-import-section">
          <div className="pi-import-title">models.json 中的其他供应商（未纳入管理）</div>
          <div className="pi-import-list">
            {state.externalProviderIds.map(id => (
              <span key={id} className="pi-import-item">
                <span className="mono" title={id}>{id}</span>
                <button type="button" className="claude-segment-btn mini" disabled={busy}
                  onClick={() => setImportTarget(id)}><Download size={12} /> 导入</button>
              </span>
            ))}
          </div>
        </div>
      )}

      {editor && (
        <Dialog title={editor.id ? '编辑 Pi 供应商' : '添加 Pi 供应商'} className="pi-provider-dialog" closeDisabled={busy}
          onClose={() => { requestVersion.current += 1; setEditor(null); setModels([]); }}
          onSubmit={event => { event.preventDefault(); void save(false); }}
          footer={<>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => { requestVersion.current += 1; setEditor(null); setModels([]); }}>取消</button>
            <button type="submit" className="btn-secondary" disabled={busy}>{pending === 'save' ? '保存中…' : '保存'}</button>
            <button type="button" className="btn-primary" disabled={busy} onClick={event => { if (event.currentTarget.form?.reportValidity()) void save(true); }}>保存并设为默认</button>
          </>}>
          <fieldset className="pi-provider-fields" disabled={busy}>
            <label className="claude-form-row">名称
              <input required maxLength={80} value={editor.name} onChange={e => setEditor({ ...editor, name: e.target.value })} placeholder="如：公司中转站" />
            </label>
            <label className="claude-form-row">Pi 供应商 ID
              <input required maxLength={64} value={editor.piProviderId} onChange={e => setEditor({ ...editor, piProviderId: e.target.value })} placeholder="如：acme，只能包含字母、数字、-、_、." spellCheck={false} />
            </label>
            <label className="claude-form-row">API 地址
              <input required type="url" value={editor.baseUrl} onChange={e => { setEditor({ ...editor, baseUrl: e.target.value }); setModels([]); }} placeholder="https://api.example.com/v1" spellCheck={false} />
            </label>
            <label className="claude-form-row">API 协议
              <select value={editor.api} onChange={e => setEditor({ ...editor, api: e.target.value })}>
                {PI_API_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <label className="claude-form-row">密钥形态
              <select value={editor.keyMode} disabled={editor.keySet && !editor.apiKey}
                title={editor.keySet && !editor.apiKey ? '沿用已保存密钥时不能切换形态，填写新密钥后可切换' : undefined}
                onChange={e => setEditor({ ...editor, keyMode: e.target.value as PiKeyMode })}>
                {PI_KEY_MODE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <label className="claude-form-row">API 密钥
              <input required={!editor.keySet} type={editor.keyMode === 'literal' ? 'password' : 'text'}
                autoComplete="new-password" value={editor.apiKey}
                onChange={e => { setEditor({ ...editor, apiKey: e.target.value }); setModels([]); }}
                placeholder={editor.keySet
                  ? editor.keyMode === 'literal'
                    ? '已保存，留空沿用'
                    : `当前：${editor.keyTail || '已保存'}，留空沿用`
                  : editor.keyMode === 'literal' ? '粘贴 API 密钥'
                    : editor.keyMode === 'env' ? '$MY_API_KEY'
                      : '!cat ~/.secret'}
                spellCheck={false} />
            </label>
            <PiModelPicker models={models} selected={editor.models} defaultModel={editor.model} disabled={busy}
              refreshing={pending === 'fetch'} onRefresh={() => void fetchModels()}
              onChange={(selected, model) => setEditor({ ...editor, models: selected as PiModelConfig[], model })} />
            <details className="pi-provider-advanced">
              <summary>更多配置</summary>
              <label className="pi-provider-checkbox">
                <input type="checkbox" checked={editor.authHeader} onChange={e => setEditor({ ...editor, authHeader: e.target.checked })} />
                以 Authorization: Bearer 发送密钥（authHeader）
              </label>
              <label className="pi-provider-checkbox">
                <input type="checkbox"
                  checked={editor.compat.forceAdaptiveThinking ?? false}
                  onChange={e => setEditor({ ...editor, compat: { ...editor.compat, forceAdaptiveThinking: e.target.checked ? true : null } })} />
                强制 adaptive thinking（Anthropic 兼容端点）
              </label>
              <label className="claude-form-row">推理参数格式（thinkingFormat）
                <select value={editor.compat.thinkingFormat ?? 'auto'}
                  onChange={e => setEditor({ ...editor, compat: { ...editor.compat, thinkingFormat: e.target.value === 'auto' ? null : e.target.value } })}>
                  {PI_THINKING_FORMAT_OPTIONS.map(format => (
                    <option key={format} value={format}>{format === 'auto' ? '自动检测（auto）' : format}</option>
                  ))}
                </select>
              </label>
              <label className="claude-form-row">compat 透传（JSON 对象）
                <textarea value={editor.compatExtraText} rows={4} spellCheck={false}
                  onChange={e => setEditor({ ...editor, compatExtraText: e.target.value })}
                  placeholder='{"supportsStore": false}' />
              </label>
            </details>
          </fieldset>
        </Dialog>
      )}

      {deleteTarget && (
        <ConfirmDialog title="删除 Pi 供应商"
          message={`确定删除供应商「${deleteTarget.name}」吗？models.json 中的对应条目也会被移除。`}
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => { void mutate('delete', () => deletePiProvider(deleteTarget.id), 'Pi 供应商已删除', editor?.id === deleteTarget.id); }}
        />
      )}

      {importTarget && (
        <ConfirmDialog title="导入 Pi 供应商"
          message={`将 models.json 中的「${importTarget}」纳入管理吗？导入后可在此编辑，条目内容保持不变。仅支持有 baseUrl、api 与模型列表的完整自定义供应商。`}
          confirmText="导入"
          onClose={() => setImportTarget(null)}
          onConfirm={() => { const id = importTarget; setImportTarget(null); void mutate('import', () => importPiProvider(id), `已导入「${id}」`); }}
        />
      )}
    </div>
  );
};
