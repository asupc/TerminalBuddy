import { useEffect, useRef, useState } from 'react';
import { GripVertical, Plus, RefreshCw, Trash2 } from 'lucide-react';
import {
  EFFORT_LABELS,
  EFFORT_LEVELS,
  fetchLlmProviderModels,
  type EffortLevel,
  type LlmAuthType,
  type LlmModelConfig,
} from '../../../services/tauri';
import { useAppStore } from '../../../stores/appStore';
import { Dialog } from '../../shared/Dialog';
import { ModelCombobox } from '../../shared/ModelCombobox';
import { useDragReorder } from '../../shared/useDragReorder';
import './LlmProvidersSegment.css';

/** 行式模型配置：一行 = 已配置模型（存在即启用），与 Codex 模型配置交互一致。 */
export interface ModelRow extends LlmModelConfig {}

export interface LlmProviderDraft {
  providerId: string | null;
  name: string;
  baseUrl: string;
  authType: LlmAuthType;
  apiKey: string;
  keySet: boolean;
  keyTail: string;
  defaultEffortLevel: EffortLevel;
  /** 非空时保存后会把 Claude 默认配置（settings.json）改为该供应商与模型。 */
  defaultModel: string;
  modelsUrl: string;
  models: ModelRow[];
  sortIndex: number;
}

interface LlmProviderDialogProps {
  draft: LlmProviderDraft;
  onClose: () => void;
  onSave: (draft: LlmProviderDraft) => Promise<void>;
}

