import { useStore } from './store';
import type { Profile, TerminalInfo } from './types';

const BASE = '/api';

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
    throw new Error(msg);
  }
  return res.json();
}

export const api = {
  getProfiles: () => req<Profile[]>('/profiles'),
  getTerminals: () => req<TerminalInfo[]>('/terminals'),
  createTerminal: (profileId: string) =>
    req<TerminalInfo>('/terminals', {
      method: 'POST',
      body: JSON.stringify({ profileId, rows: 0, cols: 0 }),
    }),
  deleteTerminal: (id: string) =>
    req<{ closed: boolean }>(`/terminals/${id}`, { method: 'DELETE' }),
};
