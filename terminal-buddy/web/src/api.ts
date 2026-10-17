import { useStore } from './store';
import type {
  ClaudeHistoryScanResult,
  ClaudeReplayPage,
  ClaudeSearchHit,
  ClaudeSessionItem,
  ExtraParamMode,
  ExtraParamPreset,
  FileNode,
  GitBranch,
  GitOperationStatus,
  GitRepositoryStatus,
  Profile,
  RuntimeInfo,
  LlmProvider,
  LlmProviderInput,
  LlmLaunchTarget,
  Project,
  TerminalInfo,
} from './types';

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

/** 服务端认证状态（无需登录）：首次部署 setupRequired=true 时走创建管理员流程 */
export interface AuthStatus {
  setupRequired: boolean;
  username: string;
  pageTitle: string;
}

/** 拉取认证状态：登录页用它取用户名（免输入）与自定义标题；失败时静默用默认值 */
export async function getAuthStatus(): Promise<AuthStatus> {
  const res = await fetch(BASE + '/auth/status');
  if (!res.ok) throw new Error('无法读取服务状态');
  const j = (await res.json()) as Partial<AuthStatus>;
  return {
    setupRequired: j.setupRequired === true,
    username: j.username || 'admin',
    pageTitle: j.pageTitle || '',
  };
}

/** 首次创建管理员密码（仅独立服务端/Docker 版提供；桌面版后端恒 false 不会调用） */
export async function setupAdmin(
  password: string,
  confirmPassword: string,
): Promise<{ token: string; username: string }> {
  const res = await fetch(BASE + '/auth/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password, confirmPassword }),
  });
  if (!res.ok) {
    let msg = '创建管理员失败';
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
  extraStartupMode?: ExtraParamMode;
  extraParamTag?: string;
  extraParamTagColor?: string | null;
  /** 自定义标签名（与 PC 端 startTerminal 的 displayName 对齐） */
  displayName?: string;
  /** 覆盖启动目录 */
  startupPath?: string;
  /** 空白终端（profileId 传空串）的归属分组 */
  startupGroup?: string;
  /** 空白终端注入的启动命令（项目启动命令 / claude --resume） */
  startupCommand?: string;
}

// 复用完整界面的鉴权命令入口，增删改操作共用后端校验与持久化。
function invoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
  return req<T>('/desktop/invoke/' + command, { method: 'POST', body: JSON.stringify(args) });
}

