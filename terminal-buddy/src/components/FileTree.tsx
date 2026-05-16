import { FC, useState, useEffect, useCallback, useRef } from 'react';
import { listDirectory, openPath, openInExplorer, deletePath, renamePath, writeToTerminal, type FileNode } from '../services/tauri';
import { useAppStore } from '../stores/appStore';
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

  const isSelected = selectedPath === node.path;

  const handleClick = useCallback((e: React.MouseEvent) => {
    onSelect(node.path);
    (e.currentTarget as HTMLElement).focus();
  }, [node.path, onSelect]);

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
    } else {
      openPath(node.path).catch((err) => console.error('Failed to open file:', err));
    }
  }, [node.is_directory, node.path, onNavigate]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'c' && e.ctrlKey && !e.shiftKey) {
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
  const { currentDirectory, setCurrentDirectory, fileTreeVisible, bookmarks, addBookmark, removeBookmark, exclusionPatterns } = useAppStore();
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
  const [bookmarksExpanded, setBookmarksExpanded] = useState(true);
  const [confirmBookmarkDelete, setConfirmBookmarkDelete] = useState<string | null>(null);
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
  }, []);

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
  }, [currentDirectory]);

  const handleSelect = useCallback((path: string) => {
    setSelectedPath(path);
  }, []);

  const handleNavigate = useCallback((path: string) => {
    setCurrentDirectory(path);
  }, [setCurrentDirectory]);

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
      setCurrentDirectory(parent);
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
      setCurrentDirectory(normalizedPath);
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

  const handleCdToDir = useCallback(async () => {
    if (!ctxMenu?.path) return;
    const { activeSessionId } = useAppStore.getState();
    if (activeSessionId) {
      try {
        await writeToTerminal(activeSessionId, `cd "${ctxMenu.path}"\r`);
      } catch (err) { console.error(err); }
    }
    setCurrentDirectory(ctxMenu.path);
    setCtxMenu(null);
  }, [ctxMenu, setCurrentDirectory]);

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

  return (
    <div ref={containerRef} className={`file-tree ${!fileTreeVisible ? 'collapsed' : ''}`} style={{ width }}>
      {bookmarks.length > 0 && (
        <div className="bookmark-bar">
          <button
            className="bookmark-toggle"
            onClick={() => setBookmarksExpanded(!bookmarksExpanded)}
            title={bookmarksExpanded ? '收起书签' : '展开书签'}
          >
            {bookmarksExpanded ? '▼' : '▶'}
          </button>
          {bookmarksExpanded && bookmarks.map((bm) => (
            <div
              key={bm.path}
              className="bookmark-tag"
              onClick={() => setCurrentDirectory(bm.path)}
              onContextMenu={(e) => {
                e.preventDefault();
                setConfirmBookmarkDelete(bm.path);
              }}
              title={bm.path}
            >
              <span className="bookmark-icon">📁</span>
              <span className="bookmark-name">{bm.name}</span>
            </div>
          ))}
        </div>
      )}
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
          {ctxMenu.path && (
            <>
              <div className="context-menu-separator" />
              <div className="context-menu-item" onClick={handleShowInExplorer}>
                在文件资源管理器中显示
              </div>
              {ctxMenu.isDir && (
                <div className="context-menu-item" onClick={handleCdToDir}>
                  cd 到当前目录
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
    </div>
  );
};
