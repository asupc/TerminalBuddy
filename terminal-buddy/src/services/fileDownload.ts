import { getToken } from './browser/connection';
import { isBrowserClient, isRemoteWorkspace } from './platform';

/**
 * 是否需要通过浏览器把服务器文件下载到本机。
 * 只有浏览器端（Linux 服务端 / Docker 部署）需要；桌面端文件本来就在本机磁盘上。
 */
export function canDownloadToBrowser(): boolean {
  return isBrowserClient() || isRemoteWorkspace();
}

/**
 * 触发浏览器下载服务器上的文件或目录。
 * 服务端 `/api/desktop/download` 以 Content-Disposition: attachment 响应；
 * 目录会先由服务端打包成 ZIP。下载动作由浏览器接管，不占用页面内存。
 */
export function downloadToBrowser(path: string): void {
  if (isRemoteWorkspace()) {
    // 桌面远程：原生保存对话框 + 代理流式写盘；普通浏览器继续走下面的同源下载。
    void import('./remoteWorkspace/download')
      .then(({ downloadRemoteFileToLocal }) => downloadRemoteFileToLocal(path))
      .catch(error => console.error('下载远程文件失败:', error));
    return;
  }
  const token = getToken();
  if (!token) {
    console.error('下载失败：登录状态已失效');
    return;
  }
  const link = document.createElement('a');
  link.href = `/api/desktop/download?${new URLSearchParams({ path, token })}`;
  // 空 download 表示沿用响应头里的文件名（目录为 `<名称>.zip`）。
  link.download = '';
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
}