export const api = {
  getCommandTemplates: () => invoke<string>('get_command_templates', {}),
  getRuntime: () => req<RuntimeInfo>('/runtime'),
  createProfile: (name: string, group: string, terminalType: string) =>
    invoke<Profile>('create_profile', { name, group, terminalType }),
  updateProfile: (profile: Profile) => invoke<void>('update_profile', { profile }),
  deleteProfile: (id: string) => invoke<void>('delete_profile', { id }),
  saveProjects: (projects: Project[]) => invoke<void>('save_projects', { projects }),
  getLlmLaunchTargets: () => req<LlmLaunchTarget[]>('/llm-providers/launch-targets'),
  getLlmProviders: () => req<LlmProvider[]>('/llm-providers'),
  saveLlmProvider: (input: LlmProviderInput) => req<LlmProvider>(
    '/llm-providers' + (input.id ? '/' + encodeURIComponent(input.id) : ''),
    { method: input.id ? 'PUT' : 'POST', body: JSON.stringify(input) },
  ),
  deleteLlmProvider: (id: string) => req<LlmProvider[]>('/llm-providers/' + encodeURIComponent(id), { method: 'DELETE' }),
  setDefaultLlmProvider: (id: string) => req<LlmProvider[]>('/llm-providers/' + encodeURIComponent(id) + '/set-default', { method: 'POST' }),
  orderLlmProviders: (ids: string[]) => req<LlmProvider[]>('/llm-providers/order', { method: 'PUT', body: JSON.stringify({ ids }) }),
  fetchLlmModels: (input: { providerId?: string; baseUrl: string; apiKey: string; modelsUrl: string }) =>
    req<{ id: string }[]>('/llm-providers/fetch-models', { method: 'POST', body: JSON.stringify(input) }),
  getProfiles: () => req<Profile[]>('/profiles'),
  getProjects: () => req<Project[]>('/projects'),
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
  // ----- Claude 历史会话 -----
  getClaudeHistory: (includeArchived: boolean, projectDir?: string) =>
    req<ClaudeSessionItem[]>(
      `/claude-history?includeArchived=${includeArchived}` +
        (projectDir ? `&projectDir=${encodeURIComponent(projectDir)}` : ''),
    ),
  searchClaudeHistory: (query: string, projectDir?: string) =>
    req<ClaudeSearchHit[]>(
      `/claude-history/search?query=${encodeURIComponent(query)}` +
        (projectDir ? `&projectDir=${encodeURIComponent(projectDir)}` : ''),
    ),
  rescanClaudeHistory: () =>
    req<ClaudeHistoryScanResult>('/claude-history/rescan', { method: 'POST' }),
  getClaudeReplay: (sessionId: string, offset: number, limit: number) =>
    req<ClaudeReplayPage>(
      `/claude-history/${encodeURIComponent(sessionId)}/replay?offset=${offset}&limit=${limit}`,
    ),
  renameClaudeSession: (sessionId: string, title: string) =>
    req<{ renamed: boolean }>(`/claude-history/${encodeURIComponent(sessionId)}/rename`, {
      method: 'POST',
      body: JSON.stringify({ title }),
    }),
  setClaudeSessionFlags: (
    sessionId: string,
    options: { starred?: boolean; archived?: boolean },
  ) =>
    req<{ updated: boolean }>(`/claude-history/${encodeURIComponent(sessionId)}/flags`, {
      method: 'POST',
      body: JSON.stringify({ starred: options.starred ?? null, archived: options.archived ?? null }),
    }),
  deleteClaudeSession: (sessionId: string) =>
    req<{ deleted: boolean }>(`/claude-history/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    }),
  deleteClaudeSessions: (sessionIds: string[]) =>
    req<{ deleted: number }>('/claude-history/delete-batch', {
      method: 'POST',
      body: JSON.stringify({ sessionIds }),
    }),
  // ----- 项目文件树 / Git -----
  getFsList: (path: string) =>
    req<FileNode[]>(`/fs/list?path=${encodeURIComponent(path)}`),
  getGitStatus: (repo: string) =>
    req<GitRepositoryStatus | null>(`/git/status?repo=${encodeURIComponent(repo)}`),
  getGitBranches: (repo: string) =>
    req<GitBranch[]>(`/git/branches?repo=${encodeURIComponent(repo)}`),
  getGitOperation: (repo: string) =>
    req<GitOperationStatus>(`/git/operation?repo=${encodeURIComponent(repo)}`),
  gitCheckout: (repo: string, branch: string) =>
    req<{ started: boolean }>('/git/checkout', {
      method: 'POST',
      body: JSON.stringify({ repo, branch }),
    }),
  gitCommit: (repo: string, message: string) =>
    req<{ started: boolean }>('/git/commit', {
      method: 'POST',
      body: JSON.stringify({ repo, message }),
    }),
  gitPull: (repo: string) =>
    req<{ started: boolean }>('/git/pull', {
      method: 'POST',
      body: JSON.stringify({ repo }),
    }),
  gitPush: (repo: string) =>
    req<{ started: boolean }>('/git/push', {
      method: 'POST',
      body: JSON.stringify({ repo }),
    }),
};

/** 导出会话内容为文本（不走 req()：响应是纯文本不是 JSON），前端生成 Blob 下载 */
export async function exportClaudeSessionContent(
  sessionId: string,
  format: 'markdown' | 'jsonl',
): Promise<string> {
  const token = useStore.getState().token;
  const res = await fetch(
    BASE + `/claude-history/${encodeURIComponent(sessionId)}/export?format=${format}`,
    { headers: token ? { authorization: 'Bearer ' + token } : undefined },
  );
  if (res.status === 401) {
    handle401();
    throw new Error('登录已过期，请重新登录');
  }
  if (!res.ok) {
    let msg = `导出失败 (${res.status})`;
    try {
      const j = await res.json();
      if (j.message) msg = j.message;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return res.text();
}

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
