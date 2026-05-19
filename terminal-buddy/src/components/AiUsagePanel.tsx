import { FC, useState, useEffect, useCallback } from 'react';
import { fetchZhipuUsage, fetchQianfanUsage, tierDisplayName, utilizationColor, countdownStr, type AiUsageData } from '../services/aiUsage';
import { getAppSettings } from '../utils/settings';
import './AiUsagePanel.css';

const cache: Record<string, AiUsageData | null> = { zhipu: null, qianfan: null };

interface TierRowProps {
  tier: { name: string; utilization: number; resetsAt: string | null };
}

const TierRow: FC<TierRowProps> = ({ tier }) => (
  <div className="ai-usage-tier">
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
);

const TiersView: FC<{ data: AiUsageData }> = ({ data }) => {
  if (data.success && data.tiers.length > 0) {
    return (
      <div className="ai-usage-bars">
        {data.tiers.map((tier) => (
          <TierRow key={tier.name} tier={tier} />
        ))}
      </div>
    );
  }
  if (!data.success) {
    return <span className="ai-usage-error">{data.error || '查询失败'}</span>;
  }
  return <span className="ai-usage-text">暂无数据</span>;
};

interface ProviderBlockProps {
  cacheKey: string;
  label: string;
  fetchFn: () => Promise<AiUsageData>;
}

const ProviderBlock: FC<ProviderBlockProps> = ({ cacheKey, label, fetchFn }) => {
  const cached = cache[cacheKey];
  const [data, setData] = useState<AiUsageData | null>(cached);
  const [refreshing, setRefreshing] = useState(true);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    const start = Date.now();
    const result = await fetchFn();
    cache[cacheKey] = result;
    setData(result);
    const elapsed = Date.now() - start;
    if (elapsed < 600) {
      setTimeout(() => setRefreshing(false), 600 - elapsed);
    } else {
      setRefreshing(false);
    }
  }, [cacheKey, fetchFn]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <div className="ai-usage-provider-block">
      <div className="ai-usage-provider-header">
        {label}
        {refreshing && <span className="ai-usage-spinner" />}
      </div>
      {data ? <TiersView data={data} /> : <span className="ai-usage-text">加载中...</span>}
    </div>
  );
};

export const AiUsagePanel: FC = () => {
  const settings = getAppSettings();
  const hasZhipu = !!settings.zhipuApiKey;
  const hasQianfan = !!settings.qianfanCookie;

  const fetchZhipu = useCallback(() => fetchZhipuUsage(settings.zhipuApiKey), [settings.zhipuApiKey]);
  const fetchQianfan = useCallback(() => fetchQianfanUsage(settings.qianfanCookie), [settings.qianfanCookie]);

  if (!hasZhipu && !hasQianfan) {
    return (
      <div className="ai-usage-tooltip">
        <span className="ai-usage-text">未配置，请在设置中填入</span>
      </div>
    );
  }

  return (
    <div className="ai-usage-tooltip">
      {hasZhipu && (
        <ProviderBlock
          cacheKey="zhipu"
          label="智谱 GLM"
          fetchFn={fetchZhipu}
        />
      )}
      {hasZhipu && hasQianfan && <div className="ai-usage-divider" />}
      {hasQianfan && (
        <ProviderBlock
          cacheKey="qianfan"
          label="百度千帆"
          fetchFn={fetchQianfan}
        />
      )}
    </div>
  );
};
