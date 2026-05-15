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
}

const TreeNode: FC<TreeNodeProps> = ({ node, depth, selectedPath, onSelect, onNavigate, onContextMenu }) => {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FileNode[]>([]);
  const [loading, setLoading] = useState(false);
  const itemRef = useRef<HTMLDivElement>(null);

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
      listDirectory(node.path).then((entries) => {
        setChildren(entries);
        setLoading(false);
      }).catch((err) => {
        console.error('Failed to load directory:', err);
        setLoading(false);
      });
    }
    setExpanded(!expanded);
  }, [node.path, node.is_directory, expanded]);

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
  }, [node.path]);

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
        <span className="tree-name">{node.name}</span>
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
            />
          ))}
        </div>
      )}
    </div>
  );
};

export const FileTree: FC = () => {
  const { currentDirectory, setCurrentDirectory, fileTreeVisible, bookmarks, addBookmark, removeBookmark } = useAppStore();
  const [rootNodes, setRootNodes] = useState<FileNode[]>([]);
  const [width, setWidth] = useState(250);
  const [isResizing, setIsResizing] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [pathError, setPathError] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; path: string; isDir: boolean } | null>(null);
  const [bookmarksExpanded, setBookmarksExpanded] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const rafRef = useRef<number | null>(null);

  // Load root directory on mount
  useEffect(() => {
    const loadRoot = async () => {
      try {
        const defaultPath = 'C:\\';
        const entries = await listDirectory(defaultPath);
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
        const entries = await listDirectory(currentDirectory);
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
      const entries = await listDirectory(currentDirectory);
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
    listDirectory(normalizedPath).then(() => {
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
    if (!ctxMenu) return;
    try { await openInExplorer(ctxMenu.path); } catch (err) { console.error(err); }
    setCtxMenu(null);
  }, [ctxMenu]);

  const handleCdToDir = useCallback(async () => {
    if (!ctxMenu) return;
    const { activeSessionId } = useAppStore.getState();
    if (activeSessionId) {
      try {
        await writeToTerminal(activeSessionId, `cd "${ctxMenu.path}"\r`);
      } catch (err) { console.error(err); }
    }
    setCurrentDirectory(ctxMenu.path);
    setCtxMenu(null);
  }, [ctxMenu, setCurrentDirectory]);

  const handleDeleteItem = useCallback(async () => {
    if (!ctxMenu) return;
    if (!window.confirm(`确定删除 "${ctxMenu.path}" 吗？`)) return;
    try {
      await deletePath(ctxMenu.path);
      // Refresh current directory
      const entries = await listDirectory(currentDirectory);
      setRootNodes(entries);
    } catch (err) {
      console.error(err);
      alert('删除失败: ' + String(err));
    }
    setCtxMenu(null);
  }, [ctxMenu, currentDirectory]);

  const handleRenameItem = useCallback(async () => {
    if (!ctxMenu) return;
    const newName = window.prompt('请输入新名称:', ctxMenu.path.split('\\').pop() || '');
    if (!newName) { setCtxMenu(null); return; }
    try {
      await renamePath(ctxMenu.path, newName);
      const entries = await listDirectory(currentDirectory);
      setRootNodes(entries);
      // Update selection to new path
      const parent = ctxMenu.path.substring(0, ctxMenu.path.lastIndexOf('\\'));
      setSelectedPath(parent + '\\' + newName);
    } catch (err) {
      console.error(err);
      alert('重命名失败: ' + String(err));
    }
    setCtxMenu(null);
  }, [ctxMenu, currentDirectory]);

  // Close context menu on outside click
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
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
                if (confirm(`删除书签"${bm.name}"？`)) {
                  removeBookmark(bm.path);
                }
              }}
              title={bm.path}
            >
              <span className="bookmark-icon">📁</span>
              <span className="bookmark-name">{bm.name}</span>
            </div>
          ))}
        </div>
      )}
      <div className="file-tree-header">
        <span className="file-tree-title">文件导航</span>
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
      <div className="file-tree-content">
        {rootNodes.map((node) => (
          <TreeNode
            key={node.path}
            node={node}
            depth={0}
            selectedPath={selectedPath}
            onSelect={handleSelect}
            onNavigate={handleNavigate}
            onContextMenu={handleContextMenu}
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
              const name = ctxMenu.path.split('\\').pop() || ctxMenu.path;
              addBookmark(name, ctxMenu.path);
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
        </div>
      )}
    </div>
  );
};
