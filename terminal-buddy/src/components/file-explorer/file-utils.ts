import type { FileNode } from '../../services/tauri';

export const DIRECTORY_RENDER_PAGE_SIZE = 200;

export function scrollFileTreeItemToTop(item: HTMLElement | null): void {
  if (!item) return;

  requestAnimationFrame(() => {
    if (!item.isConnected) return;
    const scrollContainer = item.closest('.file-nav-content') as HTMLElement | null;
    if (!scrollContainer) return;

    const containerRect = scrollContainer.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    const paddingTop = Number.parseFloat(window.getComputedStyle(scrollContainer).paddingTop) || 0;
    const top = scrollContainer.scrollTop + itemRect.top - containerRect.top - paddingTop;
    const behavior: ScrollBehavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ? 'auto'
      : 'smooth';

    scrollContainer.scrollTo({ top: Math.max(0, top), behavior });
  });
}

export function sortLabel(by: 'name' | 'size' | 'modified'): string {
  if (by === 'size') return '大小';
  if (by === 'modified') return '修改';
  return '名称';
}

export function compareNodes(a: FileNode, b: FileNode, sortBy: 'name' | 'size' | 'modified', sortDir: 'asc' | 'desc'): number {
  if (a.is_directory !== b.is_directory) return a.is_directory ? -1 : 1;
  const dir = sortDir === 'asc' ? 1 : -1;
  if (sortBy === 'size') {
    if (a.size !== b.size) return (a.size - b.size) * dir;
    return a.name.localeCompare(b.name);
  }
  if (sortBy === 'modified') {
    if (a.lastModified !== b.lastModified) return (a.lastModified - b.lastModified) * dir;
    return a.name.localeCompare(b.name);
  }
  return a.name.localeCompare(b.name) * dir;
}

export function directoryName(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '');
  if (!normalized) return path;
  return normalized.split(/[\\/]/).filter(Boolean).pop() || normalized;
}

export function normalizeConfiguredPath(path: string): string {
  const slashNormalized = path.trim().replace(/\//g, '\\');
  if (slashNormalized.startsWith('\\\\?\\')) {
    const extendedBody = slashNormalized.slice(4).replace(/\\+/g, '\\');
    if (/^[a-zA-Z]:\\$/.test(extendedBody)) return `\\\\?\\${extendedBody}`;
    return `\\\\?\\${extendedBody.replace(/\\+$/, '')}`;
  }
  const isUnc = /^\\{2,}/.test(slashNormalized);
  const body = isUnc ? slashNormalized.replace(/^\\+/, '') : slashNormalized;
  const normalized = (isUnc ? '\\\\' : '') + body.replace(/\\+/g, '\\');
  if (/^[a-zA-Z]:\\$/.test(normalized)) {
    return `${normalized.slice(0, 2)}\\`;
  }
  return normalized.replace(/\\+$/, '');
}

export function isPathEqualOrInside(path: string, root: string): boolean {
  const normalizedPath = normalizeConfiguredPath(path).toLowerCase();
  const normalizedRoot = normalizeConfiguredPath(root).toLowerCase();
  if (!normalizedPath || !normalizedRoot) return false;
  if (normalizedPath === normalizedRoot) return true;
  const prefix = normalizedRoot.endsWith('\\') ? normalizedRoot : `${normalizedRoot}\\`;
  return normalizedPath.startsWith(prefix);
}

export function replacePathPrefix(path: string, oldPrefix: string, newPrefix: string): string {
  const normalizedPath = normalizeConfiguredPath(path);
  const normalizedOldPrefix = normalizeConfiguredPath(oldPrefix);
  if (!isPathEqualOrInside(normalizedPath, normalizedOldPrefix)) return path;
  return `${normalizeConfiguredPath(newPrefix)}${normalizedPath.slice(normalizedOldPrefix.length)}`;
}

