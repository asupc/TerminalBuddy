import { useEffect, useId, useRef, useState } from 'react';
import { GripVertical, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { api } from '../api';
import type { LlmModelConfig, LlmProvider, LlmProviderInput } from '../types';
import { useDragReorder } from '../hooks/useDragReorder';
import { Dialog } from './Dialog';
import { ModelCombobox } from './ModelCombobox';
import { ProviderPanel } from './ProviderPanel';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const newModel = (id: string): LlmModelConfig => ({
  id,
  enabled: true,
  contextWindow: 0,
  effortLevel: '',
  maxOutputTokens: 0,
});

export function LlmProvidersPanel({
  onClose,
  onChanged,
  active = true,
}: {
  onClose?: () => void;
  onChanged?: () => Promise<void>;
  active?: boolean;
}) {
  const [providers, setProviders] = useState<LlmProvider[]>([]);
  const [draft, setDraft] = useState<LlmProviderInput | null>(null);
  const [available, setAvailable] = useState<string[]>([]);
  const formId = useId();
  const busyRef = useRef(false);
  const modelInputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<LlmProvider | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const { containerRef: modelListRef, startDrag, dragClass } = useDragReorder((from, to) => {
    setDraft(current => {
      if (!current) return current;
      const next = [...current.enabledModels];
      const [moved] = next.splice(from, 1);
      if (!moved) return current;
      next.splice(to, 0, moved);
      return { ...current, enabledModels: next };
    });
  });
  useEffect(() => {
    if (!active || busyRef.current) return;
    let mounted = true;
    setLoading(true);
    setError('');
    api
      .getLlmProviders()
      .then((list) => {
        if (mounted) setProviders(list);
      })
      .catch((reason) => {
        if (mounted) setError(String(reason));
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [active]);
  const run = async (action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const edit = (provider?: LlmProvider) => {
    setError('');
    setAvailable([]);
    setDraft(
      provider
        ? {
            id: provider.id,
            name: provider.name,
            baseUrl: provider.baseUrl,
            authType: provider.authType,
            apiKey: '',
            isDefault: provider.isDefault,
            defaultEffortLevel: provider.defaultEffortLevel,
            modelsUrl: provider.modelsUrl,
            // 行式编辑：行存在即启用，未启用的旧条目不进入编辑视图（保存后清除）。
            enabledModels: provider.enabledModels.filter((m) => m.enabled).map((m) => ({ ...m })),
            sortIndex: provider.sortIndex,
          }
        : {
            id: '',
            name: '',
            baseUrl: '',
            authType: 'ANTHROPIC_AUTH_TOKEN',
            apiKey: '',
            isDefault: providers.length === 0,
            defaultEffortLevel: 'high',
            modelsUrl: '',
            enabledModels: [],
            sortIndex: providers.length,
          },
    );
  };
  const save = () => {
    if (!draft) return;
    const enabledModels = draft.enabledModels
      .filter((model) => model.id.trim())
      .map((model) => ({ ...model, id: model.id.trim(), enabled: true }));
    const duplicate = enabledModels.find(
      (model, index) => enabledModels.findIndex((other) => other.id === model.id) !== index,
    );
    if (duplicate) {
      // 后端也会拒绝重复模型；这里提前提示，避免请求往返后才看到错误。
      setError(`模型「${duplicate.id}」重复，请删除重复项后再保存`);
      return;
    }
    void run(async () => {
      await api.saveLlmProvider({
        ...draft,
        name: draft.name.trim(),
        baseUrl: draft.baseUrl.trim(),
        modelsUrl: draft.modelsUrl.trim(),
        apiKey: draft.apiKey?.trim() || undefined,
        enabledModels,
      });
      setProviders(await api.getLlmProviders());
      await onChanged?.();
      setDraft(null);
    });
  };
  const reorder = (index: number, delta: number) =>
    void run(async () => {
      const ids = providers.map((p) => p.id);
      [ids[index], ids[index + delta]] = [ids[index + delta], ids[index]];
      setProviders(await api.orderLlmProviders(ids));
      await onChanged?.();
    });
  const updateModel = (index: number, patch: Partial<LlmModelConfig>) => {
    setDraft((current) =>
      current
        ? {
            ...current,
            enabledModels: current.enabledModels.map((model, i) =>
              i === index ? { ...model, ...patch } : model,
            ),
          }
        : current,
    );
  };
  const addModel = () => {
    if (!draft) return;
    const nextIndex = draft.enabledModels.length;
    setDraft({ ...draft, enabledModels: [...draft.enabledModels, newModel('')] });
    // 新行追加在末尾：聚焦输入框让弹窗自动滚动到新行，避免被底边遮住。
    requestAnimationFrame(() => modelInputRefs.current[nextIndex]?.focus());
  };
  const fetchModels = () => {
    if (!draft) return;
    void run(async () => {
      const models = await api.fetchLlmModels({
        providerId: draft.id || undefined,
        baseUrl: draft.baseUrl.trim(),
        apiKey: draft.apiKey?.trim() || '',
        modelsUrl: draft.modelsUrl.trim(),
      });
      setAvailable(models.map((m) => m.id));
    });
  };

  return (
    <>
      <ProviderPanel
        title="模型供应商"
        onClose={onClose ? () => {
          if (!busy) onClose();
        } : undefined}
        footer={
          <>
            {onClose && <button className="btn" onClick={onClose} disabled={busy}>关闭</button>}
            <button className="btn" disabled={busy || loading} onClick={() => void run(async () => {
              setProviders(await api.getLlmProviders());
            })}>刷新</button>
            <button className="btn primary" disabled={busy || loading} onClick={() => edit()}>
              添加供应商
            </button>
          </>
        }
      >
        {error && !draft && (
          <div className="nav-error" role="alert">
            {error}
          </div>
        )}
        <div className="project-form">
          {loading ? (
            <p>加载中…</p>
          ) : (
            !providers.length && <p>暂无模型供应商，添加后可从长按菜单选择模型启动 Claude。</p>
          )}
          {providers.map((provider, index) => (
            <div className="provider-model-editor" key={provider.id}>
              <strong>
                {provider.name}
                {provider.isDefault && '（默认）'}
              </strong>
              <small>{provider.baseUrl}</small>
              <small>
                {provider.enabledModels.filter((m) => m.enabled).length} 个启用模型 · 密钥
                {provider.keySet ? `已设置（尾号 ${provider.keyTail}）` : '未设置'}
              </small>
              <div className="project-row-actions">
                <button className="btn small" disabled={busy} onClick={() => edit(provider)}>
                  编辑
                </button>
                {provider.isDefault ? (
                  <button
                    className="btn small"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        setProviders(await api.clearDefaultLlmProvider());
                        await onChanged?.();
                      })
                    }
                  >
                    取消默认
                  </button>
                ) : (
                  <button
                    className="btn small"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        setProviders(await api.setDefaultLlmProvider(provider.id));
                        await onChanged?.();
                      })
                    }
                  >
                    设为默认
                  </button>
                )}
                <button
                  className="btn small"
                  disabled={busy || index === 0}
                  aria-label={`上移 ${provider.name}`}
                  onClick={() => reorder(index, -1)}
                >
                  ↑
                </button>
                <button
                  className="btn small"
                  disabled={busy || index === providers.length - 1}
                  aria-label={`下移 ${provider.name}`}
                  onClick={() => reorder(index, 1)}
                >
                  ↓
                </button>
                <button
                  className="btn small danger"
                  disabled={busy}
                  onClick={() => setConfirmDelete(provider)}
                >
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      </ProviderPanel>

      {draft && (
        <Dialog
          title={draft.id ? `编辑模型供应商 · ${draft.name || '（未命名）'}` : '添加模型供应商'}
          className="llm-provider-editor-dialog"
          onClose={() => {
            if (!busy) {
              setDraft(null);
              setError('');
            }
          }}
          footer={
            <>
              <button
                className="btn"
                disabled={busy}
                onClick={() => {
                  setDraft(null);
                  setError('');
                }}
              >
                取消
              </button>
              <button
                className="btn primary"
                disabled={busy}
                type="submit"
                form={formId}
              >
                {busy ? '处理中…' : '保存'}
              </button>
            </>
          }
        >
          <form
            id={formId}
            className="project-form"
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <fieldset disabled={busy}>
              <label>
                名称 *
                <input
                  required
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </label>
              <label>
                API 地址 *
                <input
                  required
                  type="url"
                  value={draft.baseUrl}
                  onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
                  placeholder="https://api.example.com"
                />
              </label>
              <label>
                认证方式
                <select
                  value={draft.authType}
                  onChange={(e) => setDraft({ ...draft, authType: e.target.value })}
                >
                  <option value="ANTHROPIC_AUTH_TOKEN">ANTHROPIC_AUTH_TOKEN</option>
                  <option value="ANTHROPIC_API_KEY">ANTHROPIC_API_KEY</option>
                </select>
              </label>
              <label>
                API 密钥{!draft.id && ' *'}
                <input
                  type="password"
                  required={!draft.id}
                  autoComplete="new-password"
                  value={draft.apiKey || ''}
                  onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
                  placeholder={draft.id ? '留空保留已保存的密钥' : '输入 API 密钥'}
                />
              </label>
              <label>
                模型列表地址
                <input
                  type="url"
                  value={draft.modelsUrl}
                  onChange={(e) => setDraft({ ...draft, modelsUrl: e.target.value })}
                  placeholder="留空自动推导 /v1/models"
                />
              </label>
              <label>
                默认推理等级
                <select
                  value={draft.defaultEffortLevel}
                  onChange={(e) => setDraft({ ...draft, defaultEffortLevel: e.target.value })}
                >
                  {EFFORTS.map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
              <label className="project-checkbox">
                <input
                  type="checkbox"
                  checked={draft.isDefault}
                  onChange={(e) => setDraft({ ...draft, isDefault: e.target.checked })}
                />
                设为默认供应商
              </label>
              <div className="codex-model-picker-tools">
                <button className="btn" type="button" disabled={busy} onClick={fetchModels}>
                  <RefreshCw size={14} /> 从供应商拉取模型
                </button>
                <button
                  className="btn"
                  type="button"
                  disabled={busy || draft.enabledModels.length >= 200}
                  onClick={addModel}
                >
                  <Plus size={14} /> 添加模型
                </button>
              </div>
              {draft.enabledModels.length > 0 && <div className="llm-model-list" ref={modelListRef}>
                {draft.enabledModels.map((model, index) => (
                  <div className={`llm-model-row model-drag-row${dragClass(index)}`} key={index} data-drag-index={index}>
                    <span
                      className="model-drag-handle"
                      role="button"
                      tabIndex={0}
                      title="拖拽排序"
                      aria-label={`拖拽排序模型 ${index + 1}`}
                      onPointerDown={(event) => startDrag(event, index)}
                    >
                      <GripVertical size={14} aria-hidden="true" />
                    </span>
                    <ModelCombobox
                      value={model.id}
                      options={available}
                      onChange={(value) => updateModel(index, { id: value })}
                      ariaLabel={`模型 ID ${index + 1}`}
                      inputRef={(element) => { modelInputRefs.current[index] = element; }}
                    />
                    <select
                      className="codex-model-effort"
                      aria-label={`模型推理等级 ${index + 1}`}
                      title="推理等级"
                      value={model.effortLevel}
                      onChange={(e) => updateModel(index, { effortLevel: e.target.value })}
                    >
                      <option value="">跟随供应商</option>
                      {EFFORTS.map((v) => (
                        <option key={v}>{v}</option>
                      ))}
                    </select>
                    <input
                      type="number"
                      className="llm-model-number"
                      aria-label={`模型上下文 ${index + 1}`}
                      min={0}
                      step={1000}
                      value={model.contextWindow || ''}
                      placeholder="上下文"
                      title="模型真实上下文窗口（tokens），0 表示不覆盖"
                      onChange={(e) => updateModel(index, { contextWindow: Number(e.target.value) || 0 })}
                    />
                    <input
                      type="number"
                      className="llm-model-number"
                      aria-label={`模型最大输出 ${index + 1}`}
                      min={0}
                      step={1000}
                      value={model.maxOutputTokens || ''}
                      placeholder="输出上限"
                      title="最大输出 tokens，0 表示不覆盖"
                      onChange={(e) => updateModel(index, { maxOutputTokens: Number(e.target.value) || 0 })}
                    />
                    <button
                      className="btn small danger"
                      type="button"
                      aria-label={`删除模型 ${index + 1}`}
                      onClick={() =>
                        setDraft({
                          ...draft,
                          enabledModels: draft.enabledModels.filter((_, i) => i !== index),
                        })
                      }
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>}
              {!draft.enabledModels.length && (
                <p className="provider-description">点击「添加模型」新增一行，可手动输入或先「从供应商拉取模型」再从下拉中选择。</p>
              )}
            </fieldset>
            {error && (
              <div className="nav-error" role="alert">
                {error}
              </div>
            )}
          </form>
        </Dialog>
      )}

      {confirmDelete && (
        <Dialog
          title="删除模型供应商"
          onClose={() => {
            if (!busy) setConfirmDelete(null);
          }}
          footer={
            <>
              <button className="btn" disabled={busy} onClick={() => setConfirmDelete(null)}>
                取消
              </button>
              <button
                className="btn danger"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    setProviders(await api.deleteLlmProvider(confirmDelete.id));
                    await onChanged?.();
                    setConfirmDelete(null);
                  })
                }
              >
                删除
              </button>
            </>
          }
        >
          <p>确定删除“{confirmDelete.name}”？引用该供应商的启动命令需要重新选择模型。</p>
          {error && (
            <div className="nav-error" role="alert">
              {error}
            </div>
          )}
        </Dialog>
      )}
    </>
  );
}
