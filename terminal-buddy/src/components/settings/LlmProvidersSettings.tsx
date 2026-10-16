import { FC, useState } from 'react';
import { LlmProvidersSegment } from '../claude-panel/segments/LlmProvidersSegment';
import './LlmProvidersSettings.css';

type ProviderTabId = 'claude' | 'codex';

const PROVIDER_TABS: ReadonlyArray<{ id: ProviderTabId; label: string }> = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
];

/**
 * 设置页「模型供应商」：Claude / Codex 两个分页，各自维护自己的供应商数据。
 * Claude 页复用 `LlmProvidersSegment`（与 Claude 面板同一份）；Codex 页暂为空壳。
 * 两个 panel 都常驻挂载，切换分页不丢编辑状态。
 */
export const LlmProvidersSettings: FC = () => {
  const [tab, setTab] = useState<ProviderTabId>('claude');

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
        <div className="llm-providers-empty">
          Codex 供应商暂未开放
          <small>后续在此配置 Codex 的 API 地址、密钥与模型</small>
        </div>
      </div>
    </div>
  );
};
