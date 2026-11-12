import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ClipboardCopy,
  ExternalLink,
  File,
  FileCode2,
  FileImage,
  FileText,
  Folder,
  FolderOpen,
  Loader2,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import { ConfirmDialog, Dialog } from '../shared/Dialog';
import { deletePath, listDirectory, openInExplorer, openPath, renamePath, type FileNode } from '../../services/tauri';
import { canDownloadToBrowser, downloadToBrowser } from '../../services/fileDownload';
import { supportsSystemExplorerOpen } from '../../services/platform';
import { openTerminalInDir } from '../../utils/openTerminalInDir';
import { fitContextMenuToViewport } from '../../utils/contextMenu';
import { normalizeConfiguredPath } from './file-utils';
import { useAppStore } from '../../stores/appStore';
import './FileManagerDialog.css';

type SortBy = 'name' | 'modified' | 'size' | 'type';
type SortDir = 'asc' | 'desc';

/** 导航历史上限，避免长时间浏览后无限增长。 */
const HISTORY_LIMIT = 100;

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg', 'avif']);
const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'jsonc', 'html', 'htm', 'css', 'scss', 'less',
  'rs', 'py', 'go', 'java', 'kt', 'kts', 'c', 'cc', 'cpp', 'h', 'hpp', 'cs', 'rb', 'php', 'swift',
  'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd', 'sql', 'yaml', 'yml', 'toml', 'xml', 'vue', 'svelte',
]);
const TEXT_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'log', 'ini', 'conf', 'env', 'gitignore', 'lock']);

function extensionOf(name: string): string {
  const index = name.lastIndexOf('.');
  if (index <= 0 || index === name.length - 1) return '';
  return name.slice(index + 1).toLowerCase();
}

function fileIcon(node: FileNode) {
  if (node.is_directory) return Folder;
  const extension = extensionOf(node.name);
  if (IMAGE_EXTENSIONS.has(extension)) return FileImage;
  if (CODE_EXTENSIONS.has(extension)) return FileCode2;
  if (TEXT_EXTENSIONS.has(extension)) return FileText;
  return File;
}

