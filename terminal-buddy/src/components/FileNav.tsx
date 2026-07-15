import { FC, useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo } from 'react';
import { ArrowDown, ArrowUp, ChevronRight, File, Folder, FolderOpen, ListChevronsDownUp, RefreshCw, X } from 'lucide-react';
import { listDirectory, openPath, openInExplorer, deletePath, renamePath, getFileSize, saveFileNavWidth, getBackendAppSettings, type FileNode } from '../services/tauri';
import { useAppStore } from '../stores/appStore';
import { isTextFile } from '../utils/fileExtensions';
import { getAppSettings } from '../utils/settings';
import { openTerminalInDir } from '../utils/openTerminalInDir';
import { fitContextMenuToViewport } from '../utils/contextMenu';
import { GitNavBar } from './GitNavBar';
import { RemoteFileTree } from './RemoteFileTree';
import './FileNav.css';

interface TreeNodeProps {
  node: FileNode;
  depth: number;
  parentPath: string;
  selectedPath: string | null;
  onActivate: (path: string) => void;
  onSelect: (path: string) => void;
  onNavigate: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, path: string, isDir: boolean) => void;
  onRename: (path: string, newName: string) => Promise<void>;
  renamingPath: string | null;
  setRenamingPath: (path: string | null) => void;
}

function scrollFileTreeItemToTop(item: HTMLElement | null): void {
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

const TreeNode: FC<TreeNodeProps> = ({ node, depth, parentPath, selectedPath, onActivate, onSelect, onNavigate, onContextMenu, onRename, renamingPath, setRenamingPath }) => {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FileNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const itemRef = useRef<HTMLDivElement>(null);
  const pinToTopAfterLoadRef = useRef(false);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const exclusionPatterns = useAppStore(s => s.exclusionPatterns);
  const setDragPaths = useAppStore(s => s.setDragPaths);

  const isSelected = selectedPath === node.path;

  const handleClick = useCallback((e: React.MouseEvent) => {
    onSelect(node.path);
    onActivate(node.is_directory ? node.path : parentPath);
    (e.currentTarget as HTMLElement).focus();
  }, [node.is_directory, node.path, onActivate, onSelect, parentPath]);

  const handleArrowClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (!node.is_directory) return;
    pinToTopAfterLoadRef.current = false;
    if (!expanded) {
      setLoading(true);
      listDirectory(node.path, exclusionPatterns).then((entries) => {
        setChildren(entries);
        setLoading(false);
      }).catch((err) => {
        console.error('Failed to load directory:', err);
        setLoading(false);
      });
    }
    setExpanded(!expanded);
  }, [node.path, node.is_directory, expanded, exclusionPatterns]);

  const handleDoubleClick = useCallback(async () => {
    if (node.is_directory) {
      onNavigate(node.path);
      if (!expanded) {
        pinToTopAfterLoadRef.current = true;
        scrollFileTreeItemToTop(itemRef.current);
        setLoading(true);
        listDirectory(node.path, exclusionPatterns).then((entries) => {
          setChildren(entries);
          setLoading(false);
        }).catch((err) => {
          console.error('Failed to load directory:', err);
          setLoading(false);
        });
      } else {
        pinToTopAfterLoadRef.current = false;
      }
      setExpanded(!expanded);
      return;
    }
    // 开关开启时，双击 .bat 直接运行（等同“在系统中打开”）；否则按文本文件在编辑器中打开
    const runBat = node.path.toLowerCase().endsWith('.bat') && getAppSettings().doubleClickRunBat;
    if (!runBat && isTextFile(node.path)) {
      try {
        const size = await getFileSize(node.path);
        if (size > 1024 * 1024) {
          alert('文件过大，无法在编辑器中打开（超过 1MB）');
          return;
        }
      } catch {
        // 无法获取大小时尝试打开
      }
      useAppStore.getState().openEditorSession(node.path);
    } else {
      openPath(node.path).catch((err) => console.error('Failed to open file:', err));
    }
  }, [node.is_directory, node.path, expanded, exclusionPatterns, onNavigate]);

  useLayoutEffect(() => {
    if (!expanded || loading || !pinToTopAfterLoadRef.current) return;
    pinToTopAfterLoadRef.current = false;
    scrollFileTreeItemToTop(itemRef.current);
  }, [children, expanded, loading]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'c' && e.ctrlKey && !e.shiftKey) {
      if (renameInputRef.current === document.activeElement) return;
      e.preventDefault();
      e.stopPropagation();
      navigator.clipboard.writeText(node.path).catch(() => {});
    }
    if (e.key === 'F2' && isSelected) {
      e.preventDefault();
      e.stopPropagation();
      setRenameValue(node.name);
      setRenamingPath(node.path);
      setTimeout(() => renameInputRef.current?.select(), 0);
    }
  }, [node.path, node.name, isSelected, setRenamingPath]);

  const isRenaming = renamingPath === node.path;

  const finishRename = useCallback(() => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== node.name) {
      onRename(node.path, trimmed);
    }
    setRenamingPath(null);
  }, [renameValue, node.path, node.name, onRename, setRenamingPath]);

  const cancelRename = useCallback(() => {
    setRenamingPath(null);
  }, [setRenamingPath]);

  // Auto-focus when entering rename mode
  useEffect(() => {
    if (isRenaming && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [isRenaming]);

  return (
    <div className="tree-node">
      <div
        ref={itemRef}
        className={`tree-item ${isSelected ? 'selected' : ''}`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        tabIndex={-1}
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          const startX = e.clientX;
          const startY = e.clientY;
          let dragging = false;
          let ghost: HTMLDivElement | null = null;
          const onMove = (ev: MouseEvent) => {
            if (!dragging && (Math.abs(ev.clientX - startX) > 4 || Math.abs(ev.clientY - startY) > 4)) {
              dragging = true;
              setDragPaths([node.path]);
              ghost = document.createElement('div');
              ghost.className = 'file-drag-ghost';
              ghost.textContent = node.name;
              document.body.appendChild(ghost);
            }
            if (ghost) {
              ghost.style.left = `${ev.clientX + 12}px`;
              ghost.style.top = `${ev.clientY + 12}px`;
            }
          };
          const onUp = () => {
            if (ghost) ghost.remove();
            if (!dragging) setDragPaths(null);
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
          };
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp);
        }}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onKeyDown={handleKeyDown}
        onContextMenu={(e) => onContextMenu(e, node.path, node.is_directory)}
      >
        {node.is_directory && (
          <span
            className={`tree-arrow ${expanded ? 'expanded' : ''}`}
            onClick={handleArrowClick}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            ▶
          </span>
        )}
        {!node.is_directory && <span className="tree-arrow-placeholder" />}
        <span className="tree-icon">
          {node.is_directory ? <Folder aria-hidden="true" /> : <File aria-hidden="true" />}
        </span>
        {isRenaming ? (
          <input
            ref={renameInputRef}
            className="tree-rename-input"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={finishRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); finishRename(); }
              if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="tree-name">{node.name}</span>
        )}
      </div>
      {loading && (
        <div className="tree-loading" style={{ paddingLeft: `${(depth + 1) * 16 + 8}px` }}>
          加载中...
        </div>
      )}
      {expanded && children.length > 0 && (
        <div className="tree-children">
          {children.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              parentPath={node.path}
              selectedPath={selectedPath}
              onActivate={onActivate}
              onSelect={onSelect}
              onNavigate={onNavigate}
              onContextMenu={onContextMenu}
              onRename={onRename}
              renamingPath={renamingPath}
              setRenamingPath={setRenamingPath}
            />
          ))}
        </div>
      )}
    </div>
  );
};

