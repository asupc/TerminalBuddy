import { useCallback, useEffect, useRef, useState, type FC } from 'react';
import {
  CODEX_EFFORT_OPTIONS,
  activateCodexProvider,
  deleteCodexProvider,
  fetchCodexProviderModels,
  getCodexProviderState,
  importCodexProvider,
  saveCodexProvider,
  type CodexProviderInput,
  type CodexProviderState,
  type CodexProviderView,
} from '../../services/tauri';
import { useAppStore } from '../../stores/appStore';
import { Plus, RefreshCw, Download, Pencil, Trash2, Server, Check } from 'lucide-react';
import { CodexModelPicker } from './CodexModelPicker';
import { ConfirmDialog, Dialog } from '../shared/Dialog';
import '../claude-panel/segments/shared.css';
import '../claude-panel/segments/LlmProvidersSegment.css';
import './CodexProvidersSettings.css';

interface Editor extends CodexProviderInput {
  apiKey: string;
  keySet: boolean;
  keyTail: string;
}

function emptyEditor(): Editor {
  return {
    name: '', baseUrl: '', apiKey: '', model: '', models: [], availableModels: [], reasoningEffort: 'high',
    contextWindow: 0, autoCompactTokenLimit: 0, disableResponseStorage: true,
    keySet: false, keyTail: '',
  };
}

const tokenCount = (value: string) => Math.min(4294967295, Math.max(0, Math.floor(Number(value) || 0)));