function typeLabel(node: FileNode): string {
  if (node.is_directory) return '文件夹';
  const extension = extensionOf(node.name);
  return extension ? `${extension.toUpperCase()} 文件` : '文件';
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${index === 0 || value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function formatModified(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 取上一个目录；已经是文件系统根（POSIX `/`、Windows 盘符根、UNC 共享根）时返回 null。
 * 状态栏里的会话目录就是本地路径，规则与 FileNav 的父目录计算保持一致。
 */
export function parentDirectoryOf(path: string): string | null {
  const normalized = normalizeConfiguredPath(path);
  if (!normalized) return null;
  if (normalized.includes('\\')) {
    if (/^[a-zA-Z]:\\?$/.test(normalized)) return null;
    if (/^\\\\[^\\]+\\[^\\]+\\?$/.test(normalized)) return null;
    const separator = normalized.lastIndexOf('\\');
    if (separator <= 0) return null;
    if (separator === 2 && /^[a-zA-Z]:\\/.test(normalized)) return normalized.slice(0, 3);
    return normalized.slice(0, separator);
  }
  if (normalized === '/') return null;
  const separator = normalized.lastIndexOf('/');
  if (separator <= 0) return '/';
  return normalized.slice(0, separator);
}

function compareEntries(a: FileNode, b: FileNode, sortBy: SortBy, sortDir: SortDir): number {
  // 与资源管理器一致：文件夹永远排在文件前面，升降序只作用于同一类。
  if (a.is_directory !== b.is_directory) return a.is_directory ? -1 : 1;
  const direction = sortDir === 'asc' ? 1 : -1;
  if (sortBy === 'modified') {
    if (a.lastModified !== b.lastModified) return (a.lastModified - b.lastModified) * direction;
  } else if (sortBy === 'size') {
    const sizeA = a.is_directory ? 0 : a.size;
    const sizeB = b.is_directory ? 0 : b.size;
    if (sizeA !== sizeB) return (sizeA - sizeB) * direction;
  } else if (sortBy === 'type') {
    const typeA = a.is_directory ? '' : extensionOf(a.name);
    const typeB = b.is_directory ? '' : extensionOf(b.name);
    const result = typeA.localeCompare(typeB, 'zh-CN');
    if (result !== 0) return result * direction;
  }
  return a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' }) * direction;
}

export interface FileManagerDialogProps {
  open: boolean;
  initialPath: string;
  onClose: () => void;
}

/**
 * 应用内文件管理器：独立弹窗、地址栏 + 前进/后退/上级、列表视图，行为对齐 Windows 资源管理器。
 * 目录数据复用 listDirectory（桌面端 IPC / 浏览器端 REST），因此网页端也能浏览服务器目录。
 */
export function FileManagerDialog({ open, initialPath, onClose }: FileManagerDialogProps) {
  const [nav, setNav] = useState<{ stack: string[]; index: number }>({ stack: [], index: -1 });
  const [entries, setEntries] = useState<FileNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addressDraft, setAddressDraft] = useState('');
  const [filterQuery, setFilterQuery] = useState('');
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<SortBy>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; node: FileNode | null } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<FileNode | null>(null);
  const [renaming, setRenaming] = useState<{ node: FileNode; value: string } | null>(null);

  const loadTokenRef = useRef(0);
  const wasOpenRef = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const ctxMenuRef = useRef<HTMLDivElement>(null);
  const showToast = useAppStore(s => s.showToast);

  const currentPath = nav.stack[nav.index] ?? '';
  const parentPath = useMemo(() => (currentPath ? parentDirectoryOf(currentPath) : null), [currentPath]);

  const loadDirectory = useCallback(async (target: string) => {
    // 快速连续导航时只认最后一次请求，避免慢请求覆盖新目录。
    const token = ++loadTokenRef.current;
    setLoading(true);
    setError(null);
    try {
      const list = await listDirectory(target, []);
      if (token !== loadTokenRef.current) return;
      setEntries(list);
    } catch (err) {
      if (token !== loadTokenRef.current) return;
      setEntries([]);
      const message = err instanceof Error ? err.message : String(err);
      setError(message || '无法读取该目录');
    } finally {
      if (token === loadTokenRef.current) setLoading(false);
    }
  }, []);

  // 只在弹窗由关闭切到打开时按当前会话目录重置，浏览过程中的其余状态变化不打扰已打开的窗口。
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      wasOpenRef.current = true;
      const start = normalizeConfiguredPath(initialPath) || initialPath;
      setNav({ stack: [start], index: 0 });
      setAddressDraft(start);
      setFilterQuery('');
      setSelectedPath(null);
      setError(null);
      setEntries([]);
      void loadDirectory(start);
      // 终端可能在弹窗挂载后立刻抢回焦点，延迟再聚焦一次，保证方向键/回车可用。
      const frame = requestAnimationFrame(() => listRef.current?.focus());
      const timer = window.setTimeout(() => listRef.current?.focus(), 250);
      return () => {
        cancelAnimationFrame(frame);
        window.clearTimeout(timer);
      };
    }
    if (!open) wasOpenRef.current = false;
  }, [open, initialPath, loadDirectory]);

  const goTo = useCallback((target: string) => {
    setSelectedPath(null);
    setFilterQuery('');
    setAddressDraft(target);
    void loadDirectory(target);
  }, [loadDirectory]);

  const navigate = useCallback((target: string) => {
    const next = normalizeConfiguredPath(target) || target.trim();
    if (!next) return;
    setNav(prev => {
      const stack = prev.stack.slice(0, prev.index + 1);
      if (stack[stack.length - 1] === next) return prev;
      stack.push(next);
      if (stack.length > HISTORY_LIMIT) stack.shift();
      return { stack, index: stack.length - 1 };
    });
    goTo(next);
  }, [goTo]);

  const goBack = useCallback(() => {
    if (nav.index <= 0) return;
    const target = nav.stack[nav.index - 1];
    setNav({ stack: nav.stack, index: nav.index - 1 });
    goTo(target);
  }, [nav, goTo]);

  const goForward = useCallback(() => {
    if (nav.index >= nav.stack.length - 1) return;
    const target = nav.stack[nav.index + 1];
    setNav({ stack: nav.stack, index: nav.index + 1 });
    goTo(target);
  }, [nav, goTo]);

  const goUp = useCallback(() => {
    if (parentPath) navigate(parentPath);
  }, [parentPath, navigate]);

  const refresh = useCallback(() => {
    if (currentPath) void loadDirectory(currentPath);
  }, [currentPath, loadDirectory]);

  const copyPathToClipboard = useCallback(async (path: string, label = '已复制路径') => {
    try {
      await navigator.clipboard.writeText(path);
      showToast(label, 'success');
    } catch {
      showToast(`路径：${path}`, 'info');
    }
  }, [showToast]);

  const copyPath = useCallback(() => copyPathToClipboard(currentPath), [copyPathToClipboard, currentPath]);

  const revealPath = useCallback(async (path: string) => {
    setCtxMenu(null);
    try {
      await openInExplorer(path);
    } catch (err) {
      showToast(`无法打开系统文件管理器：${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }, [showToast]);

  const revealInExplorer = useCallback(() => { void revealPath(currentPath); }, [currentPath, revealPath]);

  const activate = useCallback(async (node: FileNode) => {
    if (node.is_directory) {
      navigate(node.path);
      return;
    }
    try {
      await openPath(node.path);
    } catch (err) {
      showToast(`无法打开文件：${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }, [navigate, showToast]);

  const openNode = useCallback((node: FileNode) => {
    setCtxMenu(null);
    void activate(node);
  }, [activate]);

  const openTerminalAt = useCallback(async (dir: string) => {
    setCtxMenu(null);
    try {
      await openTerminalInDir(dir);
    } catch (err) {
      showToast(`无法打开终端：${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }, [showToast]);

  const startRename = useCallback((node: FileNode) => {
    setCtxMenu(null);
    setRenaming({ node, value: node.name });
  }, []);

  const submitRename = useCallback(async () => {
    if (!renaming) return;
    const name = renaming.value.trim();
    if (!name || name === renaming.node.name) {
      setRenaming(null);
      return;
    }
    try {
      await renamePath(renaming.node.path, name);
      const separator = currentPath.includes('\\') ? '\\' : '/';
      const base = /[\\/]$/.test(currentPath) ? currentPath : `${currentPath}${separator}`;
      setRenaming(null);
      refresh();
      setSelectedPath(`${base}${name}`);
    } catch (err) {
      showToast(`重命名失败：${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }, [currentPath, refresh, renaming, showToast]);

  const confirmDeleteNode = useCallback(async () => {
    if (!confirmDelete) return;
    const target = confirmDelete;
    setConfirmDelete(null);
    try {
      await deletePath(target.path);
      setSelectedPath(current => current === target.path ? null : current);
      refresh();
    } catch (err) {
      showToast(`删除失败：${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }, [confirmDelete, refresh, showToast]);

  // 菜单通过 portal 挂到 body：弹窗内部的 transform 会让 fixed 元素相对弹窗定位。
  useLayoutEffect(() => {
    if (!ctxMenu) return;
    const menu = ctxMenuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    const next = fitContextMenuToViewport(ctxMenu.x, ctxMenu.y, rect.width, rect.height);
    if (next.x !== ctxMenu.x || next.y !== ctxMenu.y) {
      setCtxMenu(current => (current ? { ...current, ...next } : current));
    }
  }, [ctxMenu]);

  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    document.addEventListener('click', close);
    document.addEventListener('wheel', close);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('wheel', close);
      window.removeEventListener('resize', close);
    };
  }, [ctxMenu]);

  const visibleEntries = useMemo(() => {
    const keyword = filterQuery.trim().toLowerCase();
    const filtered = keyword
      ? entries.filter(entry => entry.name.toLowerCase().includes(keyword))
      : entries;
    return [...filtered].sort((a, b) => compareEntries(a, b, sortBy, sortDir));
  }, [entries, filterQuery, sortBy, sortDir]);

  const selectedEntry = selectedPath
    ? visibleEntries.find(entry => entry.path === selectedPath) ?? null
    : null;
  const ctxMenuNode = ctxMenu?.node ?? null;

  const toggleSort = useCallback((next: SortBy) => {
    if (next === sortBy) {
      setSortDir(direction => (direction === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setSortBy(next);
    setSortDir('asc');
  }, [sortBy]);

  const selectAndReveal = useCallback((path: string | null) => {
    setSelectedPath(path);
    if (!path) return;
    requestAnimationFrame(() => {
      const selector = `[data-file-path="${path.replace(/["\\]/g, '\\$&')}"]`;
      listRef.current?.querySelector<HTMLElement>(selector)?.scrollIntoView({ block: 'nearest' });
    });
  }, []);

  const handleListKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (selectedEntry) void activate(selectedEntry);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (visibleEntries.length === 0) return;
      event.preventDefault();
      const currentIndex = visibleEntries.findIndex(entry => entry.path === selectedPath);
      const nextIndex = event.key === 'ArrowDown'
        ? Math.min(currentIndex + 1, visibleEntries.length - 1)
        : Math.max(currentIndex - 1, 0);
      selectAndReveal(visibleEntries[nextIndex]?.path ?? null);
      return;
    }
    if (event.key === 'F5') {
      event.preventDefault();
      refresh();
      return;
    }
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'Backspace')) {
      event.preventDefault();
      goUp();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l') {
      event.preventDefault();
      addressRef.current?.focus();
      addressRef.current?.select();
    }
  }, [activate, goUp, refresh, selectAndReveal, selectedEntry, selectedPath, visibleEntries]);

  const sortIndicator = (column: SortBy) => (sortBy === column ? (sortDir === 'asc' ? '↑' : '↓') : '');

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="文件管理"
      className="file-manager-dialog"
      bodyClassName="file-manager-dialog-body"
      autoFocus={false}
      closeLabel="关闭文件管理"
      resizable
    >
      <div className="file-manager">
        <div className="file-manager-toolbar">
          <button type="button" className="file-manager-tool" onClick={goBack} disabled={nav.index <= 0} title="后退">
            <ArrowLeft aria-hidden="true" />
          </button>
          <button type="button" className="file-manager-tool" onClick={goForward} disabled={nav.index >= nav.stack.length - 1} title="前进">
            <ArrowRight aria-hidden="true" />
          </button>
          <button type="button" className="file-manager-tool" onClick={goUp} disabled={!parentPath} title="上一级">
            <ArrowUp aria-hidden="true" />
          </button>
          <button type="button" className="file-manager-tool" onClick={refresh} title="刷新（F5）">
            <RefreshCw aria-hidden="true" />
          </button>
          <div className="file-manager-address">
            <FolderOpen className="file-manager-address-icon" aria-hidden="true" />
            <input
              ref={addressRef}
              className="file-manager-address-input"
              value={addressDraft}
              onChange={event => setAddressDraft(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  navigate(addressDraft);
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  setAddressDraft(currentPath);
                  listRef.current?.focus();
                }
              }}
              placeholder="输入路径后回车跳转"
              spellCheck={false}
              aria-label="当前路径"
            />
            <button type="button" className="file-manager-address-action" onClick={() => void copyPath()} title="复制当前路径">
              <ClipboardCopy aria-hidden="true" />
            </button>
          </div>
        </div>

        <div className="file-manager-toolbar file-manager-toolbar-secondary">
          <label className="file-manager-search">
            <Search className="file-manager-search-icon" aria-hidden="true" />
            <input
              value={filterQuery}
              onChange={event => setFilterQuery(event.target.value)}
              placeholder="搜索当前文件夹"
              spellCheck={false}
              aria-label="搜索当前文件夹"
            />
            {filterQuery && (
              <button type="button" className="file-manager-search-clear" onClick={() => setFilterQuery('')} title="清空搜索">
                <X aria-hidden="true" />
              </button>
            )}
          </label>
          {supportsSystemExplorerOpen() && (
            <button type="button" className="file-manager-text-button" onClick={() => void revealInExplorer()} title="在系统文件管理器中打开">
              <ExternalLink aria-hidden="true" />
              <span>在资源管理器中打开</span>
            </button>
          )}
        </div>

        <div className="file-manager-columns" role="presentation">
          <button type="button" className="file-manager-column file-manager-column-name" onClick={() => toggleSort('name')}>
            名称<span className="file-manager-sort">{sortIndicator('name')}</span>
          </button>
          <button type="button" className="file-manager-column file-manager-column-modified" onClick={() => toggleSort('modified')}>
            修改时间<span className="file-manager-sort">{sortIndicator('modified')}</span>
          </button>
          <button type="button" className="file-manager-column file-manager-column-type" onClick={() => toggleSort('type')}>
            类型<span className="file-manager-sort">{sortIndicator('type')}</span>
          </button>
          <button type="button" className="file-manager-column file-manager-column-size" onClick={() => toggleSort('size')}>
            大小<span className="file-manager-sort">{sortIndicator('size')}</span>
          </button>
        </div>

        <div
          ref={listRef}
          className="file-manager-list"
          tabIndex={0}
          role="listbox"
          aria-label="文件列表"
          onKeyDown={handleListKeyDown}
          onContextMenu={event => {
            event.preventDefault();
            const row = (event.target as HTMLElement).closest<HTMLElement>('[data-file-path]');
            const path = row?.dataset.filePath;
            const node = path ? visibleEntries.find(entry => entry.path === path) ?? null : null;
            if (node) selectAndReveal(node.path);
            else setSelectedPath(null);
            setCtxMenu({ x: event.clientX, y: event.clientY, node });
          }}
        >
          {loading && entries.length === 0 ? (
            <div className="file-manager-state">
              <Loader2 className="file-manager-spinner" aria-hidden="true" />
              <span>正在读取…</span>
            </div>
          ) : error ? (
            <div className="file-manager-state file-manager-state-error">{error}</div>
          ) : visibleEntries.length === 0 ? (
            <div className="file-manager-state">
              {filterQuery.trim() ? '没有匹配的文件' : '此文件夹为空'}
            </div>
          ) : (
            visibleEntries.map(node => {
              const Icon = fileIcon(node);
              return (
                <div
                  key={node.path}
                  role="option"
                  aria-selected={node.path === selectedPath}
                  data-file-path={node.path}
                  className={`file-manager-row${node.path === selectedPath ? ' selected' : ''}`}
                  onClick={() => {
                    setSelectedPath(node.path);
                    // 点击行后把焦点留在列表，键盘上下键 / 回车才能继续操作。
                    listRef.current?.focus();
                  }}
                  onDoubleClick={() => void activate(node)}
                >
                  <span className="file-manager-name">
                    <Icon
                      className={`file-manager-file-icon${node.is_directory ? ' folder' : ''}`}
                      aria-hidden="true"
                    />
                    <span className="file-manager-name-text" title={node.name}>{node.name}</span>
                  </span>
                  <span className="file-manager-cell file-manager-column-modified">{formatModified(node.lastModified)}</span>
                  <span className="file-manager-cell file-manager-column-type">{typeLabel(node)}</span>
                  <span className="file-manager-cell file-manager-column-size">
                    {node.is_directory ? '—' : formatSize(node.size)}
                  </span>
                </div>
              );
            })
          )}
        </div>

        <div className="file-manager-footer">
          <span>{visibleEntries.length} 个项目</span>
          {selectedEntry && (
            <span className="file-manager-footer-selected" title={selectedEntry.name}>
              {selectedEntry.name}
            </span>
          )}
          <span className="file-manager-footer-hint">双击打开 · Alt+↑ 上一级 · Ctrl+L 定位路径</span>
        </div>
      </div>

      {ctxMenu && createPortal(
        <div
          ref={ctxMenuRef}
          className="context-menu file-manager-context-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y, zIndex: 11000 }}
          onContextMenu={event => event.preventDefault()}
        >
          {ctxMenuNode ? (
            <>
              <div className="context-menu-item" onClick={() => openNode(ctxMenuNode)}>打开</div>
              {ctxMenuNode.is_directory && (
                <div className="context-menu-item" onClick={() => void openTerminalAt(ctxMenuNode.path)}>
                  在当前目录打开命令窗口
                </div>
              )}
              {supportsSystemExplorerOpen() && (
                <div className="context-menu-item" onClick={() => void revealPath(ctxMenuNode.path)}>
                  在文件资源管理器中显示
                </div>
              )}
              {canDownloadToBrowser() && (
                <div
                  className="context-menu-item"
                  onClick={() => { setCtxMenu(null); downloadToBrowser(ctxMenuNode.path); }}
                >
                  {ctxMenuNode.is_directory ? '下载文件夹（ZIP）' : '下载'}
                </div>
              )}
              <div className="context-menu-separator" />
              <div className="context-menu-item" onClick={() => void copyPathToClipboard(ctxMenuNode.path)}>
                复制路径
              </div>
              <div className="context-menu-item" onClick={() => startRename(ctxMenuNode)}>重命名</div>
              <div
                className="context-menu-item danger"
                onClick={() => { setConfirmDelete(ctxMenuNode); setCtxMenu(null); }}
              >
                删除
              </div>
            </>
          ) : (
            <>
              <div className="context-menu-item" onClick={() => { setCtxMenu(null); refresh(); }}>刷新</div>
              <div className="context-menu-separator" />
              <div className="context-menu-item" onClick={() => void openTerminalAt(currentPath)}>
                在当前目录打开命令窗口
              </div>
              {supportsSystemExplorerOpen() && (
                <div className="context-menu-item" onClick={() => void revealPath(currentPath)}>
                  在文件资源管理器中显示
                </div>
              )}
              {canDownloadToBrowser() && (
                <div
                  className="context-menu-item"
                  onClick={() => { setCtxMenu(null); downloadToBrowser(currentPath); }}
                >
                  下载文件夹（ZIP）
                </div>
              )}
              <div className="context-menu-item" onClick={() => void copyPathToClipboard(currentPath, '已复制当前路径')}>
                复制当前路径
              </div>
            </>
          )}
        </div>,
        document.body,
      )}

      {confirmDelete && (
        <ConfirmDialog
          title="确认删除"
          message={`确定删除 "${confirmDelete.path}" 吗？此操作不可撤销。`}
          onClose={() => setConfirmDelete(null)}
          onConfirm={() => void confirmDeleteNode()}
        />
      )}

      {renaming && (
        <Dialog
          title="重命名"
          onClose={() => setRenaming(null)}
          className="file-manager-rename-dialog"
          autoFocus={false}
          onSubmit={event => {
            event.preventDefault();
            void submitRename();
          }}
          footer={(
            <>
              <button type="button" className="btn-secondary" onClick={() => setRenaming(null)}>取消</button>
              <button
                type="submit"
                className="btn-primary"
                disabled={!renaming.value.trim() || renaming.value.trim() === renaming.node.name}
              >
                确定
              </button>
            </>
          )}
        >
          <label className="file-manager-rename-label">
            <span>新名称</span>
            <input
              autoFocus
              value={renaming.value}
              onChange={event => setRenaming(current => (current ? { ...current, value: event.target.value } : current))}
              onFocus={event => event.currentTarget.select()}
              spellCheck={false}
            />
          </label>
          <div className="file-manager-rename-target" title={renaming.node.path}>{renaming.node.path}</div>
        </Dialog>
      )}
    </Dialog>
  );
}