function sortLabel(by: 'name' | 'size' | 'modified'): string {
  if (by === 'size') return '大小';
  if (by === 'modified') return '修改';
  return '名称';
}

function compareNodes(a: FileNode, b: FileNode, sortBy: 'name' | 'size' | 'modified', sortDir: 'asc' | 'desc'): number {
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

function directoryName(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '');
  if (!normalized) return path;
  return normalized.split(/[\\/]/).filter(Boolean).pop() || normalized;
}

function normalizeConfiguredPath(path: string): string {
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

function isPathEqualOrInside(path: string, root: string): boolean {
  const normalizedPath = normalizeConfiguredPath(path).toLowerCase();
  const normalizedRoot = normalizeConfiguredPath(root).toLowerCase();
  if (!normalizedPath || !normalizedRoot) return false;
  if (normalizedPath === normalizedRoot) return true;
  const prefix = normalizedRoot.endsWith('\\') ? normalizedRoot : `${normalizedRoot}\\`;
  return normalizedPath.startsWith(prefix);
}

function replacePathPrefix(path: string, oldPrefix: string, newPrefix: string): string {
  const normalizedPath = normalizeConfiguredPath(path);
  const normalizedOldPrefix = normalizeConfiguredPath(oldPrefix);
  if (!isPathEqualOrInside(normalizedPath, normalizedOldPrefix)) return path;
  return `${normalizeConfiguredPath(newPrefix)}${normalizedPath.slice(normalizedOldPrefix.length)}`;
}

interface ConfiguredFileRootProps {
  path: string;
  pinned: boolean;
  refreshVersion: number;
  collapseVersion: number;
  revealVersion: number;
  sortBy: 'name' | 'size' | 'modified';
  sortDir: 'asc' | 'desc';
  selectedPath: string | null;
  onActivate: (path: string) => void;
  onSelect: (path: string) => void;
  onNavigate: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, path: string, isDir: boolean) => void;
  onRootContextMenu: (e: React.MouseEvent, path: string) => void;
  onRename: (path: string, newName: string) => Promise<void>;
  renamingPath: string | null;
  setRenamingPath: (path: string | null) => void;
}

