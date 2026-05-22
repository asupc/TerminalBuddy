import { FC, useState, useEffect, useCallback, Fragment } from 'react';
import { fetchZhipuUsage, fetchQianfanUsage, fetchDeepseekUsage, tierDisplayName, utilizationColor, countdownStr, formatTokens, type AiUsageData, type DeepseekUsageData } from '../services/aiUsage';
import { getAppSettings } from '../utils/settings';
import './AiUsagePanel.css';

const cache: Record<string, any> = { zhipu: null, qianfan: null, deepseek: null };

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

const DeepseekView: FC<{ data: DeepseekUsageData }> = ({ data }) => {
  if (!data.success) {
    return <span className="ai-usage-error">{data.error || '查询失败'}</span>;
  }
  const hasBalance = data.normalWallets.length > 0 || data.bonusWallets.length > 0;
  if (!hasBalance && !data.today && !data.yesterday && !data.month) {
    return <span className="ai-usage-text">暂无数据</span>;
  }

  return (
    <div className="ai-usage-bars">
      {data.normalWallets.map((w, i) => (
        <div key={`n${i}`} className="ai-usage-tier" style={{ gap: 6 }}>
          <span className="ai-usage-tier-label">余额</span>
          <span className="ai-usage-pct" style={{ color: parseFloat(w.balance) > 0 ? '#22c55e' : '#ef4444', fontSize: 13 }}>
            {w.currency} {parseFloat(w.balance).toFixed(2)}
          </span>
        </div>
      ))}
      {data.bonusWallets.filter(w => parseFloat(w.balance) > 0).map((w, i) => (
        <div key={`b${i}`} className="ai-usage-tier" style={{ gap: 6 }}>
          <span className="ai-usage-tier-label">赠送</span>
          <span className="ai-usage-pct" style={{ color: '#3b82f6', fontSize: 13 }}>
            {w.currency} {parseFloat(w.balance).toFixed(2)}
          </span>
        </div>
      ))}
      {data.today && (
        <div className="ai-usage-tier" style={{ gap: 6 }}>
          <span className="ai-usage-tier-label">今日</span>
          <span className="ai-usage-pct" style={{ fontSize: 12, color: 'var(--text-primary)' }}>
            {formatTokens(data.today.totalToken)} tokens · {data.today.cost.toFixed(2)}元
          </span>
        </div>
      )}
      {data.yesterday && (
        <div className="ai-usage-tier" style={{ gap: 6 }}>
          <span className="ai-usage-tier-label">昨日</span>
          <span className="ai-usage-pct" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            {formatTokens(data.yesterday.totalToken)} tokens · {data.yesterday.cost.toFixed(2)}元
          </span>
        </div>
      )}
      {data.month && (
        <div className="ai-usage-tier" style={{ gap: 6 }}>
          <span className="ai-usage-tier-label">本月</span>
          <span className="ai-usage-pct" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            {formatTokens(data.month.totalToken)} tokens · {data.month.totalCost.toFixed(2)}元
          </span>
        </div>
      )}
    </div>
  );
};

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
  fetchFn: () => Promise<any>;
  isDeepseek?: boolean;
}

const ProviderBlock: FC<ProviderBlockProps> = ({ cacheKey, label, fetchFn, isDeepseek }) => {
  const cached = cache[cacheKey];
  const [data, setData] = useState<any>(cached);
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
      {data ? (
        isDeepseek ? <DeepseekView data={data} /> : <TiersView data={data} />
      ) : <span className="ai-usage-text">加载中...</span>}
    </div>
  );
};

export const AiUsagePanel: FC = () => {
  const settings = getAppSettings();
  const hasZhipu = !!settings.zhipuApiKey;
  const hasQianfan = !!settings.qianfanCookie;
  const hasDeepseek = !!settings.deepseekApiKey;

  const fetchZhipu = useCallback(() => fetchZhipuUsage(settings.zhipuApiKey), [settings.zhipuApiKey]);
  const fetchQianfan = useCallback(() => fetchQianfanUsage(settings.qianfanCookie), [settings.qianfanCookie]);
  const fetchDeepseekCb = useCallback(() => fetchDeepseekUsage(settings.deepseekApiKey), [settings.deepseekApiKey]);

  if (!hasZhipu && !hasQianfan && !hasDeepseek) {
    return (
      <div className="ai-usage-tooltip">
        <span className="ai-usage-text">未配置，请在设置中填入</span>
      </div>
    );
  }

  const providers = [
    hasZhipu && <ProviderBlock key="zhipu" cacheKey="zhipu" label="智谱 GLM" fetchFn={fetchZhipu} />,
    hasQianfan && <ProviderBlock key="qianfan" cacheKey="qianfan" label="百度千帆" fetchFn={fetchQianfan} />,
    hasDeepseek && <ProviderBlock key="deepseek" cacheKey="deepseek" label="DeepSeek" fetchFn={fetchDeepseekCb} isDeepseek />,
  ].filter(Boolean);

  return (
    <div className="ai-usage-tooltip">
      {providers.map((block, i) => (
        <Fragment key={i}>
          {i > 0 && <div className="ai-usage-divider" />}
          {block}
        </Fragment>
      ))}
    </div>
  );
};
