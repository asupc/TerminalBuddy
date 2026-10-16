import { FC, useCallback, useEffect, useRef, useState } from 'react';
import {
  EFFORT_LABELS,
  EFFORT_LEVELS,
  deleteLlmProvider,
  fetchLlmProviderModels,
  listLlmProviders,
  saveLlmProvider,
  setDefaultLlmProvider,
  type EffortLevel,
  type LlmAuthType,
  type LlmModelConfig,
  type LlmProviderInput,
  type LlmProviderView,
} from '../../../services/tauri';
import { useAppStore } from '../../../stores/appStore';
import { ConfirmDialog } from '../../shared/Dialog';
import './shared.css';
import './LlmProvidersSegment.css';

interface ModelRow extends LlmModelConfig {
  /** 拉取列表里有、本地尚无配置 */
  isNew?: boolean;
}

interface EditorState {
  providerId: string | null;
  name: string;
  baseUrl: string;
  authType: LlmAuthType;
  apiKey: string;
  keySet: boolean;
  keyTail: string;
  defaultEffortLevel: EffortLevel;
  modelsUrl: string;
  models: ModelRow[];
  sortIndex: number;
}

function emptyEditor(sortIndex: number): EditorState {
  return {
    providerId: null,
    name: '',
    baseUrl: '',
    authType: 'ANTHROPIC_AUTH_TOKEN',
    apiKey: '',
    keySet: false,
    keyTail: '',
    defaultEffortLevel: 'high',
    modelsUrl: '',
    models: [],
    sortIndex,
  };
}

function editorFrom(view: LlmProviderView): EditorState {
  return {
    providerId: view.id,
    name: view.name,
    baseUrl: view.baseUrl,
    authType: view.authType,
    apiKey: '',
    keySet: view.keySet,
    keyTail: view.keyTail,
    defaultEffortLevel: (EFFORT_LEVELS as string[]).includes(view.defaultEffortLevel)
      ? (view.defaultEffortLevel as EffortLevel)
      : 'high',
    modelsUrl: view.modelsUrl,
    models: view.enabledModels.map(model => ({ ...model })),
    sortIndex: view.sortIndex,
  };
}

function enabledCount(view: LlmProviderView): number {
  return view.enabledModels.filter(model => model.enabled).length;
}

