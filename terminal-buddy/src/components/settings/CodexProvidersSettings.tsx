import { useCallback, useEffect, useId, useRef, useState, type FC } from 'react';
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
import { ConfirmDialog } from '../shared/Dialog';
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
    name: '', baseUrl: '', apiKey: '', model: '', reasoningEffort: 'high',
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
  const modelsId = useId();

  const load = useCallback(async () => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending('load');
    try {
      setState(await getCodexProviderState());
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

  const mutate = async (name: string, task: () => Promise<CodexProviderState>, message: string, closeEditor = false) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(name);
    try {
      const next = await task();
      setState(next);
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
    setModels([]);
    setEditor(provider ? { ...provider, apiKey: '' } : emptyEditor());
  };

  const save = async (activate: boolean) => {
    if (!editor) return;
    const input: CodexProviderInput = {
      id: editor.id,
      name: editor.name.trim(), baseUrl: editor.baseUrl.trim(),
      apiKey: editor.apiKey.trim() || undefined, model: editor.model.trim(),
      reasoningEffort: editor.reasoningEffort, contextWindow: editor.contextWindow,
      autoCompactTokenLimit: editor.autoCompactTokenLimit,
      disableResponseStorage: editor.disableResponseStorage,
    };
    if (!input.name || !input.baseUrl || !input.model || (!editor.keySet && !input.apiKey)) {
      showToast('请填写供应商名称、API 地址、密钥和模型 ID', 'error');
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
      if (version !== requestVersion.current) return;
      setModels(fetched.map(model => model.id));
      showToast(fetched.length ? `已获取 ${fetched.length} 个模型，可在模型输入框中选择` : '未获取到模型，可手动填写模型 ID', fetched.length ? 'success' : 'info');
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
          <button type="button" className="claude-segment-btn" disabled={busy || !state} onClick={() => edit()}>＋ 新增供应商</button>
          <button type="button" className="claude-segment-btn" disabled={busy || !state} onClick={() => void mutate('import', importCodexProvider, '已导入当前 Codex 配置')}>导入当前配置</button>
          <button type="button" className="claude-segment-btn" disabled={busy} aria-label="刷新 Codex 供应商" onClick={() => void load()}>↻</button>
        </span>
      </div>

      <p className="codex-provider-description">
        配置支持 Responses API 的通用供应商，启用后供新启动的 Codex 使用。首次添加会自动启用。
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
            <div key={provider.id} className={`llm-provider-card${editor?.id === provider.id ? ' editing' : ''}`}>
              <div className="llm-provider-head">
                <span className="llm-provider-name" title={provider.name}>{provider.name}</span>
                {isActive && <span className="llm-badge default">使用中</span>}
                {editor?.id === provider.id && <span className="llm-badge editing">编辑中</span>}
              </div>
              <div className="llm-provider-meta"><span title={provider.baseUrl}>{provider.baseUrl}</span></div>
              <div className="llm-provider-meta">
                <span title={provider.model}>{provider.model}</span>
                <span className="llm-badge effort">{CODEX_EFFORT_OPTIONS.find(([level]) => level === provider.reasoningEffort)?.[1] ?? provider.reasoningEffort}</span>
              </div>
              <div className="llm-provider-meta"><span className="llm-key-tail">{provider.keySet ? `密钥已保存${provider.keyTail ? ` ····${provider.keyTail}` : ''}` : '未设置密钥'}</span></div>
              <div className="llm-provider-actions">
                <button type="button" className="claude-segment-btn mini" disabled={busy || isActive} onClick={() => void mutate('activate', () => activateCodexProvider(provider.id), `已启用「${provider.name}」，重新启动 Codex 后生效`)}>{isActive ? '已启用' : '启用'}</button>
                <button type="button" className="claude-segment-btn mini" disabled={busy} onClick={() => edit(provider)}>编辑</button>
                <button type="button" className="claude-segment-btn mini danger" disabled={busy || isActive} title={isActive ? '请先启用其他供应商后删除' : undefined} onClick={() => setDeleteTarget(provider)}>删除</button>
              </div>
            </div>
          );
        })}
      </div>

      {editor && (
        <form className="llm-provider-editor" onSubmit={event => { event.preventDefault(); void save(false); }}>
          <div className="llm-provider-editor-title">{editor.id ? '编辑 Codex 供应商' : '新增 Codex 供应商'}</div>
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
            <div className="claude-form-row-inline">
              <label className="claude-form-row">模型 ID
                <input required maxLength={256} list={modelsId} value={editor.model} onChange={e => setEditor({ ...editor, model: e.target.value })} placeholder="填写或选择供应商支持的模型 ID" spellCheck={false} />
                <datalist id={modelsId}>{models.map(model => <option key={model} value={model} />)}</datalist>
              </label>
              <label className="claude-form-row">推理等级
                <select value={editor.reasoningEffort} onChange={e => setEditor({ ...editor, reasoningEffort: e.target.value })}>
                  {CODEX_EFFORT_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
            </div>
            <div className="claude-segment-toolbar">
              <button type="button" className="claude-segment-btn" onClick={() => void fetchModels()}>{pending === 'fetch' ? '获取中…' : '⟳ 获取模型列表'}</button>
              <span className="llm-provider-hint">也可手动填写；推理等级需由所选模型支持</span>
            </div>
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
          <div className="llm-provider-editor-actions">
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => { requestVersion.current += 1; setEditor(null); setModels([]); }}>取消</button>
            <button type="submit" className="btn-secondary" disabled={busy}>{pending === 'save' ? '保存中…' : '保存'}</button>
            <button type="button" className="btn-primary" disabled={busy} onClick={event => { if (event.currentTarget.form?.reportValidity()) void save(true); }}>保存并启用</button>
          </div>
        </form>
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
