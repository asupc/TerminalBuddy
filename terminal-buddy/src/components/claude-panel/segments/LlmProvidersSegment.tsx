import { FC, useCallback, useEffect, useState } from 'react';
import {
  EFFORT_LABELS,
  EFFORT_LEVELS,
  clearDefaultLlmProvider,
  deleteLlmProvider,
  listLlmProviders,
  saveLlmProvider,
  setDefaultLlmProvider,
  type EffortLevel,
  type LlmProviderInput,
  type LlmProviderView,
} from '../../../services/tauri';
import { useAppStore } from '../../../stores/appStore';
import { ConfirmDialog } from '../../shared/Dialog';
import { LlmProviderDialog, type LlmProviderDraft } from './LlmProviderDialog';
import './shared.css';
import './LlmProvidersSegment.css';

function emptyDraft(sortIndex: number): LlmProviderDraft {
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

function draftFrom(view: LlmProviderView): LlmProviderDraft {
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
    // 行式编辑：行存在即启用，未启用的旧条目不进入编辑视图（保存后清除）。
    models: view.enabledModels.filter(model => model.enabled).map(model => ({ ...model })),
    sortIndex: view.sortIndex,
  };
}

function enabledCount(view: LlmProviderView): number {
  return view.enabledModels.filter(model => model.enabled).length;
}

/** 模型供应商管理：卡片列表 + Dialog 编辑（与 Codex 交互一致）。保存后刷新右键菜单数据源。 */
export const LlmProvidersSegment: FC = () => {
  const showToast = useAppStore(s => s.showToast);
  const refreshClaudeLaunchTargets = useAppStore(s => s.refreshClaudeLaunchTargets);
  const [providers, setProviders] = useState<LlmProviderView[]>([]);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState<LlmProviderDraft | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<LlmProviderView | null>(null);

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

  const afterMutation = useCallback(async (message: string) => {
    await refreshClaudeLaunchTargets();
    showToast(message, 'success');
  }, [refreshClaudeLaunchTargets, showToast]);

  const saveDraft = async (editor: LlmProviderDraft) => {
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
    const enabledModels = editor.models
      .filter(model => model.id.trim())
      .map(model => ({ ...model, id: model.id.trim(), enabled: true }));
    const duplicate = enabledModels.find(
      (model, index) => enabledModels.findIndex(other => other.id === model.id) !== index,
    );
    if (duplicate) {
      showToast(`模型「${duplicate.id}」重复，请删除重复项后再保存`, 'error');
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
      enabledModels,
      sortIndex: editor.sortIndex,
    };
    if (editor.providerId) input.id = editor.providerId;
    try {
      await saveLlmProvider(input);
      // 后端 save 返回单条视图，重新拉全量保持排序一致。
      setProviders(await listLlmProviders());
      setDraft(null);
      await afterMutation('供应商已保存');
    } catch (error) {
      showToast(String(error), 'error');
    }
  };

  const doDelete = async (view: LlmProviderView) => {
    try {
      const next = await deleteLlmProvider(view.id);
      setProviders(next);
      if (draft?.providerId === view.id) setDraft(null);
      await afterMutation('已删除');
    } catch (error) {
      showToast(String(error), 'error');
    }
  };

  const doSetDefault = async (view: LlmProviderView) => {
    try {
      setProviders(await setDefaultLlmProvider(view.id));
      await afterMutation(`「${view.name}」已设为默认供应商`);
    } catch (error) {
      showToast(String(error), 'error');
    }
  };

  const doClearDefault = async () => {
    try {
      setProviders(await clearDefaultLlmProvider());
      await afterMutation('已取消默认供应商，右键菜单不再平铺模型');
    } catch (error) {
      showToast(String(error), 'error');
    }
  };

  return (
    <div className="claude-segment llm-providers-segment">
      <div className="claude-segment-toolbar">
        <span className="claude-segment-title">模型供应商</span>
        <span className="claude-segment-actions">
          <button
            type="button"
            className="claude-segment-btn"
            onClick={() => setDraft(emptyDraft(providers.length))}
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
          <div key={view.id} className="llm-provider-card">
            <div className="llm-provider-head">
              <span className="llm-provider-name" title={view.name}>{view.name}</span>
              {view.isDefault && <span className="llm-badge default">默认</span>}
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
              {view.isDefault
                ? <button type="button" className="claude-segment-btn mini" onClick={() => { void doClearDefault(); }}>取消默认</button>
                : <button type="button" className="claude-segment-btn mini" onClick={() => { void doSetDefault(view); }}>设默认</button>}
              <button type="button" className="claude-segment-btn mini" onClick={() => setDraft(draftFrom(view))}>编辑</button>
              <button type="button" className="claude-segment-btn mini danger" onClick={() => setDeleteTarget(view)}>删除</button>
            </div>
          </div>
        ))}
      </div>

      {draft && (
        <LlmProviderDialog
          draft={draft}
          onClose={() => setDraft(null)}
          onSave={saveDraft}
        />
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
