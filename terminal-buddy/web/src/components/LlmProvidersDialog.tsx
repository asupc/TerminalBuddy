import { useEffect, useState } from 'react';
import { api } from '../api';
import type { LlmProvider, LlmProviderInput } from '../types';
import { Dialog } from './Dialog';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const newModel = (id: string) => ({
  id,
  enabled: true,
  contextWindow: 0,
  effortLevel: '',
  maxOutputTokens: 0,
});

export function LlmProvidersDialog({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [providers, setProviders] = useState<LlmProvider[]>([]);
  const [draft, setDraft] = useState<LlmProviderInput | null>(null);
  const [modelId, setModelId] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<LlmProvider | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    api
      .getLlmProviders()
      .then((list) => {
        if (active) setProviders(list);
      })
      .catch((reason) => {
        if (active) setError(String(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const edit = (provider?: LlmProvider) => {
    setError('');
    setModelId('');
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
            enabledModels: provider.enabledModels.map((m) => ({ ...m })),
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
    if (modelId.trim()) {
      setError('请先添加模型，或清空未添加的模型 ID');
      return;
    }
    void run(async () => {
      await api.saveLlmProvider({
        ...draft,
        name: draft.name.trim(),
        apiKey: draft.apiKey?.trim() || undefined,
      });
      setProviders(await api.getLlmProviders());
      await onChanged();
      setDraft(null);
    });
  };
  const reorder = (index: number, delta: number) =>
    void run(async () => {
      const ids = providers.map((p) => p.id);
      [ids[index], ids[index + delta]] = [ids[index + delta], ids[index]];
      setProviders(await api.orderLlmProviders(ids));
      await onChanged();
    });
  return (
    <>
      <Dialog
        title={draft ? (draft.id ? '编辑模型供应商' : '添加模型供应商') : '模型供应商'}
        className="project-editor-dialog"
        onClose={() => {
          if (!busy) onClose();
        }}
        footer={
          draft ? (
            <>
              <button
                className="btn"
                disabled={busy}
                onClick={() => {
                  setDraft(null);
                  setError('');
                }}
              >
                返回
              </button>
              <button
                className="btn primary"
                disabled={busy}
                type="submit"
                form="mobile-provider-form"
              >
                {busy ? '处理中…' : '保存'}
              </button>
            </>
          ) : (
            <>
              <button className="btn" onClick={onClose} disabled={busy}>
                关闭
              </button>
              <button className="btn primary" disabled={busy || loading} onClick={() => edit()}>
                添加供应商
              </button>
            </>
          )
        }
      >
        {error && (
          <div className="nav-error" role="alert">
            {error}
          </div>
        )}
        {draft ? (
          <form
            id="mobile-provider-form"
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
              <button
                className="btn"
                type="button"
                onClick={() =>
                  void run(async () => {
                    const models = await api.fetchLlmModels({
                      providerId: draft.id || undefined,
                      baseUrl: draft.baseUrl,
                      apiKey: draft.apiKey || '',
                      modelsUrl: draft.modelsUrl,
                    });
                    const known = new Set(draft.enabledModels.map((m) => m.id));
                    setDraft({
                      ...draft,
                      enabledModels: [
                        ...draft.enabledModels,
                        ...models.filter((m) => !known.has(m.id)).map((m) => newModel(m.id)),
                      ],
                    });
                  })
                }
              >
                从供应商拉取模型
              </button>
              <div className="project-input-action">
                <input
                  aria-label="新模型 ID"
                  placeholder="手动输入模型 ID"
                  value={modelId}
                  onChange={(e) => setModelId(e.target.value)}
                />
                <button
                  className="btn"
                  type="button"
                  disabled={!modelId.trim()}
                  onClick={() => {
                    if (draft.enabledModels.some((m) => m.id === modelId.trim())) {
                      setError('模型 ID 已存在');
                      return;
                    }
                    setDraft({
                      ...draft,
                      enabledModels: [...draft.enabledModels, newModel(modelId.trim())],
                    });
                    setModelId('');
                    setError('');
                  }}
                >
                  添加模型
                </button>
              </div>
              {draft.enabledModels.map((model, index) => (
                <div className="provider-model-editor" key={index}>
                  <label className="project-checkbox">
                    <input
                      type="checkbox"
                      checked={model.enabled}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          enabledModels: draft.enabledModels.map((m, i) =>
                            i === index ? { ...m, enabled: e.target.checked } : m,
                          ),
                        })
                      }
                    />
                    <span>{model.id}</span>
                  </label>
                  <label>
                    推理等级
                    <select
                      value={model.effortLevel}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          enabledModels: draft.enabledModels.map((m, i) =>
                            i === index ? { ...m, effortLevel: e.target.value } : m,
                          ),
                        })
                      }
                    >
                      <option value="">跟随供应商</option>
                      {EFFORTS.map((v) => (
                        <option key={v}>{v}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    上下文窗口（0 表示不覆盖）
                    <input
                      type="number"
                      min={0}
                      value={model.contextWindow}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          enabledModels: draft.enabledModels.map((m, i) =>
                            i === index ? { ...m, contextWindow: Number(e.target.value) } : m,
                          ),
                        })
                      }
                    />
                  </label>
                  <button
                    className="btn small danger"
                    type="button"
                    onClick={() =>
                      setDraft({
                        ...draft,
                        enabledModels: draft.enabledModels.filter((_, i) => i !== index),
                      })
                    }
                  >
                    移除模型
                  </button>
                </div>
              ))}
            </fieldset>
          </form>
        ) : (
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
                  {!provider.isDefault && (
                    <button
                      className="btn small"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          setProviders(await api.setDefaultLlmProvider(provider.id));
                          await onChanged();
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
        )}
      </Dialog>
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
                    await onChanged();
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
