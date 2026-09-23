import { FC, useState, useEffect, useCallback, Fragment } from 'react';
import { fetchZhipuUsage, fetchQianfanUsage, fetchDeepseekUsage, fetchMinimaxUsage, fetchArkUsage, tierDisplayName, utilizationColor, countdownStr, formatTokens, type AiUsageData, type DeepseekUsageData, type DeepseekDayUsage } from '../../services/aiUsage';
import { getAppSettings } from '../../utils/settings';
import './AiUsagePanel.css';

const cache: Record<string, { data: any; timestamp: number; success: boolean }> = {};
const CACHE_TTL = 60_000; // 1 minute

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

const DayBlock: FC<{
  title: string; accent: string;
  data: DeepseekDayUsage;
}> = ({ title, accent, data }) => {
  const rate = data.inputToken > 0 ? Math.round((data.cacheHitToken / data.inputToken) * 100) : null;
  return (
    <div className="ds-section" style={{ borderLeftColor: accent }}>
      <div className="ds-section-head">
        <span className="ds-label">{title}</span>

        <span className="ds-request">{formatTokens(data.request)}次/<span className="ds-cost">¥{data.cost.toFixed(2)}</span></span>
      </div>
      <div className="ds-row">
        <span className="ds-label">输入/输出</span>
        <span className="ds-val">{formatTokens(data.inputToken)}{rate !== null && <span className="ds-cache">{rate}%</span>}/{formatTokens(data.outputToken)}</span>
      </div>
    </div>
  );
};

const DeepseekView: FC<{ data: DeepseekUsageData }> = ({ data }) => {
  if (!data.success) {
    return <span className="ai-usage-error">{data.error || '查询失败'}</span>;
  }
  const hasData = data.normalWallets.length > 0 || data.bonusWallets.length > 0
    || data.today || data.yesterday || data.week || data.month;
  if (!hasData) {
    return <span className="ai-usage-text">暂无数据</span>;
  }

  const now = new Date();
  const yd = new Date(now);
  yd.setDate(yd.getDate() - 1);

  const normalTotal = data.normalWallets.reduce((s, w) => s + parseFloat(w.balance), 0);
  const bonusTotal = data.bonusWallets.reduce((s, w) => s + parseFloat(w.balance), 0);

  return (
    <div className="ds-card">
      {data.today && <DayBlock title="今日" data={data.today} accent="#10b981" />}
      {data.yesterday && <DayBlock title="昨日" data={data.yesterday} accent="#6366f1" />}
      {(normalTotal > 0 || bonusTotal > 0 || data.month) && (
        <div className="ds-section" style={{ borderLeftColor: '#f59e0b' }}>
          {(normalTotal > 0 || bonusTotal > 0) && (
            <div className="ds-row">
              <span className="ds-label">余额</span>
              <span className="ds-val">{normalTotal > 0 && <span className="ds-balance-amount">¥{normalTotal.toFixed(2)}</span>}{bonusTotal > 0 && <span className="ds-bonus"> 赠{bonusTotal.toFixed(2)}</span>}</span>
            </div>
          )}   
          {data.week && (
            <div className="ds-row">
              <span className="ds-label">本周</span>
              <span className="ds-val"><span className="ds-token">{formatTokens(data.week.totalToken)}</span>· <span className="ds-cost">¥{data.week.cost.toFixed(2)}</span></span>
            </div>
        )}
          {data.month && (
            <div className="ds-row">
              <span className="ds-label">本月</span>
              <span className="ds-val"><span className="ds-token">{formatTokens(data.month.totalToken)}</span> · <span className="ds-cost">¥{data.month.totalCost.toFixed(2)}</span></span>
            </div>
          )}
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

const isCacheFresh = (entry: { timestamp: number; success: boolean } | undefined) =>
  !!entry && entry.success && Date.now() - entry.timestamp <= CACHE_TTL;

const ProviderBlock: FC<ProviderBlockProps> = ({ cacheKey, label, fetchFn, isDeepseek }) => {
  const cached = cache[cacheKey];
  const [data, setData] = useState<any>(cached?.data);
  const [refreshing, setRefreshing] = useState(!isCacheFresh(cached));

  const refresh = useCallback(async () => {
    setRefreshing(true);
    const start = Date.now();
    const result = await fetchFn();
    // 只缓存成功的结果，失败时清掉缓存以便下次重新拉取
    if (result?.success) {
      cache[cacheKey] = { data: result, timestamp: Date.now(), success: true };
    } else {
      delete cache[cacheKey];
    }
    setData(result);
    const elapsed = Date.now() - start;
    if (elapsed < 600) {
      setTimeout(() => setRefreshing(false), 600 - elapsed);
    } else {
      setRefreshing(false);
    }
  }, [cacheKey, fetchFn]);

  useEffect(() => {
    if (isCacheFresh(cached)) {
      setData(cached!.data);
      setRefreshing(false);
      return;
    }
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
  const hasMinimax = !!settings.minimaxApiKey;
  const hasDeepseek = !!settings.deepseekApiKey;
  const hasArk = !!settings.arkCookie;

  const fetchZhipu = useCallback(() => fetchZhipuUsage(settings.zhipuApiKey), [settings.zhipuApiKey]);
  const fetchQianfan = useCallback(() => fetchQianfanUsage(settings.qianfanCookie), [settings.qianfanCookie]);
  const fetchMinimaxCb = useCallback(() => fetchMinimaxUsage(settings.minimaxApiKey), [settings.minimaxApiKey]);
  const fetchDeepseekCb = useCallback(() => fetchDeepseekUsage(settings.deepseekApiKey), [settings.deepseekApiKey]);
  const fetchArkCb = useCallback(() => fetchArkUsage(settings.arkCookie), [settings.arkCookie]);

  if (!hasZhipu && !hasQianfan && !hasDeepseek && !hasMinimax && !hasArk) {
    return (
      <div className="ai-usage-tooltip">
        <span className="ai-usage-text">未配置，请在设置中填入</span>
      </div>
    );
  }

  const providers = [
    hasZhipu && <ProviderBlock key="zhipu" cacheKey="zhipu" label="智谱 GLM" fetchFn={fetchZhipu} />,
    hasQianfan && <ProviderBlock key="qianfan" cacheKey="qianfan" label="百度千帆" fetchFn={fetchQianfan} />,
    hasMinimax && <ProviderBlock key="minimax" cacheKey="minimax" label="MiniMax" fetchFn={fetchMinimaxCb} />,
    hasArk && <ProviderBlock key="ark" cacheKey="ark" label="火山方舟" fetchFn={fetchArkCb} />,
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
