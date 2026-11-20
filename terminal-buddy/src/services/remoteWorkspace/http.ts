import { remoteProxyOrigin } from './config';

/** 远程工作区的最小 HTTP 通道：只依赖工作区配置，不引入任何 Tauri 或浏览器模块。 */
export function remoteRequestUrl(path: string): string {
  const prefix = `/__tb_remote${path.startsWith('/') ? path : `/${path}`}`;
  // 远程服务可能经 HTTPS 反向代理；本机回环代理若也用 HTTPS，证书无法匹配 127.0.0.1。
  // 统一走 HTTP 回环地址，与远程服务之间的加密由 Rust 代理完成。
  return `${remoteProxyOrigin()}${prefix}`;
}

export function remoteSocketUrl(path: string): string {
  const url = new URL(remoteRequestUrl(path));
  url.protocol = 'ws:';
  return url.toString();
}

export async function remoteRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(remoteRequestUrl(path), init);
  if (response.status === 401) {
    window.dispatchEvent(new Event('terminal-buddy-auth-expired'));
    throw new Error('远程登录已过期，请重新登录');
  }
  if (!response.ok) {
    const type = response.headers.get('content-type') ?? '';
    const message = type.includes('application/json')
      ? (await response.json().catch(() => null) as { message?: string } | null)?.message
      : await response.text().catch(() => '');
    throw new Error(message || `远程服务请求失败：${response.status}`);
  }
  return response.json() as Promise<T>;
}
