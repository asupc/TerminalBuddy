import { FC, useState, useEffect, useCallback, Fragment } from 'react';
import { fetchZhipuUsage, fetchQianfanUsage, fetchDeepseekUsage, tierDisplayName, utilizationColor, countdownStr, formatTokens, type AiUsageData, type DeepseekUsageData, type DeepseekDayUsage } from '../services/aiUsage';
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

const fmtDate = (d: Date) =>
  `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;

const DayBlock: FC<{
  title: string; date: string;
  data: DeepseekDayUsage;
}> = ({ title, date, data }) => {
  const rate = data.inputToken > 0 ? Math.round((data.cacheHitToken / data.inputToken) * 100) : null;
  return (
    <div className="ds-section">
      <div className="ds-section-head">
        <span>{title} {date}</span>
      </div>
      <div className="ds-row"><span className="ds-label">API请求</span><span className="ds-val">{formatTokens(data.request)}</span></div>
      <div className="ds-row"><span className="ds-label">输入</span><span className="ds-val">{formatTokens(data.inputToken)}{rate !== null && <span style={{ color: '#f59e0b' }}> ({rate}%)</span>}</span></div>
      <div className="ds-row"><span className="ds-label">输出</span><span className="ds-val">{formatTokens(data.outputToken)}</span></div>
      <div className="ds-row"><span className="ds-label">合计</span><span className="ds-val ds-token">{formatTokens(data.totalToken)}</span></div>
      <div className="ds-row"><span className="ds-label">消费</span><span className="ds-val ds-cost">¥{data.cost.toFixed(2)}</span></div>
    </div>
  );
};

const DeepseekView: FC<{ data: DeepseekUsageData }> = ({ data }) => {
  if (!data.success) {
    return <span className="ai-usage-error">{data.error || '查询失败'}</span>;
  }
  const hasData = data.normalWallets.length > 0 || data.bonusWallets.length > 0
    || data.today || data.yesterday;
  if (!hasData) {
    return <span className="ai-usage-text">暂无数据</span>;
  }

  const now = new Date();
  const yd = new Date(now);
  yd.setDate(yd.getDate() - 1);

  return (
    <div className="ds-card">
      <div className="ds-head">
        <span className="ds-title">DeepSeek 用量</span>
        <span className="ds-date">{now.toLocaleDateString('zh-CN')}</span>
      </div>

      {(data.normalWallets.length > 0 || data.bonusWallets.some(w => parseFloat(w.balance) > 0)) && (
        <div className="ds-section">
          <div className="ds-section-head"><span>账户余额</span></div>
          {data.normalWallets.map((w, i) => (
            <div key={`n${i}`} className="ds-row">
              <span className="ds-label">充值余额</span>
              <span className="ds-val ds-cost">{w.currency} {parseFloat(w.balance).toFixed(2)}</span>
            </div>
          ))}
          {data.bonusWallets.filter(w => parseFloat(w.balance) > 0).map((w, i) => (
            <div key={`b${i}`} className="ds-row">
              <span className="ds-label">赠送余额</span>
              <span className="ds-val ds-cost">{w.currency} {parseFloat(w.balance).toFixed(2)}</span>
            </div>
          ))}
        </div>
      )}

      {data.today && <DayBlock title="今日" date={fmtDate(now)} data={data.today} />}
      {!data.today && (
        <div className="ds-section">
          <div className="ds-section-head"><span>今日 {fmtDate(now)}</span></div>
          <span className="ds-label" style={{ padding: '2px 0' }}>暂无用量</span>
        </div>
      )}
      {data.yesterday && <DayBlock title="昨日" date={fmtDate(yd)} data={data.yesterday} />}
      {!data.yesterday && (
        <div className="ds-section">
          <div className="ds-section-head"><span>昨日 {fmtDate(yd)}</span></div>
          <span className="ds-label" style={{ padding: '2px 0' }}>暂无用量</span>
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
