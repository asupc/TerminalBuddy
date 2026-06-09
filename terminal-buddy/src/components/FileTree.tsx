import { FC, useState, useEffect, useCallback, useRef } from 'react';
import { listDirectory, openPath, openInExplorer, startBlankTerminal, deletePath, renamePath, writeToTerminal, getFileSize, type FileNode } from '../services/tauri';
import { useAppStore } from '../stores/appStore';
import { isTextFile } from '../utils/fileExtensions';
import { RemoteFileTree } from './RemoteFileTree';
import './FileTree.css';

interface TreeNodeProps {
  node: FileNode;
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  onNavigate: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, path: string, isDir: boolean) => void;
  onRename: (path: string, newName: string) => Promise<void>;
  renamingPath: string | null;
  setRenamingPath: (path: string | null) => void;
}

const TreeNode: FC<TreeNodeProps> = ({ node, depth, selectedPath, onSelect, onNavigate, onContextMenu, onRename, renamingPath, setRenamingPath }) => {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FileNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const itemRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const exclusionPatterns = useAppStore(s => s.exclusionPatterns);
  const setDragPaths = useAppStore(s => s.setDragPaths);

  const isSelected = selectedPath === node.path;

  const handleClick = useCallback((e: React.MouseEvent) => {
    onSelect(node.path);
    if (node.is_directory) {
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
    }
    (e.currentTarget as HTMLElement).focus();
  }, [node.path, node.is_directory, expanded, exclusionPatterns, onSelect]);

  const handleArrowClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (!node.is_directory) return;
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
    } else if (isTextFile(node.path)) {
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
  }, [node.is_directory, node.path, onNavigate]);

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
          {node.is_directory ? '📁' : '📄'}
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
              selectedPath={selectedPath}
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

