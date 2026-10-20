import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { api } from '../api';
import type { CodexProvider, CodexProviderInput, CodexProviderState } from '../types';
import { Dialog } from './Dialog';
import { ProviderPanel } from './ProviderPanel';
import { CodexModelPicker } from './CodexModelPicker';
import { CODEX_EFFORT_OPTIONS } from '../utils/codexLaunch';

interface Draft extends CodexProviderInput {
  apiKey: string;
  keySet: boolean;
  modelEfforts: string[];
}
const newDraft = (): Draft => ({
  name: '', baseUrl: '', apiKey: '', model: '', models: [], availableModels: [], modelReasoningEfforts: {}, modelEfforts: [],
  contextWindow: 0, autoCompactTokenLimit: 0, disableResponseStorage: true, keySet: false,
});

export function CodexProvidersPanel({ active, onClose }: { active: boolean; onClose?: () => void }) {
  const [state, setState] = useState<CodexProviderState | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<CodexProvider | null>(null);
  const busyRef = useRef(false);
  const mountedRef = useRef(false);
  const formId = useId();
  const [preset, setPreset] = useState('custom');
  const busy = pending !== null;

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const run = useCallback(async (name: string, action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setPending(name);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (reason) {
      if (mountedRef.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setPending(null);
    }
  }, []);

  const load = useCallback(() => run('load', async () => {
    const next = await api.getCodexProviderState();
    if (mountedRef.current) setState(next);
  }), [run]);

  useEffect(() => {
    if (active) void load();
  }, [active, load]);

  const edit = (provider?: CodexProvider) => {
    setError('');
    setNotice('');
    setModels(provider?.availableModels ?? []);
    setPreset(provider?.baseUrl === 'https://api.openai.com/v1' ? 'openai' : 'custom');
    setDraft(provider ? { ...provider, models: provider.models ?? [provider.model], availableModels: provider.availableModels ?? [], modelEfforts: (provider.models ?? [provider.model]).map(id => provider.modelReasoningEfforts[id] ?? 'max'), apiKey: '' } : newDraft());
  };

  const save = (activate: boolean) => {
    if (!draft) return;
    const input: CodexProviderInput = {
      id: draft.id,
      name: draft.name.trim(),
      baseUrl: draft.baseUrl.trim(),
      apiKey: draft.apiKey.trim() || undefined,
      model: draft.model.trim(),
      models: [...new Set(draft.models.map(id => id.trim()).filter(Boolean))],
      availableModels: models,
      modelReasoningEfforts: Object.fromEntries(draft.models.map((id, index) => [id.trim(), draft.modelEfforts[index] ?? 'max']).filter(([id]) => id)),
      contextWindow: draft.contextWindow,
      autoCompactTokenLimit: draft.autoCompactTokenLimit,
      disableResponseStorage: draft.disableResponseStorage,
    };
    if (!input.name || !input.baseUrl || !input.model || (!draft.keySet && !input.apiKey)) {
      setError('请填写供应商名称、API 地址和密钥，并至少选择一个模型');
      return;
    }
    const willActivate = activate || state?.providers.length === 0 || (!!draft.id && state?.activeProviderId === draft.id);
    void run('save', async () => {
      const next = await api.saveCodexProvider(input, activate);
      setState(next);
      setDraft(null);
      setModels([]);
      setNotice(willActivate ? '供应商已保存并设为默认，重新启动 Codex 后生效' : '供应商已保存');
    });
  };

  const fetchModels = () => {
    if (!draft) return;
    if (!draft.baseUrl.trim() || (!draft.apiKey.trim() && !draft.keySet)) {
      setError('请先填写 API 地址和密钥');
      return;
    }
    void run('fetch', async () => {
      const fetched = await api.fetchCodexModels(draft.baseUrl.trim(), draft.apiKey.trim(), draft.id);
      const next = draft.id ? await api.getCodexProviderState() : null;
      if (!mountedRef.current) return;
      setModels([...new Set(fetched.map(model => model.id))]);
      if (next) setState(next);
      setNotice(fetched.length ? `已更新 ${fetched.length} 个模型，可在每行的模型列表中选择` : '未获取到模型，可手动填写模型 ID');
    });
  };

  return (
    <ProviderPanel
      onClose={onClose}
      title={draft ? (draft.id ? '编辑 Codex 供应商' : '添加 Codex 供应商') : 'Codex 供应商'}
      footer={draft ? <>
        <button className="btn" disabled={busy} onClick={() => { setDraft(null); setModels([]); setError(''); setNotice(''); }}>返回</button>
        <button className="btn" disabled={busy} type="submit" form={formId}>{pending === 'save' ? '保存中…' : '保存'}</button>
        <button className="btn primary" disabled={busy} onClick={() => {
          const form = document.getElementById(formId) as HTMLFormElement | null;
          if (form?.reportValidity()) save(true);
        }}>保存并设为默认</button>
      </> : <>
        <button className="btn" disabled={busy} onClick={() => void load()}>刷新</button>
        <button className="btn" disabled={busy || !state} onClick={() => void run('import', async () => {
          setState(await api.importCodexProvider());
          setNotice('已导入当前 Codex 配置');
        })}>导入当前配置</button>
        <button className="btn primary" disabled={busy || !state} onClick={() => edit()}>添加供应商</button>
      </>}
    >
      <p className="provider-description">管理多个 Codex 供应商，为每个供应商选择可用模型。右键或长按项目、Codex 启动配置，即可按模型快速启动。保存或设为默认时会自动生成模型目录（model_catalog_json），为所有模型声明全部推理等级。</p>
      {error && <div className="nav-error" role="alert">{error}</div>}
      {state?.configError && <div className="nav-error" role="alert">{state.configError}</div>}
      {notice && <div className="provider-notice" role="status">{notice}</div>}
      {draft ? (
        <form id={formId} className="project-form" onSubmit={(event) => { event.preventDefault(); save(false); }}>
          <fieldset disabled={busy}>
            {!draft.id && <div className="codex-provider-presets" role="group" aria-label="供应商预设">
              {[['custom', '自定义供应商'], ['openai', 'OpenAI 官方 API']].map(([id, name]) => <button type="button" key={id} className={preset === id ? 'selected' : ''} onClick={() => { setPreset(id); setModels([]); setDraft({ ...draft, name: id === 'openai' ? 'OpenAI' : '', baseUrl: id === 'openai' ? 'https://api.openai.com/v1' : '' }); }}>{name}</button>)}
            </div>}
            <label>名称 *
              <input required maxLength={80} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </label>
            <label>API 地址 *
              <input required type="url" value={draft.baseUrl} spellCheck={false} autoCapitalize="none" placeholder="https://api.example.com/v1"
                onChange={(e) => { setDraft({ ...draft, baseUrl: e.target.value }); setModels([]); }} />
            </label>
            <label>API 密钥{!draft.keySet && ' *'}
              <input required={!draft.keySet} type="password" autoComplete="new-password" spellCheck={false} value={draft.apiKey}
                placeholder={draft.keySet ? '留空保留已保存的密钥' : '输入 API 密钥'}
                onChange={(e) => { setDraft({ ...draft, apiKey: e.target.value }); setModels([]); }} />
            </label>
            <CodexModelPicker models={models} selected={draft.models} reasoningEfforts={draft.modelEfforts} defaultModel={draft.model} disabled={busy}
              refreshing={pending === 'fetch'} onRefresh={fetchModels}
              onChange={(selected, model, modelEfforts) => setDraft({ ...draft, models: selected, model, modelEfforts })} />
            <details className="project-env">
              <summary>更多配置</summary>
              <div className="project-form">
                <label>上下文窗口（0 表示使用模型默认值）
                  <input type="number" min={0} max={4294967295} step={1} value={draft.contextWindow}
                    onChange={(e) => setDraft({ ...draft, contextWindow: Number(e.target.value) })} />
                </label>
                <label>自动压缩阈值（0 表示使用模型默认值）
                  <input type="number" min={0} max={draft.contextWindow || 4294967295} step={1} value={draft.autoCompactTokenLimit}
                    onChange={(e) => setDraft({ ...draft, autoCompactTokenLimit: Number(e.target.value) })} />
                </label>
                <label className="project-checkbox"><input type="checkbox" checked={draft.disableResponseStorage}
                  onChange={(e) => setDraft({ ...draft, disableResponseStorage: e.target.checked })} />禁用响应存储</label>
              </div>
            </details>
          </fieldset>
          <p className="provider-description">设为默认时自动备份原配置，并保留 MCP 等其他设置。修改当前默认供应商并保存后，会同步更新 Codex 配置。保存或设为默认时自动生成模型目录，所有模型声明全部推理等级。</p>
        </form>
      ) : (
        <div className="project-form" aria-busy={busy}>
          {!state && pending === 'load' && <p className="provider-description">正在读取 Codex 配置…</p>}
          {state?.providers.length === 0 && <p className="provider-description">暂无 Codex 供应商，可添加供应商或导入已有配置。</p>}
          {state && state.providers.length > 0 && !state.activeProviderId && !state.configError && <p className="provider-description">当前未设置默认供应商，可选择一项设为默认；长按菜单仍可按模型快速启动。</p>}
          {state?.providers.map((provider) => {
            const isActive = state.activeProviderId === provider.id;
            return (
              <div className="provider-model-editor" key={provider.id}>
                <strong>{provider.name}{isActive && '（默认）'}</strong>
                <small>{provider.baseUrl}</small>
                <small>默认：{provider.model}</small>
                <div className="codex-provider-model-tags">{(provider.models ?? [provider.model]).map(id => <span key={id} title={id}>{id} · {CODEX_EFFORT_OPTIONS.find(([value]) => value === (provider.modelReasoningEfforts[id] ?? 'max'))?.[1]}</span>)}</div>
                <small>密钥{provider.keySet ? `已设置（尾号 ${provider.keyTail}）` : '未设置'}</small>
                <div className="project-row-actions">
                  {isActive ? (
                    <button className="btn small" disabled={busy} onClick={() => void run('clear-default', async () => {
                      setState(await api.clearDefaultCodexProvider());
                      setNotice('已取消默认供应商，Codex 将使用自身登录配置');
                    })}>取消默认</button>
                  ) : (
                    <button className="btn small" disabled={busy} onClick={() => void run('activate', async () => {
                      setState(await api.activateCodexProvider(provider.id));
                      setNotice(`“${provider.name}”已设为默认，重新启动 Codex 后生效`);
                    })}>设为默认</button>
                  )}
                  <button className="btn small" disabled={busy} onClick={() => edit(provider)}>编辑</button>
                  <button className="btn small danger" disabled={busy || isActive} title={isActive ? '请先取消默认后再删除' : undefined}
                    onClick={() => setConfirmDelete(provider)}>删除</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {confirmDelete && <Dialog title="删除 Codex 供应商" onClose={() => { if (!busy) setConfirmDelete(null); }} footer={<>
        <button className="btn" disabled={busy} onClick={() => setConfirmDelete(null)}>取消</button>
        <button className="btn danger" disabled={busy} onClick={() => void run('delete', async () => {
          setState(await api.deleteCodexProvider(confirmDelete.id));
          setConfirmDelete(null);
          setNotice('Codex 供应商已删除');
        })}>删除</button>
      </>}>
        <p>确定删除“{confirmDelete.name}”？</p>
        {error && <div className="nav-error" role="alert">{error}</div>}
      </Dialog>}
    </ProviderPanel>
  );
}
