import { useStore } from './store';
import type { ExtraParamPreset, Profile, TerminalInfo } from './types';

export interface AiDeliveryProject { id: string; name: string; workspaceRoot: string; }
export interface AiDeliveryItem { id: string; projectId: string; title: string; requirement: string; state: string; taskNodeIds: string[]; }
export interface AiDeliveryCreateInput { projectId: string; title: string; requirement: string; }
export interface AiDeliveryTask { id: string; title: string; state: string; targetRepositoryId: string; allowedWritePaths: string[]; }
export interface AiDecision { id: string; question: string; impact: string; state: string; answer?: string | null; options: { label: string; description: string }[]; }
export interface AiDeliverySnapshot { delivery: AiDeliveryItem; tasks: AiDeliveryTask[]; decisions: AiDecision[]; events: { id: string; eventType: string; message: string; occurredAt: string }[]; }

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

export interface CreateTerminalOptions {
  extraStartupParams?: string;
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
  getAiDeliveryProjects: () => req<AiDeliveryProject[]>('/ai-delivery/projects'),
  getAiDeliveries: (projectId: string) => req<AiDeliveryItem[]>(`/ai-delivery/projects/${projectId}/deliveries`),
  getAiDeliverySnapshot: (id: string) => req<AiDeliverySnapshot>(`/ai-delivery/deliveries/${id}`),
  approveAiDelivery: (id: string) => req<AiDeliveryItem>(`/ai-delivery/deliveries/${id}/approve`, { method: 'POST', body: '{}' }),
  answerAiDecision: (id: string, answer: string) => req<AiDecision>(`/ai-delivery/decisions/${id}/answer`, { method: 'POST', body: JSON.stringify({ answer }) }),
  createAiDelivery: (input: AiDeliveryCreateInput) =>
    req<AiDeliveryItem>('/ai-delivery/deliveries', { method: 'POST', body: JSON.stringify(input) }),
  planAiDelivery: (deliveryId: string) =>
    req<AiDeliveryItem>(`/ai-delivery/deliveries/${deliveryId}/plan`, { method: 'POST', body: '{}' }),
  dispatchAiDelivery: (deliveryId: string) =>
    req<AiDeliveryItem>(`/ai-delivery/deliveries/${deliveryId}/dispatch`, { method: 'POST', body: '{}' }),
  completeAiDeliveryAttempt: (deliveryId: string) =>
    req<AiDeliveryItem>(`/ai-delivery/deliveries/${deliveryId}/complete`, { method: 'POST', body: '{}' }),
  mergeAiDelivery: (deliveryId: string) =>
    req<AiDeliveryItem>(`/ai-delivery/deliveries/${deliveryId}/merge`, { method: 'POST', body: '{}' }),
  cleanupIntegration: (deliveryId: string) =>
    req<AiDeliveryItem>(`/ai-delivery/deliveries/${deliveryId}/cleanup-integration`, { method: 'POST', body: '{}' }),
  retryAiDeliveryTask: (deliveryId: string, taskNodeId?: string) =>
    req<AiDeliveryItem>(`/ai-delivery/deliveries/${deliveryId}/retry`, {
      method: 'POST',
      body: JSON.stringify(taskNodeId ? { taskNodeId } : {}),
    }),
};
