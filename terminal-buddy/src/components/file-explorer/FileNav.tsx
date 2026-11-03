import { FC, useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo, useSyncExternalStore } from 'react';
import { ArrowDown, ArrowUp, Folder, FolderPlus, ListChevronsDownUp, Plus, RefreshCw } from 'lucide-react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { listDirectory, openPath, openInExplorer, deletePath, renamePath, saveConfigNavWidth, saveFileNavWidth, getBackendAppSettings } from '../../services/tauri';
import { useAppStore } from '../../stores/appStore';
import { useActiveTabProjectDirectory } from '../../hooks/useActiveTabProjectDirectory';
import { effectiveProfilePath } from '../../utils/projectPath';
import { openTerminalInDir } from '../../utils/openTerminalInDir';
import { fitContextMenuToViewport } from '../../utils/contextMenu';
import { notifyTerminalPanelResize } from '../../utils/terminalResizeEvent';
import { showAlert } from '../../services/dialog';
import { canDownloadToBrowser, downloadToBrowser } from '../../services/fileDownload';
import { supportsSystemExplorerOpen } from '../../services/platform';
import { GitOperationsHost, type GitContextAction, type GitOperationsHostHandle } from '../git/GitOperationsHost';
import { getGitOperation, subscribeGitOperations } from '../../services/gitOperationState';
import { getCachedGitRepositoryStatus, loadGitRepositoryStatus, subscribeGitRepositoryStatus } from '../../services/gitStatusCache';
import { RemoteFileTree } from './RemoteFileTree';
import { ConfirmDialog, Dialog } from '../shared/Dialog';
import './FileNav.css';

import { ConfiguredFileRoot } from './ConfiguredFileRoot';
import { sortLabel, directoryName, normalizeConfiguredPath, isPathEqualOrInside, replacePathPrefix } from './file-utils';

interface FileNavProps {
  isSidebarMode: boolean;
}

function parentDirectoryPath(path: string): string {
  const normalized = normalizeConfiguredPath(path);
  const separator = Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/'));
  if (separator < 0) return normalized;
  if (separator === 2 && /^[a-zA-Z]:\\/.test(normalized)) return normalized.slice(0, 3);
  return normalized.slice(0, separator) || (normalized.startsWith('/') ? '/' : '\\');
}

