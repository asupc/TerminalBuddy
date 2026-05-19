import { FC, useState, useEffect, useCallback, useRef } from 'react';
import { fetchZhipuUsage, fetchQianfanUsage, tierDisplayName, utilizationColor, countdownStr, type AiUsageData } from '../services/aiUsage';
import { getAppSettings } from '../utils/settings';
import './AiUsagePanel.css';

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

interface ProviderBlockProps {
  label: string;
  fetchFn: () => Promise<AiUsageData>;
  hasCredential: boolean;
}

const ProviderBlock: FC<ProviderBlockProps> = ({ label, fetchFn, hasCredential }) => {
  const [data, setData] = useState<AiUsageData | null>(null);
  const [loading, setLoading] = useState(false);
  const loaded = useRef(false);

  const refresh = useCallback(async () => {
    if (!hasCredential) return;
    setLoading(true);
    const result = await fetchFn();
    setData(result);
    setLoading(false);
  }, [hasCredential, fetchFn]);

  useEffect(() => {
    if (!loaded.current) {
      loaded.current = true;
      refresh();
    }
  }, [refresh]);

  if (!hasCredential) return null;

  return (
    <div className="ai-usage-provider-block">
      <div className="ai-usage-provider-header">{label}</div>
      {loading && !data ? (
        <span className="ai-usage-text">加载中...</span>
      ) : data && data.success && data.tiers.length > 0 ? (
        <div className="ai-usage-bars">
          {data.tiers.map((tier) => (
            <TierRow key={tier.name} tier={tier} />
          ))}
        </div>
      ) : data && !data.success ? (
        <span className="ai-usage-error">{data.error || '查询失败'}</span>
      ) : (
        <span className="ai-usage-text">暂无数据</span>
      )}
    </div>
  );
};

export const AiUsagePanel: FC = () => {
  const settings = getAppSettings();
  const hasZhipu = !!settings.zhipuApiKey;
  const hasQianfan = !!settings.qianfanCookie;

  if (!hasZhipu && !hasQianfan) {
    return (
      <div className="ai-usage-tooltip">
        <span className="ai-usage-text">未配置，请在设置中填入</span>
      </div>
    );
  }

  const fetchZhipu = useCallback(() => fetchZhipuUsage(settings.zhipuApiKey), [settings.zhipuApiKey]);
  const fetchQianfan = useCallback(() => fetchQianfanUsage(settings.qianfanCookie), [settings.qianfanCookie]);

  return (
    <div className="ai-usage-tooltip">
      {hasZhipu && (
        <ProviderBlock
          label="智谱 GLM"
          fetchFn={fetchZhipu}
          hasCredential={hasZhipu}
        />
      )}
      {hasZhipu && hasQianfan && <div className="ai-usage-divider" />}
      {hasQianfan && (
        <ProviderBlock
          label="百度千帆"
          fetchFn={fetchQianfan}
          hasCredential={hasQianfan}
        />
      )}
    </div>
  );
};
