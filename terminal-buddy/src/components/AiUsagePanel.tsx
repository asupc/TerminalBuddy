import { FC, useState, useEffect, useCallback } from 'react';
import { fetchZhipuUsage, tierDisplayName, utilizationColor, countdownStr, type AiUsageData } from '../services/aiUsage';
import { getAppSettings } from '../utils/settings';
import './AiUsagePanel.css';

export const AiUsagePanel: FC = () => {
  const [data, setData] = useState<AiUsageData | null>(null);
  const [loading, setLoading] = useState(false);
  const apiKey = getAppSettings().zhipuApiKey;

  const refresh = useCallback(async () => {
    if (!apiKey) {
      setData({ success: false, level: null, tiers: [], error: '未配置 API Key' });
      return;
    }
    setLoading(true);
    const result = await fetchZhipuUsage(apiKey);
    setData(result);
    setLoading(false);
  }, [apiKey]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const hasKey = !!apiKey;

  return (
    <div className="ai-usage-panel">
      {!hasKey ? (
        <span className="ai-usage-text">未配置 API Key，请在设置中填入</span>
      ) : loading ? (
        <span className="ai-usage-text">加载中...</span>
      ) : data && data.success && data.tiers.length > 0 ? (
        <div className="ai-usage-bars">
          {data.tiers.map((tier) => (
            <div key={tier.name} className="ai-usage-tier">
              <span className="ai-usage-tier-label">{tierDisplayName(tier.name)}</span>
              <div className="ai-usage-bar-track">
                <div
                  className="ai-usage-bar-fill"
                  style={{
                    width: `${Math.min(tier.utilization, 100)}%`,
                    background: utilizationColor(tier.utilization),
                  }}
                />
              </div>
              <span className="ai-usage-pct" style={{ color: utilizationColor(tier.utilization) }}>
                {Math.round(tier.utilization)}%
              </span>
              {tier.resetsAt && countdownStr(tier.resetsAt) && (
                <span className="ai-usage-countdown">{countdownStr(tier.resetsAt)}</span>
              )}
            </div>
          ))}
        </div>
      ) : data && !data.success ? (
        <span className="ai-usage-error">{data.error || '查询失败'}</span>
      ) : (
        <span className="ai-usage-text">暂无数据</span>
      )}
      {hasKey && (
        <button className="ai-usage-refresh" onClick={refresh} disabled={loading} title="刷新">
          ↻
        </button>
      )}
    </div>
  );
};
