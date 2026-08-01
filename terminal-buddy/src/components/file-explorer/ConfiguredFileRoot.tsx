import { useState, useEffect, useCallback, useRef, useMemo, useLayoutEffect, type FC } from 'react';
import { ChevronRight, Folder, FolderOpen } from 'lucide-react';
import { listDirectory } from '../../services/tauri';
import type { FileNode } from '../../services/tauri';
import { TreeNode } from './TreeNode';
import { compareNodes, scrollFileTreeItemToTop, directoryName, DIRECTORY_RENDER_PAGE_SIZE } from './file-utils';
import { useAppStore } from '../../stores/appStore';

export interface ConfiguredFileRootProps {
  path: string;
  refreshVersion: number;
  collapseVersion: number;
  sortBy: 'name' | 'size' | 'modified';
  sortDir: 'asc' | 'desc';
  selectedPath: string | null;
  onActivate: (path: string) => void;
  onSelect: (path: string) => void;
  onNavigate: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, path: string, isDir: boolean) => void;
  onRootContextMenu: (e: React.MouseEvent, path: string) => void;
  onExpandedChange: (path: string, expanded: boolean) => void;
  onRename: (path: string, newName: string) => Promise<void>;
  renamingPath: string | null;
  setRenamingPath: (path: string | null) => void;
}

export const ConfiguredFileRoot: FC<ConfiguredFileRootProps> = ({
  path,
  refreshVersion,
  collapseVersion,
  sortBy,
  sortDir,
  selectedPath,
  onActivate,
  onSelect,
  onNavigate,
  onContextMenu,
  onRootContextMenu,
  onExpandedChange,
  onRename,
  renamingPath,
  setRenamingPath,
}) => {
  const exclusionPatterns = useAppStore(s => s.exclusionPatterns);
  const [expanded, setExpanded] = useState(false);
  const [nodes, setNodes] = useState<FileNode[]>([]);
  const [visibleNodeCount, setVisibleNodeCount] = useState(DIRECTORY_RENDER_PAGE_SIZE);
  const [loading, setLoading] = useState(false);
  const [pathError, setPathError] = useState(false);
  const itemRef = useRef<HTMLDivElement>(null);
  const pinToTopAfterLoadRef = useRef(false);

  useEffect(() => {
    pinToTopAfterLoadRef.current = false;
    setExpanded(false);
  }, [collapseVersion]);

  useEffect(() => {
    if (!expanded) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setVisibleNodeCount(DIRECTORY_RENDER_PAGE_SIZE);

    listDirectory(path, exclusionPatterns)
      .then((entries) => {
        if (cancelled) return;
        setNodes(entries);
        setVisibleNodeCount(DIRECTORY_RENDER_PAGE_SIZE);
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
    const nextExpanded = !expanded;
    setExpanded(nextExpanded);
    onExpandedChange(path, nextExpanded);
  }, [expanded, onExpandedChange, path]);

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
        aria-label={`${name}，${path}，${expanded ? '已展开' : '已折叠'}`}
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
          <strong className="file-nav-root-name">{name}</strong>
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
          {!loading && sortedNodes.slice(0, visibleNodeCount).map((node) => (
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
          {!loading && visibleNodeCount < sortedNodes.length && (
            <button
              type="button"
              className="tree-load-more"
              onClick={() => setVisibleNodeCount(count => count + DIRECTORY_RENDER_PAGE_SIZE)}
            >
              显示更多（剩余 {sortedNodes.length - visibleNodeCount} 项）
            </button>
          )}
        </div>
      )}
    </div>
  );
};
