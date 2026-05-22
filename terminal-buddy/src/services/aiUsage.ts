export interface QuotaTier {
  name: string;
  utilization: number;
  resetsAt: string | null;
}

export interface AiUsageData {
  success: boolean;
  level: string | null;
  tiers: QuotaTier[];
  error: string | null;
}

const TIER_NAMES: Record<string, string> = {
  five_hour: '5小时',
  weekly_limit: '每周',
  qianfan_rpm: 'RPM',
  qianfan_tpm: 'TPM',
  deepseek_balance: '余额',
};

export function tierDisplayName(name: string): string {
  return TIER_NAMES[name] || name;
}

export function utilizationColor(pct: number): string {
  if (pct >= 90) return '#ef4444';
  if (pct >= 70) return '#f97316';
  return '#22c55e';
}

export function countdownStr(resetsAt: string | null): string | null {
  if (!resetsAt) return null;
  const diffMs = new Date(resetsAt).getTime() - Date.now();
  if (diffMs <= 0) return null;
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
  if (hours > 24) {
    const days = Math.floor(hours / 24);
    return `${days}d${hours % 24}h`;
  }
  if (hours > 0) return `${hours}h${minutes}m`;
  return `${minutes}m`;
}

export async function fetchZhipuUsage(apiKey: string): Promise<AiUsageData> {
  try {
    const resp = await fetch('https://api.z.ai/api/monitor/usage/quota/limit', {
      method: 'GET',
      headers: {
        'Authorization': apiKey,
        'Content-Type': 'application/json',
        'Accept-Language': 'en-US,en',
      },
    });

    if (resp.status === 401 || resp.status === 403) {
      return { success: false, level: null, tiers: [], error: 'API Key 无效' };
    }

    if (!resp.ok) {
      return { success: false, level: null, tiers: [], error: `请求失败 (HTTP ${resp.status})` };
    }

    const body = await resp.json();

    if (body.success === false) {
      return { success: false, level: null, tiers: [], error: body.msg || '未知错误' };
    }

    const data = body.data;
    if (!data) {
      return { success: false, level: null, tiers: [], error: '响应缺少 data 字段' };
    }

    const level = data.level || null;
    const tiers: QuotaTier[] = [];

    if (Array.isArray(data.limits)) {
      for (const item of data.limits) {
        if ((item.type || '').toUpperCase() !== 'TOKENS_LIMIT') continue;
        const percentage = item.percentage ?? 0;
        const resetMs = item.nextResetTime;
        const resetsAt = resetMs ? new Date(resetMs).toISOString() : null;
        const name = tiers.length === 0 ? 'five_hour' : 'weekly_limit';
        tiers.push({ name, utilization: percentage, resetsAt });
        if (tiers.length >= 2) break;
      }
    }

    return { success: true, level, tiers, error: null };
  } catch (e) {
    return { success: false, level: null, tiers: [], error: `网络错误: ${String(e)}` };
  }
}

export async function fetchQianfanUsage(cookie: string): Promise<AiUsageData> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const result = await invoke<{
      success: boolean;
      tiers: Array<{ name: string; utilization: number; resets_at: string | null }>;
      error: string | null;
    }>('fetch_qianfan_usage', { cookie });
    return {
      success: result.success,
      level: null,
      tiers: result.tiers.map(t => ({ name: t.name, utilization: t.utilization, resetsAt: t.resets_at })),
      error: result.error,
    };
  } catch (e) {
    return { success: false, level: null, tiers: [], error: `调用失败: ${String(e)}` };
  }
}

export async function fetchDeepseekUsage(apiKey: string): Promise<AiUsageData> {
  try {
    const resp = await fetch('https://api.deepseek.com/user/balance', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json',
      },
    });

    if (resp.status === 401 || resp.status === 403) {
      return { success: false, level: null, tiers: [], error: 'API Key 无效' };
    }

    if (!resp.ok) {
      return { success: false, level: null, tiers: [], error: `请求失败 (HTTP ${resp.status})` };
    }

    const body = await resp.json();
    const isAvailable = body.is_available !== false;
    const balanceInfos = body.balance_infos;

    if (!Array.isArray(balanceInfos) || balanceInfos.length === 0) {
      return { success: false, level: null, tiers: [], error: isAvailable ? '暂无余额数据' : '余额不足' };
    }

    const tiers: QuotaTier[] = balanceInfos.map((info: any) => {
      const currency = info.currency || 'CNY';
      const totalBalance = typeof info.total_balance === 'number'
        ? info.total_balance
        : parseFloat(info.total_balance) || 0;
      const granted = typeof info.granted_balance === 'number'
        ? info.granted_balance
        : parseFloat(info.granted_balance) || 0;
      const toppedUp = typeof info.topped_up_balance === 'number'
        ? info.topped_up_balance
        : parseFloat(info.topped_up_balance) || 0;
      const utilization = totalBalance > 0 ? 0 : 100;
      return {
        name: `deepseek_balance_${currency}`,
        utilization,
        resetsAt: null,
        rawBalance: totalBalance,
        currency,
        granted,
        toppedUp,
      } as any;
    });

    return { success: true, level: isAvailable ? '可用' : '不可用', tiers, error: null };
  } catch (e) {
    return { success: false, level: null, tiers: [], error: `网络错误: ${String(e)}` };
  }
}
