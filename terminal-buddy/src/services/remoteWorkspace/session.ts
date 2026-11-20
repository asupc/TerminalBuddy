import type { RemoteWorkspaceState } from './native';
import * as native from './native';
import { configureWorkspaceBackend } from './config';
import { setDockerRuntime, setServerPlatform, setServerUsername } from '../browser/connection';

export type { RemoteWorkspaceState } from './native';

/**
 * 页面启动时确定唯一的业务后端。远程工作区会先校验令牌；
 * 失效时保持本机工作区并抛出 RemoteTokenExpiredError，由入口引导重新登录，
 * 避免进入远程后每个接口都返回 401。
 */
export async function initializeWorkspace(): Promise<RemoteWorkspaceState> {
  const state = await native.getRemoteWorkspaceState();
  if (!state.active || !state.connection) return state;

  let activated: RemoteWorkspaceState;
  try {
    activated = await native.nativeInvoke<RemoteWorkspaceState>('activate_remote_workspace', { id: null });
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : String(reason);
    if (message.includes('REMOTE_TOKEN_EXPIRED')) throw new RemoteTokenExpiredError();
    // 网络暂时不可达时保留远程工作区配置，但先回到本机，避免满屏错误。
    await native.nativeInvoke('set_remote_workspace_active', { active: false }).catch(() => {});
    throw reason;
  }

  // 激活会刷新平台信息（平台、是否 Docker），以激活结果为准。
  const connection = activated.connection ?? state.connection;
  const proxyOrigin = await native.getRemoteWorkspaceProxy();
  configureWorkspaceBackend({ backend: 'remote', proxyOrigin });
  setServerPlatform(connection.platform);
  setDockerRuntime(connection.isDocker);
  setServerUsername(connection.username);
  document.documentElement.dataset.workspace = 'remote';
  document.title = `${connection.name} — TerminalBuddy`;
  return activated;
}

export async function connectRemoteWorkspace(input: {
  name?: string;
  server: string;
  username: string;
  password: string;
}): Promise<RemoteWorkspaceState> {
  return native.connectRemoteWorkspace(input);
}

export async function authenticateRemoteWorkspace(input: {
  username?: string;
  password: string;
  setup?: boolean;
  confirmPassword?: string;
}): Promise<RemoteWorkspaceState> {
  return native.authenticateRemoteWorkspace(input);
}

/** 进入远程前先确认令牌；失效时引导重新登录，而不是进入后满屏 401。 */
export class RemoteTokenExpiredError extends Error {
  constructor() {
    super('远程登录已过期，请重新输入密码');
    this.name = 'RemoteTokenExpiredError';
  }
}

export async function enterRemoteWorkspace(id?: string): Promise<void> {
  try {
    await native.nativeInvoke('activate_remote_workspace', { id: id ?? null });
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : String(reason);
    if (message.includes('REMOTE_TOKEN_EXPIRED')) throw new RemoteTokenExpiredError();
    throw reason;
  }
}

export function returnToLocalWorkspace(): Promise<void> {
  return native.nativeInvoke('set_remote_workspace_active', { active: false });
}

export function disconnectRemoteWorkspace(): Promise<void> {
  return native.disconnectRemoteWorkspace();
}

/** 从列表删除一个已保存的远程连接。 */
export function removeRemoteWorkspaceConnection(id: string): Promise<RemoteWorkspaceState> {
  return native.removeRemoteWorkspaceConnection(id);
}
