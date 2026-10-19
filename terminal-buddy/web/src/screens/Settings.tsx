import { useStore } from '../store';
import { useState } from 'react';
import { CodexProvidersPanel } from '../components/CodexProvidersPanel';
import { LlmProvidersPanel } from '../components/LlmProvidersPanel';
import './Settings.css';

type ProviderTab = 'claude' | 'codex';

export default function Settings() {
  const [tab, setTab] = useState<ProviderTab>('claude');
  const enabled = useStore(state => state.showTaskSummary);
  const saving = useStore(state => state.taskSummarySaving);
  const error = useStore(state => state.taskSummaryError);
  const setShowTaskSummary = useStore(state => state.setShowTaskSummary);
  return (
    <div className="mobile-settings">
      <section className="mobile-task-summary-setting">
        <label className="mobile-task-summary-toggle">
          <span>显示任务摘要</span>
          <input type="checkbox" role="switch" checked={enabled} disabled={saving}
            onChange={event => { void setShowTaskSummary(event.target.checked); }} />
        </label>
        <p>在会话列表和窗口标题中显示当前 Claude / Codex 任务摘要。默认关闭，与桌面版同步；尚无摘要时显示原名称。</p>
        {error && <p role="alert">{error}</p>}
      </section>
      <header className="mobile-settings-heading">
        <h2>模型供应商</h2>
        <p>与完整网页共用供应商配置，可分别管理 Claude 和 Codex。</p>
      </header>
      <div className="provider-tabs" role="tablist" aria-label="模型供应商类型">
        {(['claude', 'codex'] as const).map((id) => (
          <button key={id} type="button" role="tab" id={`mobile-provider-tab-${id}`}
            className={`btn${tab === id ? ' primary' : ''}`} aria-selected={tab === id}
            aria-controls={`mobile-provider-panel-${id}`} onClick={() => setTab(id)}>
            {id === 'claude' ? 'Claude' : 'Codex'}
          </button>
        ))}
      </div>
      <div id="mobile-provider-panel-claude" role="tabpanel" aria-labelledby="mobile-provider-tab-claude" hidden={tab !== 'claude'}>
        <LlmProvidersPanel active={tab === 'claude'} />
      </div>
      <div id="mobile-provider-panel-codex" role="tabpanel" aria-labelledby="mobile-provider-tab-codex" hidden={tab !== 'codex'}>
        <CodexProvidersPanel active={tab === 'codex'} />
      </div>
    </div>
  );
}