export const FileTree: FC = () => {
  const currentDirectory = useAppStore(s => s.currentDirectory);
  const setCurrentDirectory = useAppStore(s => s.setCurrentDirectory);
  const setSessionDirectory = useAppStore(s => s.setSessionDirectory);
  const activeSessionId = useAppStore(s => s.activeSessionId);
  const fileTreeVisible = useAppStore(s => s.fileTreeVisible);
  const bookmarks = useAppStore(s => s.bookmarks);
  const addBookmark = useAppStore(s => s.addBookmark);
  const removeBookmark = useAppStore(s => s.removeBookmark);
  const renameBookmark = useAppStore(s => s.renameBookmark);
  const exclusionPatterns = useAppStore(s => s.exclusionPatterns);
  const [rootNodes, setRootNodes] = useState<FileNode[]>([]);
  const [width, setWidth] = useState(250);
  const [isResizing, setIsResizing] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [pathError, setPathError] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; path?: string; isDir?: boolean } | null>(null);
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
  const inputRef = useRef<HTMLInputElement>(null);
  const rafRef = useRef<number | null>(null);

  // Load root directory on mount
  useEffect(() => {
    const loadRoot = async () => {
      try {
        const defaultPath = 'C:\\';
        const entries = await listDirectory(defaultPath, exclusionPatterns);
        setRootNodes(entries);
        if (!currentDirectory) {
          setCurrentDirectory(defaultPath);
        }
      } catch (err) {
        console.error('Failed to load root directory:', err);
      }
    };
    loadRoot();
  }, [exclusionPatterns]);

  const navigateTo = useCallback((path: string) => {
    setCurrentDirectory(path);
    if (activeSessionId) {
      setSessionDirectory(activeSessionId, path);
    }
  }, [setCurrentDirectory, setSessionDirectory, activeSessionId]);

  const openTerminalInDir = useCallback(async (dir: string) => {
    const content = document.querySelector('.terminal-content');
    let estRows = 0, estCols = 0;
    if (content) {
      estCols = Math.max(2, Math.floor((content.clientWidth - 20) / 8.4));
      estRows = Math.max(1, Math.floor((content.clientHeight - 20) / 17));
    }
    const terminalId = await startBlankTerminal('powershell', estRows, estCols);
    useAppStore.getState().addSession({
      id: terminalId,
      profileId: '',
      profileName: 'PowerShell',
      terminalType: 'powershell',
      colorTheme: { background: '#1E1E1E', foreground: '#CCCCCC' },
      tabColor: null,
      groupId: 'default',
    });
    setSessionDirectory(terminalId, dir);
    const sendCdWithRetry = (retries = 5) => {
      writeToTerminal(terminalId, `cd "${dir}"\r`).catch(() => {
        if (retries > 0) {
          setTimeout(() => sendCdWithRetry(retries - 1), 200);
        }
      });
    };
    setTimeout(sendCdWithRetry, 100);
  }, [setSessionDirectory]);

  // Load directory when currentDirectory changes
  useEffect(() => {
    if (!currentDirectory) return;

    const loadDirectory = async () => {
      try {
        const entries = await listDirectory(currentDirectory, exclusionPatterns);
        setRootNodes(entries);
        setPathError(false);
      } catch (err) {
        console.error('Failed to load directory:', err);
        setPathError(true);
      }
    };
    loadDirectory();
  }, [currentDirectory, exclusionPatterns]);

  const handleSelect = useCallback((path: string) => {
    setSelectedPath(path);
  }, []);

  const handleNavigate = useCallback((path: string) => {
    navigateTo(path);
  }, [navigateTo]);

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
        }
      }
    });
  }, [isResizing]);

  const handleMouseUp = useCallback(() => {
    setIsResizing(false);
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
    }
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

  const handleRefresh = async () => {
    if (!currentDirectory) return;
    try {
      const entries = await listDirectory(currentDirectory, exclusionPatterns);
      setRootNodes(entries);
    } catch (err) {
      console.error('Failed to refresh:', err);
    }
  };

  const handleGoUp = async () => {
    if (!currentDirectory) return;
    const parent = currentDirectory.substring(0, currentDirectory.lastIndexOf('\\'));
    if (parent.length >= 3) {
      navigateTo(parent);
    }
  };

  const handlePathDoubleClick = () => {
    setIsEditing(true);
    setEditValue(currentDirectory);
    setTimeout(() => {
      inputRef.current?.select();
    }, 0);
  };

  const handlePathSubmit = () => {
    const path = editValue.trim();
    if (!path) {
      setIsEditing(false);
      return;
    }
    let normalizedPath = path.replace(/\//g, '\\');
    if (!normalizedPath.endsWith('\\')) {
      normalizedPath += '\\';
    }
    listDirectory(normalizedPath, exclusionPatterns).then(() => {
      setPathError(false);
      navigateTo(normalizedPath);
      setIsEditing(false);
    }).catch(() => {
      setPathError(true);
    });
  };

  const handlePathKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handlePathSubmit();
    } else if (e.key === 'Escape') {
      setIsEditing(false);
      setPathError(false);
    }
  };

  const handleContextMenu = useCallback((e: React.MouseEvent, path: string, isDir: boolean) => {
    e.preventDefault();
    e.stopPropagation();
    setSelectedPath(path);
    setCtxMenu({ x: e.clientX, y: e.clientY, path, isDir });
  }, []);

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

  const handleShowCurrentDirInExplorer = useCallback(async () => {
    if (!currentDirectory) return;
    try { await openInExplorer(currentDirectory); } catch (err) { console.error(err); }
    setCtxMenu(null);
  }, [currentDirectory]);

  const handleDeleteItem = useCallback(() => {
    setConfirmDelete(ctxMenu?.path || null);
    setCtxMenu(null);
  }, [ctxMenu]);

  const confirmDeleteItem = useCallback(async () => {
    if (!confirmDelete) return;
    try {
      await deletePath(confirmDelete);
      const entries = await listDirectory(currentDirectory, exclusionPatterns);
      setRootNodes(entries);
    } catch (err) {
      console.error(err);
      alert('删除失败: ' + String(err));
    }
    setConfirmDelete(null);
  }, [confirmDelete, currentDirectory, exclusionPatterns]);

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
      const entries = await listDirectory(currentDirectory, exclusionPatterns);
      setRootNodes(entries);
      const parent = path.substring(0, path.lastIndexOf('\\'));
      setSelectedPath(parent + '\\' + newName);
    } catch (err) {
      console.error(err);
      alert('重命名失败: ' + String(err));
    }
    setRenamingPath(null);
  }, [currentDirectory, exclusionPatterns]);

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

  const sessions = useAppStore(s => s.sessions);
  const activeTerminalId = useAppStore(s => s.activeSessionId);
  const activeSession = sessions.find(s => s.id === activeTerminalId);
  const isSsh = activeSession?.terminalType === 'ssh';

  if (isSsh && activeSession) {
    return <RemoteFileTree terminalId={activeSession.id} />;
  }

  return (
    <div ref={containerRef} className={`file-tree ${!fileTreeVisible ? 'collapsed' : ''}`} style={{ width }}>
      <div className="panel-titlebar">
        <span className="panel-title">文件导航</span>
        <div className="file-tree-actions">
          <button onClick={handleGoUp} title="上级目录">⬆</button>
          <button onClick={handleRefresh} title="刷新">↻</button>
        </div>
      </div>
      <div className={`file-tree-path ${pathError ? 'error' : ''}`}>
        {isEditing ? (
          <input
            ref={inputRef}
            className="path-edit-input"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={handlePathSubmit}
            onKeyDown={handlePathKeyDown}
            autoFocus
          />
        ) : (
          <span onDoubleClick={handlePathDoubleClick} title="双击编辑路径">
            {currentDirectory || '无路径'}
          </span>
        )}
        {pathError && <span className="path-error">路径不存在</span>}
      </div>
      <div
        className="file-tree-content"
        onContextMenu={(e) => {
          const target = e.target as HTMLElement;
          if (target.closest('.tree-item')) return;
          e.preventDefault();
          setCtxMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        {rootNodes.map((node) => (
          <TreeNode
            key={node.path}
            node={node}
            depth={0}
            selectedPath={selectedPath}
            onSelect={handleSelect}
            onNavigate={handleNavigate}
            onContextMenu={handleContextMenu}
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
                const newH = Math.max(32, Math.min(300, startH - (ev.clientY - startY)));
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
              onClick={() => { if (!renamingBookmark || renamingBookmark !== bm.path) navigateTo(bm.path); }}
              onContextMenu={(e) => {
                e.preventDefault();
                setBookmarkCtxMenu({ x: e.clientX, y: e.clientY, path: bm.path });
              }}
              title={bm.path}
            >
              <span className="bookmark-icon">📁</span>
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
                ×
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
          className="context-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="context-menu-item" onClick={() => { setCtxMenu(null); handleRefresh(); }}>
            刷新
          </div>
          <div className="context-menu-item" onClick={() => { setCtxMenu(null); handleGoUp(); }}>
            上一级目录
          </div>
          {!ctxMenu.path && currentDirectory && (
            <>
              <div className="context-menu-separator" />
              <div className="context-menu-item" onClick={async () => {
                const dir = currentDirectory;
                setCtxMenu(null);
                try { await openTerminalInDir(dir); } catch (err) { console.error(err); }
              }}>
                在当前目录打开命令窗口
              </div>
              <div className="context-menu-item" onClick={() => {
                const name = currentDirectory.split('\\').filter(Boolean).pop() || currentDirectory;
                addBookmark(name, currentDirectory);
                setCtxMenu(null);
              }}>
                添加到书签
              </div>
              <div className="context-menu-item" onClick={handleShowCurrentDirInExplorer}>
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
