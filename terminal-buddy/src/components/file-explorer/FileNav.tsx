import { FC, useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo } from 'react';
import { ArrowDown, ArrowUp, Folder, FolderPlus, ListChevronsDownUp, Plus, RefreshCw } from 'lucide-react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { listDirectory, openPath, openInExplorer, deletePath, renamePath, saveConfigNavWidth, saveFileNavWidth, getBackendAppSettings } from '../../services/tauri';
import { useAppStore } from '../../stores/appStore';
import { openTerminalInDir } from '../../utils/openTerminalInDir';
import { fitContextMenuToViewport } from '../../utils/contextMenu';
import { notifyTerminalPanelResize } from '../../utils/terminalResizeEvent';
import { showAlert } from '../../services/dialog';
import { GitNavBar } from '../git/GitNavBar';
import { RemoteFileTree } from './RemoteFileTree';
import { ConfirmDialog, Dialog } from '../shared/Dialog';
import './FileNav.css';

import { ConfiguredFileRoot } from './ConfiguredFileRoot';
import { sortLabel, directoryName, normalizeConfiguredPath, isPathEqualOrInside, replacePathPrefix } from './file-utils';

interface FileNavProps {
  isSidebarMode: boolean;
}

export const FileNav: FC<FileNavProps> = ({ isSidebarMode }) => {
  const currentDirectory = useAppStore(s => s.currentDirectory);
  const fileSortBy = useAppStore(s => s.fileSortBy);
  const fileSortDir = useAppStore(s => s.fileSortDir);
  const setFileSort = useAppStore(s => s.setFileSort);
  const activeSessionId = useAppStore(s => s.activeSessionId);
  const sessionDirectories = useAppStore(s => s.sessionDirectories);
  const sessions = useAppStore(s => s.sessions);
  const profiles = useAppStore(s => s.profiles);
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
  const [rootRefreshVersion, setRootRefreshVersion] = useState(0);
  const [rootCollapseVersion, setRootCollapseVersion] = useState(0);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; path?: string; isDir?: boolean; dir?: string; root?: boolean } | null>(null);
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
    for (const profile of profiles) {
      if (profile.terminalType !== 'powershell' && profile.terminalType !== 'pwsh' && profile.terminalType !== 'cmd') continue;
      const path = normalizeConfiguredPath(profile.startupPath || '');
      if (!path) continue;
      const key = path.toLowerCase();
      if (!uniquePaths.has(key)) uniquePaths.set(key, path);
    }
    return [...uniquePaths.values()];
  }, [profiles]);

  const rootDirectories = useMemo(() => {
    const seen = new Set<string>();
    return fileRoots
      .map(normalizeConfiguredPath)
      .filter(path => {
        const key = path.toLowerCase();
        if (!path || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }, [fileRoots]);

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
  const displayedRootDirectories = useMemo(() => {
    if (!focusedRootPath) return visibleConfiguredDirectories;
    const focusedRoot = rootDirectories.find(path => path.toLowerCase() === focusedRootPath.toLowerCase());
    return focusedRoot ? [focusedRoot] : visibleConfiguredDirectories;
  }, [focusedRootPath, rootDirectories, visibleConfiguredDirectories]);
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
    if (!fileTreeVisible) setShowRootPicker(false);
  }, [fileTreeVisible]);

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

  const handleCollapseAll = useCallback(() => {
    setFocusedRootPath(null);
    setRootCollapseVersion(version => version + 1);
    contentRef.current?.scrollTo({ top: 0, behavior: 'auto' });
  }, []);

  const handleRootExpandedChange = useCallback((path: string, expanded: boolean) => {
    setFocusedRootPath(expanded ? path : null);
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

  const handleRenameInline = useCallback(async (path: string, newName: string) => {
    try {
      await renamePath(path, newName);
      const parent = path.substring(0, path.lastIndexOf('\\'));
      const renamedPath = parent + '\\' + newName;
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
    <div ref={containerRef} className={`file-nav${isSidebarMode ? ' sidebar-mode' : ''} ${!fileTreeVisible ? 'collapsed' : ''}`} style={{ width }}>
      <div className="panel-titlebar">
        <span className="panel-title">文件</span>
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
          <button type="button" onClick={handleRefresh} title="刷新" aria-label="刷新文件列表" disabled={rootDirectories.length === 0}>
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
      {/* Git 状态只服务于当前打开的目录。文件导航隐藏时一并卸载状态栏并停止轮询，
          避免为所有已配置目录持续创建 git.exe 进程。 */}
      {fileTreeVisible && rootDirectories.length > 0 && (
        <GitNavBar
          key={gitTargetDirectory.toLowerCase() || 'none'}
          currentDirectory={gitTargetDirectory}
          onRepositoryChanged={handleRefresh}
        />
      )}
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
          setCtxMenu({ x: e.clientX, y: e.clientY, dir: selectedVisibleRoot || undefined });
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
          <div className="context-menu-item" onClick={() => { setCtxMenu(null); handleRefresh(); }}>
            刷新
          </div>
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
              <div className="context-menu-item" onClick={() => handleShowCurrentDirInExplorer(ctxMenu.dir)}>
                在文件资源管理器中显示
              </div>
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
        <ConfirmDialog
          title="确认删除"
          message={`确定删除 "${confirmDelete}" 吗？`}
          onClose={cancelDeleteItem}
          onConfirm={confirmDeleteItem}
          confirmText="删除"
        />
      )}
    </div>
  );
};
