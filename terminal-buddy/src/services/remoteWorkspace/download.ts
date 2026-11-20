import { remoteRequestUrl } from './http';

/** 普通浏览器：直接打开同源下载地址，由浏览器接管保存。 */
export function openRemoteDownloadInBrowser(path: string): void {
  const link = document.createElement('a');
  link.href = remoteRequestUrl(`/api/desktop/download?${new URLSearchParams({ path })}`);
  link.download = '';
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/** 桌面远程工作区：弹出 Windows 保存对话框，经本机代理流式写盘（目录由服务端打包 ZIP）。 */
export async function downloadRemoteFileToLocal(path: string): Promise<void> {
  const [{ save }, { downloadRemoteWorkspaceFile }] = await Promise.all([
    import('@tauri-apps/plugin-dialog'),
    import('./native'),
  ]);
  const name = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '下载文件';
  const destination = await save({ defaultPath: name, title: '保存远程文件到本机' });
  if (!destination) return;
  await downloadRemoteWorkspaceFile(path, destination);
}