/** Claude 供应商编辑弹窗：基本信息 + 每行模型（可搜索下拉 + 推理等级 + 独立上下文窗口）。 */
export function LlmProviderDialog({ draft, onClose, onSave }: LlmProviderDialogProps) {
  const showToast = useAppStore(s => s.showToast);
  const [editor, setEditor] = useState<LlmProviderDraft>(draft);
  const [available, setAvailable] = useState<string[]>([]);
  const [fetching, setFetching] = useState(false);
  const [saving, setSaving] = useState(false);
  const fetchRequestId = useRef(0);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
  // 模型行用稳定的 key（而非 index）：拖拽/删除后 index 会变，React 复用错行
  // 会让下拉框内部状态（高亮项、输入草稿）串位。
  const rowKeySeed = useRef(0);
  const newRowKey = () => `model-row-${++rowKeySeed.current}`;
  const [rowKeys, setRowKeys] = useState<string[]>(() => draft.models.map(() => newRowKey()));
  const { containerRef, startDrag, dragClass } = useDragReorder((from, to) => {
    setRowKeys(keys => {
      const next = [...keys];
      const [moved] = next.splice(from, 1);
      if (!moved) return keys;
      next.splice(to, 0, moved);
      return next;
    });
    setEditor(current => {
      const next = [...current.models];
      const [moved] = next.splice(from, 1);
      if (!moved) return current;
      next.splice(to, 0, moved);
      return { ...current, models: next };
    });
  });

  useEffect(() => {
    setEditor(draft);
    setRowKeys(draft.models.map(() => newRowKey()));
  }, [draft]);

  const doFetch = async () => {
    if (fetching) return;
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
      setAvailable(fetched.map(item => item.id));
      showToast(`拉取到 ${fetched.length} 个模型，在模型行的下拉中选择`, 'success');
    } catch (error) {
      if (fetchRequestId.current === requestId) showToast(String(error), 'error');
    } finally {
      if (fetchRequestId.current === requestId) setFetching(false);
    }
  };

  const updateModel = (index: number, patch: Partial<ModelRow>) => {
    setEditor(current => {
      const model = current.models[index];
      const nextModels = current.models.map((item, i) => (i === index ? { ...item, ...patch } : item));
      // 正在编辑默认模型的 ID 时同步跟随，避免保存时默认模型与列表不一致。
      const defaultModel = patch.id !== undefined && model && current.defaultModel === model.id.trim()
        ? patch.id.trim()
        : current.defaultModel;
      return { ...current, models: nextModels, defaultModel };
    });
  };
  const removeModel = (index: number) => {
    setRowKeys(keys => keys.filter((_, i) => i !== index));
    setEditor(current => {
      const removed = current.models[index];
      const defaultModel = removed && current.defaultModel === removed.id.trim() ? '' : current.defaultModel;
      return { ...current, models: current.models.filter((_, i) => i !== index), defaultModel };
    });
  };
  const addModel = () => {
    setRowKeys(keys => [...keys, newRowKey()]);
    setEditor(current => ({
      ...current,
      models: [...current.models, { id: '', enabled: true, contextWindow: 0, effortLevel: '', maxOutputTokens: 0 }],
    }));
    // 新行追加在末尾：聚焦输入框让弹窗自动滚动到新行，避免被底边遮住。
    requestAnimationFrame(() => inputRefs.current[editor.models.length]?.focus());
  };

  const submit = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await onSave(editor);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      title={editor.providerId ? `编辑供应商 · ${editor.name || '（未命名）'}` : '新增供应商'}
      className="llm-provider-dialog"
      onClose={onClose}
      closeDisabled={saving}
      onSubmit={event => { event.preventDefault(); void submit(); }}
      footer={(
        <>
          <button type="button" className="btn-secondary" disabled={saving} onClick={onClose}>取消</button>
          <button type="submit" className="btn-primary" disabled={saving}>{saving ? '保存中…' : '保存'}</button>
        </>
      )}
    >
      <fieldset className="llm-provider-dialog-form" disabled={saving}>
        <label className="claude-form-row">名称
          <input required maxLength={80} value={editor.name} onChange={e => setEditor({ ...editor, name: e.target.value })} placeholder="如：公司中转站" autoFocus />
        </label>
        <label className="claude-form-row">API 地址
          <input required type="url" value={editor.baseUrl} onChange={e => setEditor({ ...editor, baseUrl: e.target.value })} placeholder="https://ai-proxy.company.com/v1" spellCheck={false} />
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
        <label className="claude-form-row">默认模型（写入 Claude 默认配置）
          <select value={editor.defaultModel} onChange={e => setEditor({ ...editor, defaultModel: e.target.value })}>
            <option value="">不修改 Claude 默认配置（保留当前值）</option>
            {(() => {
              const ids: string[] = [];
              for (const model of editor.models) {
                const id = model.id.trim();
                if (id && !ids.includes(id)) ids.push(id);
              }
              return ids.map(id => <option key={id} value={id}>{id}</option>);
            })()}
            {editor.defaultModel && !editor.models.some(model => model.id.trim() === editor.defaultModel) && (
              <option value={editor.defaultModel}>{editor.defaultModel}（不在模型列表中）</option>
            )}
          </select>
        </label>
        <p className="llm-provider-hint">
          选择后保存会把 Claude 默认配置（settings.json）的供应商与模型改为当前配置，普通启动与双击恢复历史会话都会使用它。
        </p>
        <label className="claude-form-row">API 密钥
          <input
            type="password"
            autoComplete="new-password"
            value={editor.apiKey}
            onChange={e => setEditor({ ...editor, apiKey: e.target.value })}
            placeholder={editor.keySet ? `已保存（····${editor.keyTail}），留空沿用，填写则覆盖` : '粘贴 API 密钥'}
            spellCheck={false}
          />
        </label>
        <label className="claude-form-row">自定义模型列表端点（可选）
          <input type="url" value={editor.modelsUrl} onChange={e => setEditor({ ...editor, modelsUrl: e.target.value })} placeholder="留空则按 {base}/v1/models 等候选自动尝试" spellCheck={false} />
        </label>

        <div className="llm-model-section">
          <div className="llm-model-dialog-heading">
            <strong>模型配置</strong>
            <div className="codex-model-picker-tools">
              <button type="button" className="claude-segment-btn" disabled={fetching} onClick={() => { void doFetch(); }}>
                <RefreshCw size={14} />{fetching ? '拉取中…' : '获取模型列表'}
              </button>
              <button type="button" className="claude-segment-btn" disabled={editor.models.length >= 200} onClick={addModel}>
                <Plus size={14} />添加模型
              </button>
            </div>
          </div>
          {editor.providerId && editor.keySet && !editor.apiKey.trim() && (
            <p className="llm-provider-hint">密钥留空时用已保存密钥拉取</p>
          )}
          {editor.models.length > 0 && <div className="llm-model-list" ref={containerRef}>
            {editor.models.map((model, index) => (
              <div className={`llm-model-entry model-drag-row${dragClass(index)}`} key={rowKeys[index] ?? index} data-drag-index={index}>
                <span className="model-drag-handle" role="button" tabIndex={0} title="拖拽排序"
                  aria-label={`拖拽排序模型 ${index + 1}`}
                  onPointerDown={event => startDrag(event, index)}>
                  <GripVertical size={14} aria-hidden="true" />
                </span>
                <ModelCombobox
                  value={model.id}
                  options={available}
                  onChange={value => updateModel(index, { id: value })}
                  ariaLabel={`模型 ID ${index + 1}`}
                  inputRef={element => { inputRefs.current[index] = element; }}
                />
                <select className="llm-model-effort-input" aria-label={`模型推理等级 ${index + 1}`} title="留空跟随供应商默认"
                  value={model.effortLevel} onChange={e => updateModel(index, { effortLevel: e.target.value })}>
                  <option value="">跟随默认</option>
                  {EFFORT_LEVELS.map(level => (
                    <option key={level} value={level}>{EFFORT_LABELS[level]}</option>
                  ))}
                </select>
                <input
                  type="number" min={0} step={1000} className="llm-model-ctx-input"
                  aria-label={`模型上下文 ${index + 1}`}
                  value={model.contextWindow || ''} placeholder="上下文"
                  title="模型真实上下文窗口（tokens），填写后按此值触发自动压缩；留空则关闭 Claude Code 对未知模型的窗口强制（按旧行为，不再告警）"
                  onChange={e => updateModel(index, { contextWindow: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
                />
                <button type="button" className="claude-segment-btn danger" disabled={saving} aria-label={`删除模型 ${index + 1}`}
                  onClick={() => removeModel(index)}><Trash2 size={14} /></button>
              </div>
            ))}
          </div>}
          {!editor.models.length && (
            <p className="codex-provider-description">点击「添加模型」新增一行，可手动输入或先「获取模型列表」再从下拉中选择。</p>
          )}
          <p className="codex-provider-description">模型列表通过每行的搜索下拉选择；同一模型只能配置一次，保存时会校验重复项。</p>
        </div>
      </fieldset>
    </Dialog>
  );
}