export const FileNav: FC<FileNavProps> = ({ isSidebarMode }) => {
  const currentDirectory = useAppStore(s => s.currentDirectory);
  const fileSortBy = useAppStore(s => s.fileSortBy);
  const fileSortDir = useAppStore(s => s.fileSortDir);
  const setFileSort = useAppStore(s => s.setFileSort);
  const activeSessionId = useAppStore(s => s.activeSessionId);
  const activeSpecialTab = useAppStore(s => s.activeSpecialTab);
  const claudeReplayTab = useAppStore(s => s.claudeReplayTab);
  const tabProjectDirectory = useActiveTabProjectDirectory();
  const sessionDirectories = useAppStore(s => s.sessionDirectories);
  const sessions = useAppStore(s => s.sessions);
  const profiles = useAppStore(s => s.profiles);
  const projects = useAppStore(s => s.projects);
  const fileTreeVisible = useAppStore(s => s.fileTreeVisible);
  const fileRoots = useAppStore(s => s.fileRoots);
  const addFileRoot = useAppStore(s => s.addFileRoot);
  const removeFileRoot = useAppStore(s => s.removeFileRoot);
  const [width, setWidth] = useState(250);
  const widthRef = useRef(250);
  const [isResizing, setIsResizing] = useState(false);
  const [filterQuery, setFilterQuery] = useState('');
  const [gitTargetOverride, setGitTargetOverride] = useState<string | null>(null);
  const [showRootPicker, setShowRootPicker] = useState(false);
  const [focusedRootPath, setFocusedRootPath] = useState<string | null>(null);
  const [autoExpandedRootPath, setAutoExpandedRootPath] = useState<string | null>(null);
  const [rootRefreshVersion, setRootRefreshVersion] = useState(0);
  const [rootCollapseVersion, setRootCollapseVersion] = useState(0);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; path?: string; isDir?: boolean; dir?: string; root?: boolean } | null>(null);
  const gitNavRef = useRef<GitOperationsHostHandle>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [customPathInput, setCustomPathInput] = useState('');
  const [customPathError, setCustomPathError] = useState<string | null>(null);
  const [customPathBusy, setCustomPathBusy] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const ctxMenuRef = useRef<HTMLDivElement>(null);
  const customPathInputRef = useRef<HTMLInputElement>(null);

  const activeSession = sessions.find(s => s.id === activeSessionId);
  const isSsh = activeSession?.terminalType === 'ssh';
  const configuredDirectories = useMemo(() => {
    const uniquePaths = new Map<string, string>();
    for (const project of projects) {
      const path = normalizeConfiguredPath(project.path);
      if (path) uniquePaths.set(path.toLowerCase(), path);
    }
    for (const profile of profiles) {
      const path = normalizeConfiguredPath(effectiveProfilePath(profile, projects));
      if (path && !uniquePaths.has(path.toLowerCase())) uniquePaths.set(path.toLowerCase(), path);
    }
    return [...uniquePaths.values()];
  }, [profiles, projects]);

  const rootDirectories = useMemo(() => {
    const seen = new Set<string>();
    return [...fileRoots, ...projects.map(project => project.path), ...(tabProjectDirectory ? [tabProjectDirectory] : [])]
      .map(normalizeConfiguredPath)
      .filter(path => {
        const key = path.toLowerCase();
        if (!path || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }, [fileRoots, projects, tabProjectDirectory]);
  const activeProjectRoot = useMemo(() => tabProjectDirectory && rootDirectories.find(
    path => normalizeConfiguredPath(path).toLowerCase() === normalizeConfiguredPath(tabProjectDirectory).toLowerCase(),
  ), [tabProjectDirectory, rootDirectories]);
  const gitContextTarget = ctxMenu
    ? ctxMenu.path
      ? ctxMenu.isDir ? ctxMenu.path : parentDirectoryPath(ctxMenu.path)
      : ctxMenu.dir || null
    : null;

  // 右键首帧直接读取已在进入目录时准备好的缓存，不清空后等待异步重查。
  const contextGitEntry = useSyncExternalStore(
    subscribeGitRepositoryStatus,
    useCallback(() => gitContextTarget
      ? getCachedGitRepositoryStatus(gitContextTarget, { exact: true })
      : undefined, [gitContextTarget]),
  );
  const contextGitStatus = contextGitEntry?.status;
  const contextOperation = useSyncExternalStore(
    subscribeGitOperations,
    useCallback(() => contextGitStatus ? getGitOperation(contextGitStatus.repoRoot) : null, [contextGitStatus?.repoRoot]),
  );

  useEffect(() => {
    // 未进入过的目录兜底检测一次；已缓存的仓库和非仓库都不发起请求。
    if (!gitContextTarget || contextGitEntry) return;
    void loadGitRepositoryStatus(gitContextTarget, { exact: true })
      .catch(error => console.error('Failed to inspect Git context menu target:', error));
  }, [gitContextTarget, contextGitEntry]);

  useEffect(() => {
    setFocusedRootPath(activeProjectRoot || null);
    setAutoExpandedRootPath(activeProjectRoot || null);
    setSelectedPath(activeProjectRoot || null);
    setGitTargetOverride(null);
    setCtxMenu(null);
    setFilterQuery('');
    contentRef.current?.scrollTo({ top: 0, behavior: 'auto' });
  }, [activeSessionId, activeSpecialTab, claudeReplayTab?.sessionId, activeProjectRoot]);

  const fileRootKeys = useMemo(
    () => new Set(rootDirectories.map(path => path.toLowerCase())),
    [rootDirectories],
  );

  const availableDirectories = useMemo(
    () => configuredDirectories.filter(path => !fileRootKeys.has(path.toLowerCase())),
    [configuredDirectories, fileRootKeys],
  );

  const activeSessionDirectory = useMemo(() => {
    if (!activeSessionId) return '';
    const trackedDirectory = sessionDirectories[activeSessionId]?.trim();
    if (trackedDirectory) return trackedDirectory;
    const session = sessions.find(item => item.id === activeSessionId);
    if (!session) return '';
    return (() => { const profile = profiles.find(p => p.id === session.profileId); return profile ? effectiveProfilePath(profile, projects) : ''; })();
  }, [activeSessionId, profiles, projects, sessionDirectories, sessions]);

  const gitTargetDirectory = gitTargetOverride
    || tabProjectDirectory
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
  const displayedRootDirectories = useMemo(() => {
    if (!focusedRootPath) return visibleConfiguredDirectories;
    const focusedRoot = rootDirectories.find(path => path.toLowerCase() === focusedRootPath.toLowerCase());
    return focusedRoot ? [focusedRoot] : visibleConfiguredDirectories;
  }, [focusedRootPath, rootDirectories, visibleConfiguredDirectories]);
  useEffect(() => {
    if (!fileTreeVisible || isSsh) return;
    let cancelled = false;
    // 可见根目录提前检测，串行预热避免大量项目同时创建 git.exe 进程。
    void (async () => {
      for (const path of displayedRootDirectories) {
        if (cancelled) return;
        try {
          await loadGitRepositoryStatus(path, { exact: true });
        } catch (error) {
          if (!cancelled) console.error('Failed to prefetch Git repository status:', error);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [displayedRootDirectories, fileTreeVisible, isSsh]);

  const selectedVisibleRoot = useMemo(() => {
    if (!selectedPath) return null;
    return [...displayedRootDirectories]
      .sort((a, b) => b.length - a.length)
      .find(root => isPathEqualOrInside(selectedPath, root)) || null;
  }, [displayedRootDirectories, selectedPath]);

  useEffect(() => {
    const belongsToVisibleTree = (path: string) => (
      rootDirectories.some(root => isPathEqualOrInside(path, root))
    );
    setSelectedPath(path => path && !belongsToVisibleTree(path) ? null : path);
    setGitTargetOverride(path => path && !belongsToVisibleTree(path) ? null : path);
    setFocusedRootPath(path => path && !rootDirectories.some(root => root.toLowerCase() === path.toLowerCase()) ? null : path);
  }, [rootDirectories]);

  useEffect(() => {
    if (!fileTreeVisible || isSsh) {
      setShowRootPicker(false);
      setCtxMenu(null);
    }
  }, [fileTreeVisible, isSsh]);

  // 启动时从后端恢复宽度
  useEffect(() => {
    getBackendAppSettings().then(s => {
      const w = isSidebarMode ? s.configNavWidth || 250 : s.fileNavWidth || 250;
      setWidth(w);
      widthRef.current = w;
    }).catch(() => {});
  }, [isSidebarMode]);

  useEffect(() => {
    if (!isSidebarMode) return;
    const syncWidth = (event: Event) => {
      const width = (event as CustomEvent<number>).detail;
      if (Number.isFinite(width)) {
        setWidth(width);
        widthRef.current = width;
      }
    };
    window.addEventListener('navigation-width-changed', syncWidth);
    return () => window.removeEventListener('navigation-width-changed', syncWidth);
  }, [isSidebarMode]);

  const activateTreeDirectory = useCallback((path: string) => {
    setGitTargetOverride(path);
    // 单击/展开/进入目录时即开始检测；工具栏和右键菜单共用缓存与在途请求。
    void loadGitRepositoryStatus(path, { exact: true })
      .catch(error => console.error('Failed to load directory Git status:', error));
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
        if (newWidth >= 150 && newWidth <= (isSidebarMode ? 400 : 500)) {
          setWidth(newWidth);
          widthRef.current = newWidth;
          notifyTerminalPanelResize();
        }
      }
    });
  }, [isResizing, isSidebarMode]);

  const handleMouseUp = useCallback(() => {
    setIsResizing(false);
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
    }
    const saveWidth = isSidebarMode ? saveConfigNavWidth : saveFileNavWidth;
    saveWidth(widthRef.current).catch(() => {});
    notifyTerminalPanelResize();
    if (isSidebarMode) {
      window.dispatchEvent(new CustomEvent('navigation-width-changed', { detail: widthRef.current }));
    }
  }, [isSidebarMode]);

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

  const handleManualRefresh = useCallback((directory: string = gitTargetDirectory) => {
    handleRefresh();
    if (!directory) return;
    // 用户主动刷新时重新检测，支持目录在外部 git init 或移除仓库之后更新缓存。
    void loadGitRepositoryStatus(directory, { force: true, exact: true })
      .catch(error => console.error('Failed to refresh directory Git status:', error));
  }, [gitTargetDirectory, handleRefresh]);

  const handleCollapseAll = useCallback(() => {
    setFocusedRootPath(null);
    setAutoExpandedRootPath(null);
    setRootCollapseVersion(version => version + 1);
    contentRef.current?.scrollTo({ top: 0, behavior: 'auto' });
  }, []);

  const handleRootExpandedChange = useCallback((path: string, expanded: boolean) => {
    setFocusedRootPath(expanded ? path : null);
    setAutoExpandedRootPath(null);
    if (expanded) {
      setSelectedPath(path);
      activateTreeDirectory(path);
      requestAnimationFrame(() => contentRef.current?.scrollTo({ top: 0, behavior: 'auto' }));
    }
  }, [activateTreeDirectory]);

  const handleAddRoot = useCallback((path: string) => {
    const normalizedPath = normalizeConfiguredPath(path);
    if (!normalizedPath) return;
    addFileRoot(normalizedPath);
    setFilterQuery('');
    setSelectedPath(normalizedPath);
    activateTreeDirectory(normalizedPath);
    requestAnimationFrame(() => {
      const content = contentRef.current;
      if (!content) return;
      const behavior: ScrollBehavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'auto'
        : 'smooth';
      content.scrollTo({ top: content.scrollHeight, behavior });
    });
  }, [activateTreeDirectory, addFileRoot]);

  const handleAddCustomPath = useCallback(async () => {
    const trimmed = customPathInput.trim();
    if (!trimmed || customPathBusy) return;
    setCustomPathBusy(true);
    setCustomPathError(null);
    try {
      const normalizedPath = normalizeConfiguredPath(trimmed);
      if (!normalizedPath) {
        setCustomPathError('路径无效');
        return;
      }
      const normalizedKey = normalizedPath.toLowerCase();
      if (rootDirectories.some(root => root.toLowerCase() === normalizedKey)) {
        setCustomPathError('已在文件列表中');
        return;
      }
      try {
        await listDirectory(normalizedPath, []);
      } catch (err) {
        setCustomPathError('路径不存在或无法访问');
        console.error('Failed to validate custom path:', err);
        return;
      }
      handleAddRoot(normalizedPath);
      setCustomPathInput('');
      setCustomPathError(null);
    } finally {
      setCustomPathBusy(false);
      customPathInputRef.current?.focus();
    }
  }, [customPathBusy, customPathInput, handleAddRoot, rootDirectories]);

  const handleBrowseCustomPath = useCallback(async () => {
    if (customPathBusy) return;
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: '选择文件夹',
      });
      if (!selected || typeof selected !== 'string') return;
      setCustomPathInput(selected);
      setCustomPathError(null);
      customPathInputRef.current?.focus();
    } catch (err) {
      console.error('Failed to open directory picker:', err);
    }
  }, [customPathBusy]);

  const handleRemoveRoot = useCallback((path: string) => {
    removeFileRoot(path);
    setFocusedRootPath(current => current?.toLowerCase() === path.toLowerCase() ? null : current);
    setSelectedPath(current => current && isPathEqualOrInside(current, path) ? null : current);
    setGitTargetOverride(current => current && isPathEqualOrInside(current, path) ? null : current);
    if (rootDirectories.length === 1) setFilterQuery('');
    setCtxMenu(null);
  }, [removeFileRoot, rootDirectories.length]);

  const handleRootContextMenu = useCallback((e: React.MouseEvent, path: string) => {
    e.preventDefault();
    e.stopPropagation();
    setSelectedPath(path);
    activateTreeDirectory(path);
    setCtxMenu({ x: e.clientX, y: e.clientY, dir: path, root: true });
  }, [activateTreeDirectory]);

  const handleContextMenu = useCallback((e: React.MouseEvent, path: string, isDir: boolean) => {
    e.preventDefault();
    e.stopPropagation();
    setSelectedPath(path);
    activateTreeDirectory(isDir ? path : parentDirectoryPath(path));
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

  // 浏览器端（Linux 服务端 / Docker 部署）把服务器文件或目录下载到本机。
  const startBrowserDownload = useCallback((path: string) => {
    setCtxMenu(null);
    downloadToBrowser(path);
  }, []);

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
      setRootRefreshVersion(version => version + 1);
    } catch (err) {
      console.error(err);
      void showAlert('删除失败: ' + String(err), '删除失败');
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

  const runGitContextAction = (action: GitContextAction) => {
    if (!contextGitStatus) return;
    // 仓库身份取菜单快照，不依赖浏览目录变化后“当前工具栏”的引用。
    const repoRoot = contextGitStatus.repoRoot;
    setCtxMenu(null);
    gitNavRef.current?.runAction(repoRoot, action);
  };

  const renderGitContextItem = (action: GitContextAction, label: string, needsRemote = false) => {
    const disabled = action !== 'operation' && (Boolean(contextOperation) || (needsRemote && !contextGitStatus?.hasRemote));
    const title = contextOperation && action !== 'operation'
      ? '当前仓库正在执行 Git 操作，请等待完成'
      : needsRemote && !contextGitStatus?.hasRemote ? '当前仓库未配置远端' : undefined;
    return (
      <button type="button" className={`context-menu-item file-git-menu-item${disabled ? ' disabled' : ''}`}
        disabled={disabled} aria-disabled={disabled} title={title} onClick={() => runGitContextAction(action)}>
        {label}
      </button>
    );
  };

  const handleRenameInline = useCallback(async (path: string, newName: string) => {
    try {
      await renamePath(path, newName);
      const parent = parentDirectoryPath(path);
      const renamedPath = parent + '/' + newName;
      setSelectedPath(current => current ? replacePathPrefix(current, path, renamedPath) : renamedPath);
      setGitTargetOverride(current => current ? replacePathPrefix(current, path, renamedPath) : current);
      setRootRefreshVersion(version => version + 1);
    } catch (err) {
      console.error(err);
      void showAlert('重命名失败: ' + String(err), '重命名失败');
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
  }, [ctxMenu, contextGitStatus, adjustCtxMenuPosition]);

  useEffect(() => {
    if (!ctxMenu) return;
    window.addEventListener('resize', adjustCtxMenuPosition);
    return () => window.removeEventListener('resize', adjustCtxMenuPosition);
  }, [ctxMenu, adjustCtxMenuPosition]);

  return (
    <>
    <div ref={containerRef} className={`file-nav${isSidebarMode ? ' sidebar-mode' : ''} ${!fileTreeVisible ? 'collapsed' : ''}`} style={{ width, display: isSsh ? 'none' : undefined }}>
      <div className="panel-titlebar">
        <span className="panel-title">文件与 Git</span>
        <div className="file-nav-actions">
          <button
            type="button"
            className={showRootPicker ? 'active' : ''}
            onClick={() => setShowRootPicker(value => !value)}
            title="添加文件夹"
            aria-label="添加文件夹"
            aria-expanded={showRootPicker}
            aria-haspopup="dialog"
          >
            <Plus aria-hidden="true" />
          </button>
          <button type="button" onClick={handleCollapseAll} title="全部折叠" aria-label="折叠所有目录" disabled={rootDirectories.length === 0}>
            <ListChevronsDownUp aria-hidden="true" />
          </button>
          <button type="button" onClick={() => handleManualRefresh()} title="刷新" aria-label="刷新文件列表" disabled={rootDirectories.length === 0}>
            <RefreshCw aria-hidden="true" />
          </button>
          <button type="button" className="file-nav-sort-direction" onClick={toggleSortDir} title={`方向：${fileSortDir === 'asc' ? '升序' : '降序'}（点击翻转）`} aria-label={`切换为${fileSortDir === 'asc' ? '降序' : '升序'}`} disabled={rootDirectories.length === 0}>
            {fileSortDir === 'asc' ? <ArrowUp aria-hidden="true" /> : <ArrowDown aria-hidden="true" />}
          </button>
          <button type="button" className="file-nav-sort-field" onClick={cycleSortField} title={`排序：${sortLabel(fileSortBy)}（点击切换）`} disabled={rootDirectories.length === 0}>
            {sortLabel(fileSortBy)}
          </button>
        </div>
      </div>
      {showRootPicker && (
        <Dialog
          title={(
            <span className="file-root-dialog-title">
              <span>添加文件夹</span>
              <span className="file-root-picker-count">{availableDirectories.length}</span>
            </span>
          )}
          className="file-root-dialog"
          bodyClassName="file-root-dialog-body"
          onClose={() => {
            setShowRootPicker(false);
            setCustomPathInput('');
            setCustomPathError(null);
          }}
        >
          <div className="file-root-custom-path">
            <input
              ref={customPathInputRef}
              type="text"
              className="file-root-custom-path-input"
              placeholder="自定义路径，如 C:\projects\foo"
              value={customPathInput}
              onChange={(e) => {
                setCustomPathInput(e.target.value);
                if (customPathError) setCustomPathError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void handleAddCustomPath();
                }
              }}
              aria-label="自定义路径"
              spellCheck={false}
              autoFocus
            />
            <button
              type="button"
              className="file-root-custom-path-browse"
              onClick={() => void handleBrowseCustomPath()}
              disabled={customPathBusy}
              title="浏览选择文件夹"
            >
              浏览...
            </button>
            <button
              type="button"
              className="file-root-custom-path-add"
              onClick={() => void handleAddCustomPath()}
              disabled={!customPathInput.trim() || customPathBusy}
            >
              添加
            </button>
            {customPathError && (
              <div className="file-root-custom-path-error" role="alert">
                {customPathError}
              </div>
            )}
          </div>
          <div className="file-root-picker-list">
            {availableDirectories.map(path => (
              <button
                key={path.toLowerCase()}
                type="button"
                className="file-root-option"
                onClick={() => handleAddRoot(path)}
                title={path}
              >
                <Folder className="file-root-option-icon" aria-hidden="true" />
                <span className="file-root-option-copy">
                  <strong>{directoryName(path)}</strong>
                  <span>{path}</span>
                </span>
                <Plus className="file-root-option-add" aria-hidden="true" />
              </button>
            ))}
            {availableDirectories.length === 0 && (
              <div className="file-root-picker-empty">
                {configuredDirectories.length === 0 ? '暂无可添加的文件夹' : '所有文件夹均已添加'}
              </div>
            )}
          </div>
        </Dialog>
      )}
      {/* 控制器按仓库常驻；面板隐藏仅隐藏工具栏，不丢失进行中的任务与结果。 */}
      <GitOperationsHost
        ref={gitNavRef}
        currentDirectory={isSsh ? '' : gitTargetDirectory}
        visible={fileTreeVisible && rootDirectories.length > 0 && !isSsh}
        onRepositoryChanged={handleRefresh}
      />
      {rootDirectories.length > 0 && !focusedRootPath && (
        <div className="file-nav-filter">
          <input
            className="filter-input"
            placeholder="过滤父级目录…"
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
            aria-label="过滤父级目录"
          />
        </div>
      )}
      <div
        ref={contentRef}
        className={`file-nav-content ${rootDirectories.length === 0 ? 'empty' : ''}`}
        onContextMenu={(e) => {
          const target = e.target as HTMLElement;
          if (target.closest('.tree-item')) return;
          e.preventDefault();
          const contextDirectory = selectedVisibleRoot || (rootDirectories.length > 0 ? gitTargetDirectory : '');
          setCtxMenu({ x: e.clientX, y: e.clientY, dir: contextDirectory || undefined });
        }}
      >
        {rootDirectories.length === 0 && (
          <div className="file-nav-empty-state">
            <FolderPlus className="file-nav-empty-icon" aria-hidden="true" />
            <span>暂无文件夹</span>
            <button type="button" onClick={() => setShowRootPicker(true)}>
              <Plus aria-hidden="true" />
              添加文件夹
            </button>
          </div>
        )}
        {rootDirectories.length > 0 && !focusedRootPath && visibleConfiguredDirectories.length === 0 && (
          <div className="empty-hint">无匹配目录</div>
        )}
        {displayedRootDirectories.map(path => (
          <ConfiguredFileRoot
            key={path.toLowerCase()}
            path={path}
            initiallyExpanded={autoExpandedRootPath?.toLowerCase() === path.toLowerCase()}
            autoExpandToken={autoExpandedRootPath?.toLowerCase() === path.toLowerCase()
              ? `${activeSpecialTab ?? activeSessionId}:${claudeReplayTab?.sessionId ?? ''}` : undefined}
            refreshVersion={rootRefreshVersion}
            collapseVersion={rootCollapseVersion}
            sortBy={fileSortBy}
            sortDir={fileSortDir}
            selectedPath={selectedPath}
            onActivate={activateTreeDirectory}
            onSelect={handleSelect}
            onNavigate={handleNavigate}
            onContextMenu={handleContextMenu}
            onRootContextMenu={handleRootContextMenu}
            onExpandedChange={handleRootExpandedChange}
            onRename={handleRenameInline}
            renamingPath={renamingPath}
            setRenamingPath={setRenamingPath}
          />
        ))}
      </div>
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
          <div className="context-menu-item" onClick={() => { setCtxMenu(null); handleManualRefresh(gitContextTarget || gitTargetDirectory); }}>
            刷新
          </div>
          {contextGitStatus && (
            <>
              <div className="context-menu-separator" />
              {renderGitContextItem('refresh', '刷新 Git 状态')}
              {renderGitContextItem('branches', '切换分支…')}
              {renderGitContextItem('commit', '提交变更…')}
              {renderGitContextItem('pull', '拉取最新代码', true)}
              {renderGitContextItem('push', '推送…', true)}
              {renderGitContextItem('history', 'Git 历史记录')}
              {contextOperation && renderGitContextItem('operation', '查看 Git 操作进度…')}
            </>
          )}
          {!ctxMenu.path && ctxMenu.dir && (
            <>
              <div className="context-menu-separator" />
              <div className="context-menu-item" onClick={async () => {
                const dir = ctxMenu.dir!;
                setCtxMenu(null);
                try { await openTerminalInDir(dir); } catch (err) { console.error(err); }
              }}>
                在当前目录打开命令窗口
              </div>
              {supportsSystemExplorerOpen() && (
                <div className="context-menu-item" onClick={() => handleShowCurrentDirInExplorer(ctxMenu.dir)}>
                  在文件资源管理器中显示
                </div>
              )}
              {canDownloadToBrowser() && (
                <div className="context-menu-item" onClick={() => startBrowserDownload(ctxMenu.dir!)}>
                  下载文件夹（ZIP）
                </div>
              )}
              {ctxMenu.root && (
                <>
                  <div className="context-menu-separator" />
                  <div className="context-menu-item danger" onClick={() => handleRemoveRoot(ctxMenu.dir!)}>
                    从文件列表中删除
                  </div>
                </>
              )}
            </>
          )}
          {ctxMenu.path && (
            <>
              <div className="context-menu-separator" />
              {canDownloadToBrowser() && (
                <div className="context-menu-item" onClick={() => startBrowserDownload(ctxMenu.path!)}>
                  {ctxMenu.isDir ? '下载文件夹（ZIP）' : '下载'}
                </div>
              )}
              {supportsSystemExplorerOpen() && (
                <div className="context-menu-item" onClick={handleShowInExplorer}>
                  在文件资源管理器中显示
                </div>
              )}
              {!ctxMenu.isDir && supportsSystemExplorerOpen() && (
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

      {confirmDelete && !isSsh && (
        <ConfirmDialog
          title="确认删除"
          message={`确定删除 "${confirmDelete}" 吗？`}
          onClose={cancelDeleteItem}
          onConfirm={confirmDeleteItem}
          confirmText="删除"
        />
      )}
    </div>
    {isSsh && activeSession && <RemoteFileTree terminalId={activeSession.id} />}
    </>
  );
};
