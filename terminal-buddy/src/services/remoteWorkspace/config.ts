export type WorkspaceBackend = 'local' | 'remote';

interface WorkspaceConfig {
  backend: WorkspaceBackend;
  proxyOrigin: string;
}

let config: WorkspaceConfig = { backend: 'local', proxyOrigin: '' };

/** 只有桌面壳在页面挂载前能修改后端；浏览器始终使用同源业务接口。 */
export function configureWorkspaceBackend(next: WorkspaceConfig): void {
  config = next;
}

export function workspaceBackend(): WorkspaceBackend {
  return config.backend;
}

export function isRemoteWorkspace(): boolean {
  return config.backend === 'remote';
}

export function remoteProxyOrigin(): string {
  return config.proxyOrigin;
}