/** 模型供应商管理：卡片列表＋下方内联编辑面板（单开）。保存后刷新右键菜单数据源。 */
export const LlmProvidersSegment: FC = () => {
  const showToast = useAppStore(s => s.showToast);
  const refreshClaudeLaunchTargets = useAppStore(s => s.refreshClaudeLaunchTargets);
  const [providers, setProviders] = useState<LlmProviderView[]>([]);
  const [loading, setLoading] = useState(false);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [fetching, setFetching] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<LlmProviderView | null>(null);
  const fetchRequestId = useRef(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setProviders(await listLlmProviders());
    } catch (error) {
      setProviders([]);
      showToast(String(error), 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    void load();
  }, [load]);

  const afterMutation = useCallback(async (next: LlmProviderView[], message: string) => {
    setProviders(next);
    setEditor(null);
    showToast(message, 'success');
    await refreshClaudeLaunchTargets();
  }, [refreshClaudeLaunchTargets, showToast]);

  const saveEditor = async () => {
    if (!editor) return;
    if (!editor.name.trim()) {
      showToast('供应商名称不能为空', 'error');
      return;
    }
    if (!editor.baseUrl.trim()) {
      showToast('API 地址不能为空', 'error');
      return;
    }
    if (!editor.providerId && !editor.apiKey.trim()) {
      showToast('新建供应商请填写 API 密钥', 'error');
      return;
    }
    const input: LlmProviderInput = {
      name: editor.name.trim(),
      baseUrl: editor.baseUrl.trim(),
      authType: editor.authType,
      // 更新时留空表示沿用已保存密钥；绝不把掩码写回。
      apiKey: editor.apiKey.trim() ? editor.apiKey.trim() : undefined,
      isDefault: editor.providerId
        ? (providers.find(p => p.id === editor.providerId)?.isDefault ?? false)
        : providers.length === 0,
      defaultEffortLevel: editor.defaultEffortLevel,
      modelsUrl: editor.modelsUrl.trim(),
      enabledModels: editor.models.map(({ isNew: _isNew, ...model }) => ({
        ...model,
        id: model.id.trim(),
      })),
      sortIndex: editor.sortIndex,
    };
    if (editor.providerId) input.id = editor.providerId;
    try {
      const saved = await saveLlmProvider(input);
      // 后端 save 返回单条视图，重新拉全量保持排序一致。
      void saved;
      await afterMutation(await listLlmProviders(), '供应商已保存');
    } catch (error) {
      showToast(String(error), 'error');
    }
  };

  const doDelete = async (view: LlmProviderView) => {
    try {
      const next = await deleteLlmProvider(view.id);
      setProviders(next);
      if (editor?.providerId === view.id) setEditor(null);
      showToast(view.isDefault && next.length > 0 ? '已删除，默认供应商已自动接任' : '已删除', 'success');
      await refreshClaudeLaunchTargets();
    } catch (error) {
      showToast(String(error), 'error');
    }
  };

  const doSetDefault = async (view: LlmProviderView) => {
    try {
      const next = await setDefaultLlmProvider(view.id);
      setProviders(next);
      showToast(`「${view.name}」已设为默认供应商`, 'success');
      await refreshClaudeLaunchTargets();
    } catch (error) {
      showToast(String(error), 'error');
    }
  };

  const doFetch = async () => {
    if (!editor || fetching) return;
    if (!editor.baseUrl.trim()) {
      showToast('请先填写 API 地址', 'error');
      return;
    }
    const requestId = ++fetchRequestId.current;
    setFetching(true);
    try {
      const fetched = await fetchLlmProviderModels(
        editor.baseUrl.trim(),
        editor.apiKey.trim(),
        editor.modelsUrl.trim(),
        editor.providerId ?? undefined,
      );
      // 过期响应直接丢弃，不覆盖面板。
      if (fetchRequestId.current !== requestId) return;
      setEditor(current => {
        if (!current) return current;
        const existing = new Map(current.models.map(model => [model.id, model]));
        const merged: ModelRow[] = [];
        // 已配置但未返回的模型置顶保留，避免配好后被刷掉。
        for (const model of current.models) {
          if (!fetched.some(item => item.id === model.id)) merged.push({ ...model });
        }
        for (const item of fetched) {
          const prev = existing.get(item.id);
          merged.push(prev
            ? { ...prev, isNew: false }
            : { id: item.id, enabled: true, contextWindow: 0, effortLevel: '', maxOutputTokens: 0, isNew: true });
        }
        return { ...current, models: merged };
      });
      showToast(`拉取到 ${fetched.length} 个模型`, 'success');
    } catch (error) {
      if (fetchRequestId.current === requestId) showToast(String(error), 'error');
    } finally {
      if (fetchRequestId.current === requestId) setFetching(false);
    }
  };

  const updateModel = (id: string, patch: Partial<ModelRow>) => {
    setEditor(current => {
      if (!current) return current;
      return {
        ...current,
        models: current.models.map(model => (model.id === id ? { ...model, ...patch } : model)),
      };
    });
  };

  const editingId = editor?.providerId ?? null;

  return (
    <div className="claude-segment llm-providers-segment">
      <div className="claude-segment-toolbar">
        <span className="claude-segment-title">模型供应商</span>
        <span className="claude-segment-actions">
          <button
            type="button"
            className="claude-segment-btn"
            onClick={() => setEditor(emptyEditor(providers.length))}
          >
            ＋ 新增供应商
          </button>
          <button type="button" className="claude-segment-btn" disabled={loading} onClick={() => void load()}>↻</button>
        </span>
      </div>

      {providers.length === 0 && !loading && (
        <div className="claude-segment-empty">
          还没有配置模型供应商
          <small>「＋ 新增供应商」接入中转站，右键菜单即可按模型启动 Claude</small>
        </div>
      )}

      <div className="llm-provider-list">
        {providers.map(view => (
          <div key={view.id} className={`llm-provider-card${editingId === view.id ? ' editing' : ''}`}>
            <div className="llm-provider-head">
              <span className="llm-provider-name" title={view.name}>{view.name}</span>
              {view.isDefault && <span className="llm-badge default">默认</span>}
              {editingId === view.id && <span className="llm-badge editing">编辑中</span>}
            </div>
            <div className="llm-provider-meta">
              <span title={view.baseUrl}>{view.baseUrl}</span>
            </div>
            <div className="llm-provider-meta">
              <span>可用模型 {enabledCount(view)}</span>
              <span className="llm-badge effort">{EFFORT_LABELS[(view.defaultEffortLevel as EffortLevel)] ?? view.defaultEffortLevel}</span>
              {view.keySet && <span className="llm-key-tail">密钥 ····{view.keyTail}</span>}
            </div>
            <div className="llm-provider-actions">
              {!view.isDefault && (
                <button type="button" className="claude-segment-btn mini" onClick={() => void doSetDefault(view)}>设默认</button>
              )}
              <button type="button" className="claude-segment-btn mini" onClick={() => setEditor(editorFrom(view))}>编辑</button>
              <button type="button" className="claude-segment-btn mini danger" onClick={() => setDeleteTarget(view)}>删除</button>
            </div>
          </div>
        ))}
      </div>

      {editor && (
        <div className="llm-provider-editor">
          <div className="llm-provider-editor-title">
            {editor.providerId ? `编辑供应商 · ${editor.name || '（未命名）'}` : '新增供应商'}
          </div>
          <label className="claude-form-row">名称
            <input value={editor.name} onChange={e => setEditor({ ...editor, name: e.target.value })} placeholder="如：公司中转站" />
          </label>
          <label className="claude-form-row">API 地址
            <input value={editor.baseUrl} onChange={e => setEditor({ ...editor, baseUrl: e.target.value })} placeholder="https://ai-proxy.company.com/v1" spellCheck={false} />
          </label>
          <div className="claude-form-row-inline">
            <label className="claude-form-row">认证方式
              <select value={editor.authType} onChange={e => setEditor({ ...editor, authType: e.target.value as LlmAuthType })}>
                <option value="ANTHROPIC_AUTH_TOKEN">ANTHROPIC_AUTH_TOKEN（Bearer）</option>
                <option value="ANTHROPIC_API_KEY">ANTHROPIC_API_KEY（x-api-key）</option>
              </select>
            </label>
            <label className="claude-form-row">默认推理等级
              <select value={editor.defaultEffortLevel} onChange={e => setEditor({ ...editor, defaultEffortLevel: e.target.value as EffortLevel })}>
                {EFFORT_LEVELS.map(level => (
                  <option key={level} value={level}>{EFFORT_LABELS[level]}</option>
                ))}
              </select>
            </label>
          </div>
          <label className="claude-form-row">API 密钥
            <input
              type="password"
              value={editor.apiKey}
              onChange={e => setEditor({ ...editor, apiKey: e.target.value })}
              placeholder={editor.keySet ? `已保存（····${editor.keyTail}），留空沿用，填写则覆盖` : '粘贴 API 密钥'}
              spellCheck={false}
            />
          </label>
          <label className="claude-form-row">自定义模型列表端点（可选）
            <input value={editor.modelsUrl} onChange={e => setEditor({ ...editor, modelsUrl: e.target.value })} placeholder="留空则按 {base}/v1/models 等候选自动尝试" spellCheck={false} />
          </label>
          <div className="claude-segment-toolbar">
            <button type="button" className="claude-segment-btn" disabled={fetching} onClick={() => void doFetch()}>
              {fetching ? '拉取中…' : '⟳ 获取模型列表'}
            </button>
            {editor.providerId && editor.keySet && !editor.apiKey.trim() && (
              <span className="llm-provider-hint">密钥留空时用已保存密钥拉取</span>
            )}
          </div>
          {editor.models.length > 0 && (
            <div className="llm-model-table">
              <div className="llm-model-row head">
                <span className="llm-model-check">启用</span>
                <span className="llm-model-id">模型 ID</span>
                <span className="llm-model-ctx">上下文</span>
                <span className="llm-model-effort">推理等级</span>
              </div>
              {editor.models.map(model => (
                <div key={model.id} className="llm-model-row">
                  <span className="llm-model-check">
                    <input
                      type="checkbox"
                      checked={model.enabled}
                      onChange={e => updateModel(model.id, { enabled: e.target.checked })}
                    />
                  </span>
                  <span className="llm-model-id" title={model.id}>
                    {model.id}
                    {model.isNew && <span className="llm-badge new">新</span>}
                  </span>
                  <span className="llm-model-ctx">
                    <input
                      type="number"
                      min={0}
                      step={1000}
                      value={model.contextWindow || ''}
                      placeholder="继承"
                      title="0 表示不覆盖，继承环境"
                      onChange={e => updateModel(model.id, { contextWindow: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
                    />
                  </span>
                  <span className="llm-model-effort">
                    <select
                      value={model.effortLevel}
                      onChange={e => updateModel(model.id, { effortLevel: e.target.value })}
                      title="留空跟随供应商默认"
                    >
                      <option value="">跟随默认</option>
                      {EFFORT_LEVELS.map(level => (
                        <option key={level} value={level}>{EFFORT_LABELS[level]}</option>
                      ))}
                    </select>
                  </span>
                </div>
              ))}
            </div>
          )}
          <div className="llm-provider-editor-actions">
            <button type="button" className="btn-secondary" onClick={() => setEditor(null)}>取消</button>
            <button type="button" className="btn-primary" onClick={() => void saveEditor()}>保存</button>
          </div>
        </div>
      )}

      {deleteTarget && (
        <ConfirmDialog
          title="删除供应商"
          message={`确定删除供应商「${deleteTarget.name}」吗？引用它的页签快照将在下次启动/恢复时提示重新选择模型。`}
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => { void doDelete(deleteTarget); }}
        />
      )}
    </div>
  );
};
