import { FC } from 'react';
import { useAppStore } from '../../stores/appStore';
import { LlmProvidersSegment } from '../claude-panel/segments/LlmProvidersSegment';
import { AntigravityProvidersSettings } from './AntigravityProvidersSettings';
import { CodexProvidersSettings } from './CodexProvidersSettings';
import './LlmProvidersSettings.css';

type ProviderTabId = 'claude' | 'codex' | 'antigravity';

const PROVIDER_TABS: ReadonlyArray<{ id: ProviderTabId; label: string }> = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
  { id: 'antigravity', label: 'Antigravity' },
];

/**
 * 设置页「模型供应商」：Claude / Codex / Antigravity 三个分页，各自维护自己的配置。
 * Claude 页复用 `LlmProvidersSegment`（与 Claude 面板同一份）；Codex 页管理通用 API 供应商；
 * Antigravity 页管理 Google 账号下的可用模型筛选与默认推理等级。
 */
export const LlmProvidersSettings: FC = () => {
  const tab = useAppStore(s => s.providerSettingsTab);
  const setTab = useAppStore(s => s.setProviderSettingsTab);

  return (
    <div className="llm-providers-settings">
      <div className="llm-providers-tabs" role="tablist" aria-label="模型供应商类型">
        {PROVIDER_TABS.map(item => (
          <button
            key={item.id}
            id={`llm-provider-tab-${item.id}`}
            type="button"
            role="tab"
            className={`llm-providers-tab${tab === item.id ? ' active' : ''}`}
            aria-selected={tab === item.id}
            aria-controls={`llm-provider-panel-${item.id}`}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div
        id="llm-provider-panel-claude"
        className="llm-providers-panel"
        role="tabpanel"
        aria-labelledby="llm-provider-tab-claude"
        hidden={tab !== 'claude'}
      >
        <LlmProvidersSegment />
      </div>

      <div
        id="llm-provider-panel-codex"
        className="llm-providers-panel"
        role="tabpanel"
        aria-labelledby="llm-provider-tab-codex"
        hidden={tab !== 'codex'}
      >
        <CodexProvidersSettings active={tab === 'codex'} />
      </div>

      <div
        id="llm-provider-panel-antigravity"
        className="llm-providers-panel"
        role="tabpanel"
        aria-labelledby="llm-provider-tab-antigravity"
        hidden={tab !== 'antigravity'}
      >
        <AntigravityProvidersSettings active={tab === 'antigravity'} />
      </div>
    </div>
  );
};