export const CodexProvidersSettings: FC<{ active: boolean }> = ({ active }) => {
  const showToast = useAppStore(s => s.showToast);
  const [state, setState] = useState<CodexProviderState | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [loadError, setLoadError] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<CodexProviderView | null>(null);
  const pendingRef = useRef(false);
  const requestVersion = useRef(0);
  const setCodexProviderState = useAppStore(s => s.setCodexProviderState);
  const [preset, setPreset] = useState('custom');

  const load = useCallback(async () => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending('load');
    try {
      const next = await getCodexProviderState();
      setState(next);
      setCodexProviderState(next);
      setLoadError('');
    } catch (error) {
      setLoadError(String(error));
    } finally {
      pendingRef.current = false;
      setPending(null);
    }
  }, [setCodexProviderState]);

  useEffect(() => {
    if (active) void load();
  }, [active, load]);

  useEffect(() => () => { requestVersion.current += 1; }, []);

  const mutate = async (name: string, task: () => Promise<CodexProviderState>, message: string, closeEditor = false) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(name);
    try {
      const next = await task();
      setState(next);
      setCodexProviderState(next);
      setLoadError('');
      if (closeEditor) { setEditor(null); setModels([]); }
      showToast(message, 'success');
    } catch (error) {
      showToast(String(error), 'error');
    } finally {
      pendingRef.current = false;
      setPending(null);
    }
  };

  const edit = (provider?: CodexProviderView) => {
    requestVersion.current += 1;
    setModels(provider?.availableModels ?? []);
    setPreset(provider?.baseUrl === 'https://api.openai.com/v1' ? 'openai' : 'custom');
    setEditor(provider ? { ...provider, models: provider.models ?? [provider.model], availableModels: provider.availableModels ?? [], apiKey: '' } : emptyEditor());
  };

  const save = async (activate: boolean) => {
    if (!editor) return;
    const input: CodexProviderInput = {
      id: editor.id,
      name: editor.name.trim(), baseUrl: editor.baseUrl.trim(),
      apiKey: editor.apiKey.trim() || undefined, model: editor.model.trim(), models: [...new Set(editor.models.map(id => id.trim()).filter(Boolean))],
      availableModels: models,
      reasoningEffort: editor.reasoningEffort, contextWindow: editor.contextWindow,
      autoCompactTokenLimit: editor.autoCompactTokenLimit,
      disableResponseStorage: editor.disableResponseStorage,
    };
    if (!input.name || !input.baseUrl || !input.model || (!editor.keySet && !input.apiKey)) {
      showToast('请填写供应商名称、API 地址和密钥，并至少选择一个模型', 'error');
      return;
    }
    const willActivate = activate || state?.providers.length === 0 || (!!editor.id && state?.activeProviderId === editor.id);
    await mutate('save', () => saveCodexProvider(input, activate), willActivate ? '供应商已保存并启用，重新启动 Codex 后生效' : '供应商已保存', true);
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
      const fetched = await fetchCodexProviderModels(editor.baseUrl.trim(), editor.apiKey.trim(), editor.id);
      const next = editor.id ? await getCodexProviderState() : null;
      if (version !== requestVersion.current) return;
      const ids = [...new Set(fetched.map(model => model.id))];
      setModels(ids);
      if (next) { setState(next); setCodexProviderState(next); }
      showToast(fetched.length ? `已更新 ${fetched.length} 个模型，可在每行的模型列表中选择` : '未获取到模型，可手动填写模型 ID', fetched.length ? 'success' : 'info');
    } catch (error) {
      if (version === requestVersion.current) showToast(`${String(error)}；也可手动填写模型 ID`, 'error');
    } finally {
      pendingRef.current = false;
      setPending(null);
    }
  };

  const busy = pending !== null;

  return (
    <div className="claude-segment llm-providers-segment codex-providers-settings" aria-busy={busy}>
      <div className="claude-segment-toolbar">
        <span className="claude-segment-title">Codex 供应商</span>
        <span className="claude-segment-actions">
          <button type="button" className="claude-segment-btn" disabled={busy || !state} onClick={() => edit()}><Plus size={14} /> 添加供应商</button>
          <button type="button" className="claude-segment-btn" disabled={busy || !state} onClick={() => void mutate('import', importCodexProvider, '已导入当前 Codex 配置')}><Download size={14} /> 导入当前配置</button>
          <button type="button" className="claude-segment-btn" disabled={busy} aria-label="刷新 Codex 供应商" onClick={() => void load()}><RefreshCw size={14} /></button>
        </span>
      </div>

      <p className="codex-provider-description">
        管理多个 Codex 供应商，为每个供应商选择可用模型。右键项目或 Codex 启动配置，即可按模型快速启动。
      </p>
      {state && <p className="codex-provider-path" title={state.configDir}>配置目录：{state.configDir}</p>}
      {(loadError || state?.configError) && <div className="codex-provider-error" role="alert">{loadError || state?.configError}</div>}
      {pending === 'load' && !state && <div className="claude-segment-empty">正在读取 Codex 配置…</div>}
      {state?.providers.length === 0 && !editor && (
        <div className="claude-segment-empty">
          还没有配置 Codex 供应商
          <small>新增 API 地址、密钥与模型，或导入已有的 API 配置</small>
        </div>
      )}
      {state && state.providers.length > 0 && !state.activeProviderId && !state.configError && (
        <p className="codex-provider-description">当前 Codex 配置与列表中的供应商不一致，可选择一项启用。</p>
      )}

      <div className="llm-provider-list">
        {state?.providers.map(provider => {
          const isActive = state.activeProviderId === provider.id;
          return (
            <div key={provider.id} className={`llm-provider-card codex-provider-card${isActive ? ' is-active' : ''}`}>
              <div className="llm-provider-head">
                <span className="codex-provider-avatar"><Server size={18} /></span>
                <span className="llm-provider-name" title={provider.name}>{provider.name}</span>
                {isActive && <span className="llm-badge default">使用中</span>}
                {editor?.id === provider.id && <span className="llm-badge editing">编辑中</span>}
              </div>
              <div className="llm-provider-meta"><span title={provider.baseUrl}>{provider.baseUrl}</span></div>
              <div className="llm-provider-meta">
                <span title={provider.model}>默认：{provider.model}</span>
                <span className="llm-badge effort">{CODEX_EFFORT_OPTIONS.find(([level]) => level === provider.reasoningEffort)?.[1] ?? provider.reasoningEffort}</span>
              </div>
              <div className="codex-provider-model-tags">{(provider.models ?? [provider.model]).map(id => <span key={id} className="llm-badge" title={id}>{id}</span>)}</div>
              <div className="llm-provider-meta"><span className="llm-key-tail">{provider.keySet ? `密钥已保存${provider.keyTail ? ` ····${provider.keyTail}` : ''}` : '未设置密钥'}</span></div>
              <div className="llm-provider-actions">
                <button type="button" className="claude-segment-btn mini" disabled={busy || isActive} onClick={() => void mutate('activate', () => activateCodexProvider(provider.id), `已启用「${provider.name}」，重新启动 Codex 后生效`)}>{isActive && <Check size={12} />}{isActive ? '已启用' : '启用'}</button>
                <button type="button" className="claude-segment-btn mini" disabled={busy} onClick={() => edit(provider)}><Pencil size={12} /> 编辑</button>
                <button type="button" className="claude-segment-btn mini danger" disabled={busy || isActive} title={isActive ? '请先启用其他供应商后删除' : undefined} onClick={() => setDeleteTarget(provider)}><Trash2 size={12} /> 删除</button>
              </div>
            </div>
          );
        })}
      </div>

      {editor && (
        <Dialog title={editor.id ? '编辑 Codex 供应商' : '添加 Codex 供应商'} className="codex-provider-dialog" closeDisabled={busy}
          onClose={() => { requestVersion.current += 1; setEditor(null); setModels([]); }}
          onSubmit={event => { event.preventDefault(); void save(false); }}
          footer={<>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => { requestVersion.current += 1; setEditor(null); setModels([]); }}>取消</button>
            <button type="submit" className="btn-secondary" disabled={busy}>{pending === 'save' ? '保存中…' : '保存'}</button>
            <button type="button" className="btn-primary" disabled={busy} onClick={event => { if (event.currentTarget.form?.reportValidity()) void save(true); }}>保存并启用</button>
          </>}>
          {!editor.id && <div className="codex-provider-presets" role="group" aria-label="供应商预设">
            {[['custom', '自定义供应商', '兼容 Responses API 的中转站或私有服务'], ['openai', 'OpenAI 官方 API', '使用 OpenAI API 密钥连接']].map(([id, name, hint]) => <button key={id} type="button" disabled={busy}
              className={preset === id ? 'selected' : ''} onClick={() => { setPreset(id); setModels([]); setEditor({ ...editor, name: id === 'openai' ? 'OpenAI' : '', baseUrl: id === 'openai' ? 'https://api.openai.com/v1' : '' }); }}>
              <strong>{name}</strong><small>{hint}</small>
            </button>)}
          </div>}
          <fieldset className="codex-provider-fields" disabled={busy}>
            <label className="claude-form-row">名称
              <input required maxLength={80} value={editor.name} onChange={e => setEditor({ ...editor, name: e.target.value })} placeholder="如：公司中转站" />
            </label>
            <label className="claude-form-row">API 地址
              <input required type="url" value={editor.baseUrl} onChange={e => { setEditor({ ...editor, baseUrl: e.target.value }); setModels([]); }} placeholder="https://api.example.com/v1" spellCheck={false} />
            </label>
            <label className="claude-form-row">API 密钥
              <input required={!editor.keySet} type="password" autoComplete="new-password" value={editor.apiKey} onChange={e => { setEditor({ ...editor, apiKey: e.target.value }); setModels([]); }} placeholder={editor.keySet ? `已保存${editor.keyTail ? `（····${editor.keyTail}）` : ''}，留空沿用` : '粘贴 API 密钥'} spellCheck={false} />
            </label>
            <CodexModelPicker models={models} selected={editor.models} defaultModel={editor.model} disabled={busy}
              refreshing={pending === 'fetch'} onRefresh={() => void fetchModels()}
              onChange={(selected, model) => setEditor({ ...editor, models: selected, model })} />
            <label className="claude-form-row">推理等级
              <select value={editor.reasoningEffort} onChange={e => setEditor({ ...editor, reasoningEffort: e.target.value })}>
                {CODEX_EFFORT_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <details className="codex-provider-advanced">
              <summary>更多配置</summary>
              <div className="claude-form-row-inline">
                <label className="claude-form-row">上下文窗口（tokens）
                  <input type="number" min={0} max={4294967295} step={1} value={editor.contextWindow || ''} onChange={e => setEditor({ ...editor, contextWindow: tokenCount(e.target.value) })} placeholder="留空使用模型默认值" />
                </label>
                <label className="claude-form-row">自动压缩阈值（tokens）
                  <input type="number" min={0} max={editor.contextWindow || 4294967295} step={1} value={editor.autoCompactTokenLimit || ''} onChange={e => setEditor({ ...editor, autoCompactTokenLimit: tokenCount(e.target.value) })} placeholder="留空使用模型默认值" />
                </label>
              </div>
              <label className="codex-provider-checkbox"><input type="checkbox" checked={editor.disableResponseStorage} onChange={e => setEditor({ ...editor, disableResponseStorage: e.target.checked })} />禁用响应存储</label>
            </details>
          </fieldset>
          <p className="codex-provider-description">{editor.id && state?.activeProviderId === editor.id ? '修改当前供应商并保存后，会同步更新 Codex 配置。' : '启用时自动备份原配置，并保留 MCP 等其他设置。'}</p>
          <details className="codex-provider-advanced codex-config-preview">
            <summary>配置预览</summary>
            <strong>auth.json</strong>
            <pre>{JSON.stringify({ OPENAI_API_KEY: editor.keySet ? '（沿用已保存密钥）' : '（使用上方 API 密钥）' }, null, 2)}</pre>
            <strong>config.toml</strong>
            <pre>{[
              'model_provider = "custom"',
              'model = ' + JSON.stringify(editor.model),
              ...(editor.reasoningEffort ? ['model_reasoning_effort = ' + JSON.stringify(editor.reasoningEffort)] : []),
              ...(editor.contextWindow ? ['model_context_window = ' + editor.contextWindow] : []),
              ...(editor.autoCompactTokenLimit ? ['model_auto_compact_token_limit = ' + editor.autoCompactTokenLimit] : []),
              'disable_response_storage = ' + editor.disableResponseStorage,
              '', '[model_providers.custom]',
              'name = ' + JSON.stringify(editor.name),
              'base_url = ' + JSON.stringify(editor.baseUrl),
              'wire_api = "responses"',
              'experimental_bearer_token = "（使用已保存密钥）"',
              'requires_openai_auth = false',
            ].join('\n')}</pre>
          </details>
        </Dialog>
      )}

      {deleteTarget && (
        <ConfirmDialog title="删除 Codex 供应商" message={`确定删除供应商「${deleteTarget.name}」吗？`}
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => { void mutate('delete', () => deleteCodexProvider(deleteTarget.id), 'Codex 供应商已删除', editor?.id === deleteTarget.id); }}
        />
      )}
    </div>
  );
};