const ConfiguredFileRoot: FC<ConfiguredFileRootProps> = ({
  path,
  pinned,
  refreshVersion,
  collapseVersion,
  revealVersion,
  sortBy,
  sortDir,
  selectedPath,
  onActivate,
  onSelect,
  onNavigate,
  onContextMenu,
  onRootContextMenu,
  onRename,
  renamingPath,
  setRenamingPath,
}) => {
  const exclusionPatterns = useAppStore(s => s.exclusionPatterns);
  const [expanded, setExpanded] = useState(false);
  const [nodes, setNodes] = useState<FileNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [pathError, setPathError] = useState(false);
  const itemRef = useRef<HTMLDivElement>(null);
  const pinToTopAfterLoadRef = useRef(false);

  useEffect(() => {
    pinToTopAfterLoadRef.current = false;
    setExpanded(false);
  }, [collapseVersion]);

  useEffect(() => {
    if (revealVersion === 0) return;
    const frame = requestAnimationFrame(() => {
      pinToTopAfterLoadRef.current = true;
      setLoading(true);
      setExpanded(true);
      scrollFileTreeItemToTop(itemRef.current);
    });
    return () => cancelAnimationFrame(frame);
  }, [revealVersion]);

  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    setLoading(true);

    listDirectory(path, exclusionPatterns)
      .then((entries) => {
        if (cancelled) return;
        setNodes(entries);
        setPathError(false);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('Failed to load configured directory:', err);
        setNodes([]);
        setPathError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [path, exclusionPatterns, refreshVersion, expanded]);

  useLayoutEffect(() => {
    if (!expanded || loading || !pinToTopAfterLoadRef.current) return;
    pinToTopAfterLoadRef.current = false;
    scrollFileTreeItemToTop(itemRef.current);
  }, [expanded, loading, nodes]);

  const sortedNodes = useMemo(
    () => [...nodes].sort((a, b) => compareNodes(a, b, sortBy, sortDir)),
    [nodes, sortBy, sortDir],
  );
  const name = directoryName(path);

  const toggle = useCallback(() => {
    setExpanded(value => !value);
  }, []);

  const handleDoubleClick = useCallback(() => {
    if (!expanded) {
      pinToTopAfterLoadRef.current = true;
      setLoading(true);
      scrollFileTreeItemToTop(itemRef.current);
    } else {
      pinToTopAfterLoadRef.current = false;
    }
    toggle();
  }, [expanded, toggle]);

  return (
    <div className="file-nav-configured-root">
      <div
        ref={itemRef}
        className={`tree-item file-nav-root ${selectedPath === path ? 'selected' : ''} ${pathError ? 'error' : ''}`}
        role="button"
        aria-expanded={expanded}
        aria-label={`${name}，${path}，${pinned ? '已置顶，' : ''}${expanded ? '已展开' : '已折叠'}`}
        tabIndex={0}
        title={`${name} - ${path}`}
        onClick={(e) => {
          onSelect(path);
          onActivate(path);
          e.currentTarget.focus();
        }}
        onDoubleClick={handleDoubleClick}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          onSelect(path);
          onActivate(path);
          toggle();
        }}
        onContextMenu={(e) => onRootContextMenu(e, path)}
      >
        <span
          className={`tree-arrow ${expanded ? 'expanded' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            toggle();
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <ChevronRight size={13} strokeWidth={2} />
        </span>
        {expanded
          ? <FolderOpen className="file-nav-root-icon" size={16} strokeWidth={1.8} />
          : <Folder className="file-nav-root-icon" size={16} strokeWidth={1.8} />}
        <span className="file-nav-root-label">
          <strong className="file-nav-root-name">{pinned ? `【置顶】${name}` : name}</strong>
          <span className="file-nav-root-path"> - {path}</span>
        </span>
        {pathError && <span className="path-error" role="alert" aria-label="路径不存在" title="路径不存在">!</span>}
      </div>
      {expanded && (
        <div className="file-nav-root-children">
          {loading && <div className="tree-loading file-nav-root-loading">加载中...</div>}
          {!loading && !pathError && sortedNodes.length === 0 && (
            <div className="empty-hint file-nav-root-empty">目录为空</div>
          )}
          {!loading && sortedNodes.map((node) => (
            <TreeNode
              key={node.path}
              node={node}
              depth={1}
              parentPath={path}
              selectedPath={selectedPath}
              onActivate={onActivate}
              onSelect={onSelect}
              onNavigate={onNavigate}
              onContextMenu={onContextMenu}
              onRename={onRename}
              renamingPath={renamingPath}
              setRenamingPath={setRenamingPath}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export const FileNav: FC = () => {
  const currentDirectory = useAppStore(s => s.currentDirectory);
  const fileSortBy = useAppStore(s => s.fileSortBy);
  const fileSortDir = useAppStore(s => s.fileSortDir);
  const setFileSort = useAppStore(s => s.setFileSort);
  const activeSessionId = useAppStore(s => s.activeSessionId);
  const sessionDirectories = useAppStore(s => s.sessionDirectories);
  const sessions = useAppStore(s => s.sessions);
  const profiles = useAppStore(s => s.profiles);
  const fileTreeVisible = useAppStore(s => s.fileTreeVisible);
  const bookmarks = useAppStore(s => s.bookmarks);
  const addBookmark = useAppStore(s => s.addBookmark);
  const removeBookmark = useAppStore(s => s.removeBookmark);
  const renameBookmark = useAppStore(s => s.renameBookmark);
  const pinnedFileRoots = useAppStore(s => s.pinnedFileRoots);
  const pinFileRoot = useAppStore(s => s.pinFileRoot);
  const unpinFileRoot = useAppStore(s => s.unpinFileRoot);
  const [width, setWidth] = useState(250);
  const widthRef = useRef(250);
  const [isResizing, setIsResizing] = useState(false);
  const [filterQuery, setFilterQuery] = useState('');
  const [gitTargetOverride, setGitTargetOverride] = useState<string | null>(null);
  const [bookmarkRootPath, setBookmarkRootPath] = useState<string | null>(null);
  const [rootRefreshVersion, setRootRefreshVersion] = useState(0);
  const [rootCollapseVersion, setRootCollapseVersion] = useState(0);
  const [rootRevealRequest, setRootRevealRequest] = useState<{ path: string; version: number } | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; path?: string; isDir?: boolean; dir?: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [confirmBookmarkDelete, setConfirmBookmarkDelete] = useState<string | null>(null);
  const [bookmarkCtxMenu, setBookmarkCtxMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const [renamingBookmark, setRenamingBookmark] = useState<string | null>(null);
  const [renamingBookmarkValue, setRenamingBookmarkValue] = useState('');
  const bookmarkHeight = useAppStore(s => s.bookmarkHeight);
  const setBookmarkHeightStore = useAppStore(s => s.setBookmarkHeight);
  const renameBookmarkInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const ctxMenuRef = useRef<HTMLDivElement>(null);

  const activeSession = sessions.find(s => s.id === activeSessionId);
  const isSsh = activeSession?.terminalType === 'ssh';
  const configuredDirectories = useMemo(() => {
    const uniquePaths = new Map<string, string>();
    for (const profile of profiles) {
      if (profile.terminalType !== 'powershell' && profile.terminalType !== 'cmd') continue;
      const path = normalizeConfiguredPath(profile.startupPath || '');
      if (!path) continue;
      const key = path.toLowerCase();
      if (!uniquePaths.has(key)) uniquePaths.set(key, path);
    }
    return [...uniquePaths.values()];
  }, [profiles]);

  const rootDirectories = useMemo(() => {
    const directories = [...configuredDirectories];
    if (bookmarkRootPath) {
      const bookmarkKey = bookmarkRootPath.toLowerCase();
      if (!directories.some(path => path.toLowerCase() === bookmarkKey)) {
        directories.push(bookmarkRootPath);
      }
    }

    const directoriesByKey = new Map(directories.map(path => [path.toLowerCase(), path]));
    const pinnedDirectories = pinnedFileRoots
      .map(path => directoriesByKey.get(path.toLowerCase()))
      .filter((path): path is string => Boolean(path));
    const pinnedKeys = new Set(pinnedDirectories.map(path => path.toLowerCase()));
    return [
      ...pinnedDirectories,
      ...directories.filter(path => !pinnedKeys.has(path.toLowerCase())),
    ];
  }, [bookmarkRootPath, configuredDirectories, pinnedFileRoots]);

  const pinnedFileRootKeys = useMemo(
    () => new Set(pinnedFileRoots.map(path => path.toLowerCase())),
    [pinnedFileRoots],
  );

  const activeSessionDirectory = useMemo(() => {
    if (!activeSessionId) return '';
    const trackedDirectory = sessionDirectories[activeSessionId]?.trim();
    if (trackedDirectory) return trackedDirectory;
    const session = sessions.find(item => item.id === activeSessionId);
    if (!session) return '';
    return profiles.find(profile => profile.id === session.profileId)?.startupPath?.trim() || '';
  }, [activeSessionId, profiles, sessionDirectories, sessions]);

  const gitTargetDirectory = gitTargetOverride
    || activeSessionDirectory
    || (!activeSessionId ? currentDirectory : '');

  const visibleConfiguredDirectories = useMemo(() => {
    const query = filterQuery.trim().toLowerCase();
    if (!query) return rootDirectories;
    return rootDirectories.filter(path => (
      directoryName(path).toLowerCase().includes(query)
      || path.toLowerCase().includes(query)
    ));
  }, [filterQuery, rootDirectories]);
  const selectedVisibleRoot = useMemo(() => {
    if (!selectedPath) return null;
    return [...visibleConfiguredDirectories]
      .sort((a, b) => b.length - a.length)
      .find(root => isPathEqualOrInside(selectedPath, root)) || null;
  }, [selectedPath, visibleConfiguredDirectories]);

  useEffect(() => {
    const belongsToVisibleTree = (path: string) => (
      rootDirectories.some(root => isPathEqualOrInside(path, root))
    );
    setSelectedPath(path => path && !belongsToVisibleTree(path) ? null : path);
    setGitTargetOverride(path => path && !belongsToVisibleTree(path) ? null : path);
  }, [rootDirectories]);

  // 启动时从后端恢复宽度
  useEffect(() => {
    getBackendAppSettings().then(s => {
      const w = s.fileNavWidth || 250;
      setWidth(w);
      widthRef.current = w;
    }).catch(() => {});
  }, []);

  const activateTreeDirectory = useCallback((path: string) => {
    setGitTargetOverride(path);
  }, []);

  const cycleSortField = useCallback(() => {
    const fields: Array<'name' | 'size' | 'modified'> = ['name', 'size', 'modified'];
    const idx = fields.indexOf(fileSortBy);
    const next = fields[(idx + 1) % fields.length];
    setFileSort(next, fileSortDir);
  }, [fileSortBy, fileSortDir, setFileSort]);

  const toggleSortDir = useCallback(() => {
    setFileSort(fileSortBy, fileSortDir === 'asc' ? 'desc' : 'asc');
  }, [fileSortBy, fileSortDir, setFileSort]);

  const handleSelect = useCallback((path: string) => {
    setSelectedPath(path);
  }, []);

  const handleNavigate = useCallback((path: string) => {
    setSelectedPath(path);
    activateTreeDirectory(path);
  }, [activateTreeDirectory]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  }, []);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isResizing) return;

    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
    }

    rafRef.current = requestAnimationFrame(() => {
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        const newWidth = e.clientX - rect.left;
        if (newWidth >= 150 && newWidth <= 500) {
          setWidth(newWidth);
          widthRef.current = newWidth;
        }
      }
    });
  }, [isResizing]);

  const handleMouseUp = useCallback(() => {
    setIsResizing(false);
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
    }
    saveFileNavWidth(widthRef.current).catch(() => {});
  }, []);

  useEffect(() => {
    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    }
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing, handleMouseMove, handleMouseUp]);

  const handleRefresh = useCallback(() => {
    setRootRefreshVersion(version => version + 1);
  }, []);

  const handleCollapseAll = useCallback(() => {
    setRootCollapseVersion(version => version + 1);
  }, []);

  const handleRootContextMenu = useCallback((e: React.MouseEvent, path: string) => {
    e.preventDefault();
    e.stopPropagation();
    setSelectedPath(path);
    activateTreeDirectory(path);
    setCtxMenu({ x: e.clientX, y: e.clientY, dir: path });
  }, [activateTreeDirectory]);

  const handleContextMenu = useCallback((e: React.MouseEvent, path: string, isDir: boolean) => {
    e.preventDefault();
    e.stopPropagation();
    setSelectedPath(path);
    if (isDir) activateTreeDirectory(path);
    setCtxMenu({ x: e.clientX, y: e.clientY, path, isDir });
  }, [activateTreeDirectory]);

  const handleShowInExplorer = useCallback(async () => {
    if (!ctxMenu?.path) return;
    try { await openInExplorer(ctxMenu.path); } catch (err) { console.error(err); }
    setCtxMenu(null);
  }, [ctxMenu]);

  const handleOpenInSystem = useCallback(async () => {
    if (!ctxMenu?.path) return;
    try { await openPath(ctxMenu.path); } catch (err) { console.error(err); }
    setCtxMenu(null);
  }, [ctxMenu]);

  const handleShowCurrentDirInExplorer = useCallback(async (dir?: string) => {
    const target = dir || gitTargetDirectory;
    if (!target) return;
    try { await openInExplorer(target); } catch (err) { console.error(err); }
    setCtxMenu(null);
  }, [gitTargetDirectory]);

  const handleDeleteItem = useCallback(() => {
    setConfirmDelete(ctxMenu?.path || null);
    setCtxMenu(null);
  }, [ctxMenu]);

  const confirmDeleteItem = useCallback(async () => {
    if (!confirmDelete) return;
    try {
      await deletePath(confirmDelete);
      setSelectedPath(path => path && isPathEqualOrInside(path, confirmDelete) ? null : path);
      setGitTargetOverride(path => path && isPathEqualOrInside(path, confirmDelete) ? null : path);
      setBookmarkRootPath(path => path && isPathEqualOrInside(path, confirmDelete) ? null : path);
      setRootRefreshVersion(version => version + 1);
    } catch (err) {
      console.error(err);
      alert('删除失败: ' + String(err));
    }
    setConfirmDelete(null);
  }, [confirmDelete]);

  const cancelDeleteItem = useCallback(() => {
    setConfirmDelete(null);
  }, []);

  const handleRenameItem = useCallback(async () => {
    if (!ctxMenu?.path) return;
    setCtxMenu(null);
    setRenamingPath(ctxMenu.path);
  }, [ctxMenu]);

  const handleRenameInline = useCallback(async (path: string, newName: string) => {
    try {
      await renamePath(path, newName);
      const parent = path.substring(0, path.lastIndexOf('\\'));
      const renamedPath = parent + '\\' + newName;
      setSelectedPath(current => current ? replacePathPrefix(current, path, renamedPath) : renamedPath);
      setGitTargetOverride(current => current ? replacePathPrefix(current, path, renamedPath) : current);
      setBookmarkRootPath(current => current ? replacePathPrefix(current, path, renamedPath) : current);
      setRootRefreshVersion(version => version + 1);
    } catch (err) {
      console.error(err);
      alert('重命名失败: ' + String(err));
    }
    setRenamingPath(null);
  }, []);

  // Close context menu on outside click, keydown, or scroll
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    document.addEventListener('click', close);
    document.addEventListener('keydown', close);
    document.addEventListener('wheel', close);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', close);
      document.removeEventListener('wheel', close);
    };
  }, [ctxMenu]);

  // 菜单定位：贴近边缘时翻转到内侧，避免靠底被遮挡
  const adjustCtxMenuPosition = useCallback(() => {
    const menu = ctxMenuRef.current;
    if (!menu || !ctxMenu) return;
    const { width: menuWidth, height: menuHeight } = menu.getBoundingClientRect();
    const next = fitContextMenuToViewport(ctxMenu.x, ctxMenu.y, menuWidth, menuHeight);
    if (next.x !== ctxMenu.x || next.y !== ctxMenu.y) {
      setCtxMenu(prev => (prev ? { ...prev, ...next } : prev));
    }
  }, [ctxMenu]);

  useLayoutEffect(() => {
    if (!ctxMenu) return;
    adjustCtxMenuPosition();
  }, [ctxMenu, adjustCtxMenuPosition]);

  useEffect(() => {
    if (!ctxMenu) return;
    window.addEventListener('resize', adjustCtxMenuPosition);
    return () => window.removeEventListener('resize', adjustCtxMenuPosition);
  }, [ctxMenu, adjustCtxMenuPosition]);

  if (isSsh && activeSession) {
    return <RemoteFileTree terminalId={activeSession.id} />;
  }

  return (
    <div ref={containerRef} className={`file-nav ${!fileTreeVisible ? 'collapsed' : ''}`} style={{ width }}>
      <div className="panel-titlebar">
        <span className="panel-title">文件</span>
        <div className="file-nav-actions">
          <button type="button" onClick={handleCollapseAll} title="全部折叠" aria-label="折叠所有目录">
            <ListChevronsDownUp aria-hidden="true" />
          </button>
          <button type="button" onClick={handleRefresh} title="刷新" aria-label="刷新文件列表">
            <RefreshCw aria-hidden="true" />
          </button>
          <button type="button" onClick={toggleSortDir} title={`方向：${fileSortDir === 'asc' ? '升序' : '降序'}（点击翻转）`} aria-label={`切换为${fileSortDir === 'asc' ? '降序' : '升序'}`}>
            {fileSortDir === 'asc' ? <ArrowUp aria-hidden="true" /> : <ArrowDown aria-hidden="true" />}
          </button>
          <button type="button" className="file-nav-sort-field" onClick={cycleSortField} title={`排序：${sortLabel(fileSortBy)}（点击切换）`}>
            {sortLabel(fileSortBy)}
          </button>
        </div>
      </div>
      <GitNavBar
        key={gitTargetDirectory.toLowerCase() || 'none'}
        currentDirectory={gitTargetDirectory}
        onRepositoryChanged={handleRefresh}
      />
      <div className="file-nav-filter">
        <input
          className="filter-input"
          placeholder="过滤父级目录…"
          value={filterQuery}
          onChange={(e) => setFilterQuery(e.target.value)}
          aria-label="过滤父级目录"
        />
      </div>
      <div
        className="file-nav-content"
        onContextMenu={(e) => {
          const target = e.target as HTMLElement;
          if (target.closest('.tree-item')) return;
          e.preventDefault();
          setCtxMenu({ x: e.clientX, y: e.clientY, dir: selectedVisibleRoot || undefined });
        }}
      >
        {rootDirectories.length === 0 && (
          <div className="empty-state file-nav-empty-state">暂无已配置的起始路径</div>
        )}
        {rootDirectories.length > 0 && visibleConfiguredDirectories.length === 0 && (
          <div className="empty-hint">无匹配目录</div>
        )}
        {visibleConfiguredDirectories.map(path => (
          <ConfiguredFileRoot
            key={`${path.toLowerCase()}:${rootRefreshVersion}`}
            path={path}
            pinned={pinnedFileRootKeys.has(path.toLowerCase())}
            refreshVersion={rootRefreshVersion}
            collapseVersion={rootCollapseVersion}
            revealVersion={rootRevealRequest?.path.toLowerCase() === path.toLowerCase() ? rootRevealRequest.version : 0}
            sortBy={fileSortBy}
            sortDir={fileSortDir}
            selectedPath={selectedPath}
            onActivate={activateTreeDirectory}
            onSelect={handleSelect}
            onNavigate={handleNavigate}
            onContextMenu={handleContextMenu}
            onRootContextMenu={handleRootContextMenu}
            onRename={handleRenameInline}
            renamingPath={renamingPath}
            setRenamingPath={setRenamingPath}
          />
        ))}
      </div>
      {bookmarks.length > 0 && (
        <div className="bookmark-section" style={{ height: bookmarkHeight }}>
          <div
            className="bookmark-resize-handle"
            onMouseDown={(e) => {
              e.preventDefault();
              const startY = e.clientY;
              const startH = bookmarkHeight;
              const onMove = (ev: MouseEvent) => {
                const newH = Math.max(64, Math.min(300, startH - (ev.clientY - startY)));
                setBookmarkHeightStore(newH);
              };
              const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
              };
              document.addEventListener('mousemove', onMove);
              document.addEventListener('mouseup', onUp);
            }}
          />
          <div className="bookmark-bar">
          {bookmarks.map((bm) => (
            <div
              key={bm.path}
              className="bookmark-tag"
              onClick={() => {
                if (renamingBookmark === bm.path) return;
                const path = normalizeConfiguredPath(bm.path);
                if (!path) return;
                setBookmarkRootPath(path);
                setRootCollapseVersion(version => version + 1);
                setRootRevealRequest(request => ({
                  path,
                  version: (request?.version ?? 0) + 1,
                }));
                setFilterQuery('');
                setSelectedPath(path);
                activateTreeDirectory(path);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setBookmarkCtxMenu({ x: e.clientX, y: e.clientY, path: bm.path });
              }}
              title={bm.path}
            >
              <Folder className="bookmark-icon" aria-hidden="true" />
              {renamingBookmark === bm.path ? (
                <input
                  ref={renameBookmarkInputRef}
                  className="bookmark-rename-input"
                  value={renamingBookmarkValue}
                  onChange={(e) => setRenamingBookmarkValue(e.target.value)}
                  onBlur={() => {
                    const trimmed = renamingBookmarkValue.trim();
                    if (trimmed) renameBookmark(renamingBookmark!, trimmed);
                    setRenamingBookmark(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      const trimmed = renamingBookmarkValue.trim();
                      if (trimmed) renameBookmark(renamingBookmark!, trimmed);
                      setRenamingBookmark(null);
                    } else if (e.key === 'Escape') {
                      setRenamingBookmark(null);
                    }
                  }}
                  onClick={(e) => e.stopPropagation()}
                  autoFocus
                />
              ) : (
                <span className="bookmark-name">{bm.name}</span>
              )}
              <button
                className="bookmark-close"
                onClick={(e) => {
                  e.stopPropagation();
                  setConfirmBookmarkDelete(bm.path);
                }}
                title="删除书签"
              >
                <X aria-hidden="true" />
              </button>
            </div>
          ))}
          </div>
        </div>
      )}
      <div
        className={`resize-handle ${isResizing ? 'active' : ''}`}
        onMouseDown={handleMouseDown}
      />

      {ctxMenu && (
        <div
          ref={ctxMenuRef}
          className="context-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="context-menu-item" onClick={() => { setCtxMenu(null); handleRefresh(); }}>
            刷新
          </div>
          {!ctxMenu.path && ctxMenu.dir && (
            <>
              <div className="context-menu-separator" />
              <div className="context-menu-item" onClick={() => {
                const dir = ctxMenu.dir!;
                if (pinnedFileRootKeys.has(dir.toLowerCase())) {
                  unpinFileRoot(dir);
                } else {
                  pinFileRoot(dir);
                }
                setCtxMenu(null);
              }}>
                {pinnedFileRootKeys.has(ctxMenu.dir.toLowerCase()) ? '取消置顶' : '置顶'}
              </div>
              <div className="context-menu-item" onClick={async () => {
                const dir = ctxMenu.dir!;
                setCtxMenu(null);
                try { await openTerminalInDir(dir); } catch (err) { console.error(err); }
              }}>
                在当前目录打开命令窗口
              </div>
              <div className="context-menu-item" onClick={() => {
                const dir = ctxMenu.dir!;
                const name = dir.split('\\').filter(Boolean).pop() || dir;
                addBookmark(name, dir);
                setCtxMenu(null);
              }}>
                添加到书签
              </div>
              <div className="context-menu-item" onClick={() => handleShowCurrentDirInExplorer(ctxMenu.dir)}>
                在文件资源管理器中显示
              </div>
            </>
          )}
          {ctxMenu.path && (
            <>
              <div className="context-menu-separator" />
              <div className="context-menu-item" onClick={handleShowInExplorer}>
                在文件资源管理器中显示
              </div>
              {!ctxMenu.isDir && (
                <div className="context-menu-item" onClick={handleOpenInSystem}>
                  在系统中打开
                </div>
              )}
              {ctxMenu.isDir && (
                <div className="context-menu-item" onClick={async () => {
                  const dir = ctxMenu.path!;
                  setCtxMenu(null);
                  try { await openTerminalInDir(dir); } catch (err) { console.error(err); }
                }}>
                  在当前目录打开命令窗口
                </div>
              )}
              {ctxMenu.isDir && (
                <div className="context-menu-item" onClick={() => {
                  const name = ctxMenu.path!.split('\\').pop() || ctxMenu.path!;
                  addBookmark(name, ctxMenu.path!);
                  setCtxMenu(null);
                }}>
                  添加到书签
                </div>
              )}
              <div className="context-menu-item" onClick={handleRenameItem}>
                重命名
              </div>
              <div className="context-menu-item danger" onClick={handleDeleteItem}>
                删除
              </div>
            </>
          )}
        </div>
      )}

      {confirmDelete && (
        <div className="confirm-dialog-overlay" onClick={cancelDeleteItem}>
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-dialog-title">确认删除</div>
            <div className="confirm-dialog-message">确定删除 "{confirmDelete}" 吗？</div>
            <div className="confirm-dialog-buttons">
              <button className="btn-secondary" onClick={cancelDeleteItem}>
                取消
              </button>
              <button className="btn-danger" onClick={confirmDeleteItem}>
                删除
              </button>
            </div>
          </div>
        </div>
      )}
      {confirmBookmarkDelete && (
        <div className="confirm-dialog-overlay" onClick={() => setConfirmBookmarkDelete(null)}>
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-dialog-title">确认删除</div>
            <div className="confirm-dialog-message">确定删除此书签吗？</div>
            <div className="confirm-dialog-buttons">
              <button className="btn-secondary" onClick={() => setConfirmBookmarkDelete(null)}>取消</button>
              <button className="btn-danger" onClick={() => {
                removeBookmark(confirmBookmarkDelete);
                setConfirmBookmarkDelete(null);
              }}>删除</button>
            </div>
          </div>
        </div>
      )}
      {bookmarkCtxMenu && (() => {
        const menuH = 64;
        const top = bookmarkCtxMenu.y + menuH > window.innerHeight
          ? bookmarkCtxMenu.y - menuH
          : bookmarkCtxMenu.y;
        return (
        <>
          <div style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', zIndex: 9998 }} onClick={() => setBookmarkCtxMenu(null)} />
          <div className="context-menu" style={{ left: bookmarkCtxMenu.x, top, zIndex: 9999 }}>
            <div className="context-menu-item" onClick={() => {
              const bm = bookmarks.find(b => b.path === bookmarkCtxMenu.path);
              if (bm) {
                setRenamingBookmarkValue(bm.name);
                setRenamingBookmark(bm.path);
                setTimeout(() => renameBookmarkInputRef.current?.select(), 0);
              }
              setBookmarkCtxMenu(null);
            }}>重命名</div>
            <div className="context-menu-item danger" onClick={() => {
              setConfirmBookmarkDelete(bookmarkCtxMenu.path);
              setBookmarkCtxMenu(null);
            }}>删除</div>
          </div>
        </>
        );
      })()}
    </div>
  );
};
