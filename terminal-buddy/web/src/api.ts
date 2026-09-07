import { useStore } from './store';
import type { ExtraParamMode, ExtraParamPreset, Profile, TerminalInfo } from './types';

const BASE = '/api';

/** 解析 JWT payload 的 exp（秒）。token 缺失或格式异常时返回 null。 */
export function tokenExpiresAt(token: string | null): number | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

/** token 已过期（本地 exp 判断）。连接前检查可避免拿死 token 做无意义重试。 */
export function isTokenExpired(token: string | null): boolean {
  const exp = tokenExpiresAt(token);
  // 提前 30 秒视为过期，容忍客户端与服务端的少量时钟偏差
  return exp !== null && exp <= Date.now() / 1000 + 30;
}

// 防止 401 风暴：多个并发请求同时 401 时只登出一次
let loggingOut = false;
function handle401() {
  if (loggingOut) return;
  loggingOut = true;
  useStore.getState().logout();
  setTimeout(() => {
    loggingOut = false;
  }, 1000);
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const token = useStore.getState().token;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...((init?.headers as Record<string, string>) || {}),
  };
  if (token) headers.authorization = 'Bearer ' + token;
  const res = await fetch(BASE + path, { ...init, headers });
  if (res.status === 401) {
    handle401();
    throw new Error('登录已过期，请重新登录');
  }
  if (!res.ok) {
    let msg = `请求失败 (${res.status})`;
    try {
      const j = await res.json();
      if (j.message) msg = j.message;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

/** 登录走独立路径：401 不触发自动登出（此时还没登录） */
export async function login(
  username: string,
  password: string,
): Promise<{ token: string; username: string }> {
  const res = await fetch(BASE + '/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    let msg = '用户名或密码错误';
    try {
      const j = await res.json();
      if (j.message) msg = j.message;
    } catch {
      /* ignore */
    }
    // 后端对 401/429 都返回带 message 的 JSON：401 是凭据错误，429 是限流
    // （失败过多/服务器忙，带 Retry-After），各自文案都可直接展示
    throw new Error(msg);
  }
  return res.json();
}

export interface CreateTerminalOptions {
  extraStartupParams?: string;
  extraStartupMode?: ExtraParamMode;
  extraParamTag?: string;
  extraParamTagColor?: string | null;
}

export const api = {
  getProfiles: () => req<Profile[]>('/profiles'),
  getTerminals: () => req<TerminalInfo[]>('/terminals'),
  createTerminal: (profileId: string, options?: CreateTerminalOptions) =>
    req<TerminalInfo>('/terminals', {
      method: 'POST',
      body: JSON.stringify({ profileId, rows: 0, cols: 0, ...options }),
    }),
  deleteTerminal: (id: string) =>
    req<{ closed: boolean }>(`/terminals/${id}`, { method: 'DELETE' }),
  getExtraParamPresets: () => req<ExtraParamPreset[]>('/extra-param-presets'),
  replaceExtraParamPresets: (presets: ExtraParamPreset[]) =>
    req<ExtraParamPreset[]>('/extra-param-presets', {
      method: 'PUT',
      body: JSON.stringify(presets),
    }),
};

/**
 * 受控 REST 探测：WS 握手失败后区分「未授权」（服务在，token 坏）与「暂时离线」
 * （服务不可达）。返回 'unauthorized' | 'online' | 'offline'。
 * 探测只发一次且不触发 401 自动登出，供重连策略决定走向。
 */
export async function probeAuth(): Promise<'unauthorized' | 'online' | 'offline'> {
  const token = useStore.getState().token;
  try {
    const res = await fetch(BASE + '/auth/status', {
      headers: token ? { authorization: 'Bearer ' + token } : undefined,
    });
    if (res.status === 401) return 'unauthorized';
    return 'online';
  } catch {
    return 'offline';
  }
}
