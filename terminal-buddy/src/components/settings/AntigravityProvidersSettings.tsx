import { useCallback, useEffect, useMemo, useRef, useState, type FC } from 'react';
import { Check, GripVertical, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import {
  fetchAntigravityProviderModels,
  getAntigravityProviderConfig,
  saveAntigravityProviderConfig,
  type AntigravityEffortLevel,
  type AntigravityModel,
  type AntigravityModelEntry,
  type AntigravityProviderConfig,
} from '../../services/tauri';
import { useAppStore } from '../../stores/appStore';
import {
  ANTIGRAVITY_EFFORT_OPTIONS,
  resolveAntigravityEffort,
} from '../../utils/antigravityLaunch';
import { useDragReorder } from '../shared/useDragReorder';
import '../claude-panel/segments/shared.css';
import '../claude-panel/segments/LlmProvidersSegment.css';
import './AntigravityProvidersSettings.css';

const EMPTY_CONFIG: AntigravityProviderConfig = {
  defaultEffortLevel: '',
  availableModels: [],
  enabledModels: [],
};

const EFFORT_LABELS: Record<string, string> = {
  '': '跟随模型默认',
  low: 'low（低）',
  medium: 'medium（中）',
  high: 'high（高）',
  xhigh: 'xhigh（超高）',
  max: 'max（最大）',
};

const VALID_MODEL_ID_RE = /^[a-zA-Z0-9._:/-]+$/;

/**
 * 设置页「模型供应商 → Antigravity」面板：
 * 复用本机 `agy` CLI 的 Google 账号登录态，无需填写 API Key 或端点；
 * 从官网拉取可用模型清单，勾选启用的模型、调整排序与推理等级（Effort），并即时同步到项目右键与历史恢复菜单。
 */
export const AntigravityProvidersSettings: FC<{ active: boolean }> = ({ active }) => {
  const showToast = useAppStore(s => s.showToast);
  const storeConfig = useAppStore(s => s.antigravityProviderConfig);
  const setStoreConfig = useAppStore(s => s.setAntigravityProviderConfig);

  const [config, setConfig] = useState<AntigravityProviderConfig>(storeConfig ?? EMPTY_CONFIG);
  const [loaded, setLoaded] = useState(Boolean(storeConfig));
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [customModelId, setCustomModelId] = useState('');

  // 用串行保存队列保证高频勾选/切换 Effort 时按用户最终操作顺序落盘。
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const latestRevisionRef = useRef(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const next = await getAntigravityProviderConfig();
      setConfig(next);
      setStoreConfig(next);
      setLoaded(true);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [setStoreConfig]);

  useEffect(() => {
    if (active) {
      void load();
    }
  }, [active, load]);

  const persistNextConfig = useCallback((next: AntigravityProviderConfig) => {
    setConfig(next);
    const revision = ++latestRevisionRef.current;
    setSaving(true);
    setError('');
    saveChainRef.current = saveChainRef.current
      .catch(() => {})
      .then(async () => {
        try {
          const saved = await saveAntigravityProviderConfig(next);
          if (revision === latestRevisionRef.current) {
            setConfig(saved);
          }
          setStoreConfig(saved);
        } catch (err) {
          const message = String(err);
          setError(message);
          showToast(`保存 Antigravity 配置失败：${message}`, 'error');
        } finally {
          if (revision === latestRevisionRef.current) {
            setSaving(false);
          }
        }
      });
  }, [setStoreConfig, showToast]);

  const handleFetchModels = async () => {
    if (fetching) return;
    setFetching(true);
    setError('');
    try {
      // 等待在途保存落盘，避免刚修改的配置被 fetch 前读到的旧文件覆盖。
      await saveChainRef.current;
      const fetched = await fetchAntigravityProviderModels();
      setConfig(fetched);
      setStoreConfig(fetched);
      setLoaded(true);
      showToast(`已从官网获取 ${fetched.availableModels.length} 个可用模型`, 'success');
    } catch (err) {
      const message = String(err);
      setError(message);
      showToast(message, 'error');
    } finally {
      setFetching(false);
    }
  };

  const handleDefaultEffortChange = (effort: AntigravityEffortLevel) => {
    persistNextConfig({ ...config, defaultEffortLevel: effort });
  };

  const enabledMap = useMemo(
    () => new Map(config.enabledModels.map(item => [item.id, item])),
    [config.enabledModels],
  );

  const toggleAvailableModel = (model: AntigravityModel) => {
    const exists = enabledMap.has(model.id);
    const nextEnabled: AntigravityModelEntry[] = exists
      ? config.enabledModels.filter(item => item.id !== model.id)
      : [...config.enabledModels, { id: model.id, name: model.name || model.id, effortLevel: '' }];
    persistNextConfig({ ...config, enabledModels: nextEnabled });
  };

  const handleEntryEffortChange = (id: string, effortLevel: AntigravityEffortLevel) => {
    persistNextConfig({
      ...config,
      enabledModels: config.enabledModels.map(item => (
        item.id === id ? { ...item, effortLevel } : item
      )),
    });
  };

  const removeEnabledModel = (id: string) => {
    persistNextConfig({
      ...config,
      enabledModels: config.enabledModels.filter(item => item.id !== id),
    });
  };

  const addCustomModel = () => {
    const id = customModelId.trim();
    if (!id) return;
    if (!VALID_MODEL_ID_RE.test(id)) {
      showToast('模型 ID 只能包含字母、数字与 . _ : / -', 'error');
      return;
    }
    if (enabledMap.has(id)) {
      showToast(`模型「${id}」已在启用列表中`, 'info');
      setCustomModelId('');
      return;
    }
    const matched = config.availableModels.find(item => item.id === id);
    const nextEntry: AntigravityModelEntry = {
      id,
      name: matched?.name || id,
      effortLevel: '',
    };
    persistNextConfig({
      ...config,
      enabledModels: [...config.enabledModels, nextEntry],
    });
    setCustomModelId('');
  };

  const filteredAvailable = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    if (!keyword) return config.availableModels;
    return config.availableModels.filter(model => (
      model.id.toLowerCase().includes(keyword) || model.name.toLowerCase().includes(keyword)
    ));
  }, [config.availableModels, search]);

  const selectAllFiltered = () => {
    const additions: AntigravityModelEntry[] = [];
    for (const model of filteredAvailable) {
      if (!enabledMap.has(model.id)) {
        additions.push({ id: model.id, name: model.name || model.id, effortLevel: '' });
      }
    }
    if (additions.length === 0) return;
    persistNextConfig({
      ...config,
      enabledModels: [...config.enabledModels, ...additions],
    });
  };

  const clearEnabled = () => {
    if (config.enabledModels.length === 0) return;
    persistNextConfig({ ...config, enabledModels: [] });
  };

  const { containerRef, startDrag, dragClass } = useDragReorder((from, to) => {
    const next = [...config.enabledModels];
    const [moved] = next.splice(from, 1);
    if (!moved) return;
    next.splice(to, 0, moved);
    persistNextConfig({ ...config, enabledModels: next });
  });

  const defaultEffortSummary = EFFORT_LABELS[config.defaultEffortLevel] ?? '跟随模型默认';
  const busy = fetching || loading;

  return (
    <div className="claude-segment llm-providers-segment antigravity-providers-settings" aria-busy={busy}>
      <div className="claude-segment-toolbar">
        <span className="claude-segment-title">Antigravity CLI（Google 账号）</span>
        <span className="claude-segment-actions">
          {saving && <span className="antigravity-save-status">正在保存…</span>}
          {!saving && loaded && <span className="antigravity-save-status synced"><Check size={12} aria-hidden="true" /> 已同步右键菜单</span>}
          <button
            type="button"
            className="claude-segment-btn primary"
            disabled={fetching}
            onClick={() => { void handleFetchModels(); }}
          >
            <RefreshCw size={14} className={fetching ? 'antigravity-spin' : undefined} aria-hidden="true" />
            {fetching ? '获取中…' : '从官网获取可用模型'}
          </button>
        </span>
      </div>

      <p className="antigravity-provider-description">
        Antigravity CLI 使用本机 Google 账号登录态，无需配置 API 密钥或端点。
        从官网获取可用模型后勾选要启用的模型并设置默认推理等级（Effort），将自动同步到项目右键启动与历史会话恢复菜单。
      </p>

      {error && (
        <div className="antigravity-provider-error" role="alert">
          {error}
        </div>
      )}

      <div className="antigravity-default-card">
        <div className="antigravity-default-info">
          <strong>默认推理等级（Effort）</strong>
          <small>同步到项目右键「默认模型启动」、未单独指定等级的已启用模型及历史会话恢复（<code>--effort</code>）。</small>
        </div>
        <select
          aria-label="Antigravity 默认推理等级"
          className="antigravity-effort-select"
          value={config.defaultEffortLevel}
          disabled={loading}
          onChange={e => handleDefaultEffortChange(e.target.value as AntigravityEffortLevel)}
        >
          {ANTIGRAVITY_EFFORT_OPTIONS.map(option => (
            <option key={option.value || 'default'} value={option.value}>{option.label}</option>
          ))}
        </select>
      </div>

      <section className="antigravity-section">
        <div className="antigravity-section-head">
          <div className="antigravity-section-title">
            <strong>已启用模型</strong>
            <span className="antigravity-count-badge">{config.enabledModels.length}</span>
          </div>
          <div className="antigravity-section-actions">
            {config.enabledModels.length > 0 && (
              <button type="button" className="claude-segment-btn mini" onClick={clearEnabled}>
                清空已选
              </button>
            )}
          </div>
        </div>

        {config.enabledModels.length === 0 ? (
          <div className="claude-segment-empty antigravity-empty-box">
            尚未启用任何模型
            <small>从下方官网可用模型清单勾选模型，即可在项目右键菜单平铺展示；未启用时右键显示「默认模型启动」。</small>
          </div>
        ) : (
          <div className="antigravity-enabled-list" ref={containerRef}>
            {config.enabledModels.map((entry, index) => {
              const resolved = resolveAntigravityEffort(entry.effortLevel, config.defaultEffortLevel);
              return (
                <div
                  key={entry.id}
                  data-drag-index={index}
                  className={`antigravity-enabled-row model-drag-row${dragClass(index)}`}
                >
                  <span
                    className="model-drag-handle"
                    role="button"
                    tabIndex={0}
                    title="拖拽调整菜单显示顺序"
                    aria-label={`拖拽排序模型 ${entry.name || entry.id}`}
                    onPointerDown={event => startDrag(event, index)}
                  >
                    <GripVertical size={14} aria-hidden="true" />
                  </span>
                  <div className="antigravity-enabled-meta">
                    <span className="antigravity-enabled-name" title={entry.name}>{entry.name || entry.id}</span>
                    <code className="antigravity-enabled-id" title={entry.id}>{entry.id}</code>
                  </div>
                  {resolved && (
                    <span className={`claude-model-effort effort-${resolved}`} title="生效的 --effort 参数">
                      {resolved}
                    </span>
                  )}
                  <select
                    className="antigravity-effort-select compact"
                    aria-label={`${entry.name || entry.id} 推理等级`}
                    value={entry.effortLevel}
                    onChange={e => handleEntryEffortChange(entry.id, e.target.value as AntigravityEffortLevel)}
                  >
                    <option value="">跟随全局（{defaultEffortSummary}）</option>
                    {ANTIGRAVITY_EFFORT_OPTIONS.filter(opt => opt.value !== '').map(option => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="claude-segment-btn mini danger"
                    title="从启用列表移除"
                    aria-label={`移除 ${entry.name || entry.id}`}
                    onClick={() => removeEnabledModel(entry.id)}
                  >
                    <Trash2 size={13} aria-hidden="true" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="antigravity-section">
        <div className="antigravity-section-head">
          <div className="antigravity-section-title">
            <strong>官网可用模型清单</strong>
            <span className="antigravity-count-badge">{config.availableModels.length}</span>
          </div>
          <div className="antigravity-section-actions">
            <div className="antigravity-search-wrap">
              <Search size={13} className="antigravity-search-icon" aria-hidden="true" />
              <input
                type="search"
                className="antigravity-search-input"
                placeholder="筛选模型名称或 ID…"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
            {filteredAvailable.length > 0 && (
              <button type="button" className="claude-segment-btn mini" onClick={selectAllFiltered}>
                全选筛选 ({filteredAvailable.length})
              </button>
            )}
          </div>
        </div>

        {config.availableModels.length === 0 ? (
          <div className="claude-segment-empty antigravity-empty-box">
            {loading ? '正在读取本地 Antigravity 模型配置…' : '暂无缓存的官网模型清单'}
            <small>点击右上角「从官网获取可用模型」拉取当前 Google 账号可用的全部 Antigravity 模型。</small>
          </div>
        ) : filteredAvailable.length === 0 ? (
          <div className="claude-segment-empty antigravity-empty-box">
            没有匹配「{search.trim()}」的模型
          </div>
        ) : (
          <div className="antigravity-available-grid">
            {filteredAvailable.map(model => {
              const checked = enabledMap.has(model.id);
              return (
                <label
                  key={model.id}
                  className={`antigravity-available-item${checked ? ' is-checked' : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleAvailableModel(model)}
                  />
                  <span className="antigravity-available-text">
                    <span className="antigravity-available-name" title={model.name}>{model.name}</span>
                    {model.id !== model.name && (
                      <code className="antigravity-available-id" title={model.id}>{model.id}</code>
                    )}
                  </span>
                </label>
              );
            })}
          </div>
        )}

        <div className="antigravity-custom-row">
          <input
            type="text"
            className="antigravity-custom-input"
            placeholder="也可手动添加模型 ID（例如 gemini-3-pro-high）"
            value={customModelId}
            spellCheck={false}
            onChange={e => setCustomModelId(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addCustomModel();
              }
            }}
          />
          <button
            type="button"
            className="claude-segment-btn"
            disabled={!customModelId.trim()}
            onClick={addCustomModel}
          >
            <Plus size={14} aria-hidden="true" /> 添加模型
          </button>
        </div>
      </section>
    </div>
  );
};
