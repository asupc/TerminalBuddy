import { useState, useEffect, useRef, useCallback, useLayoutEffect, type FC } from 'react';
import { File, Folder } from 'lucide-react';
import type { FileNode } from '../../services/tauri';
import { isTextFile } from '../../utils/fileExtensions';
import { DIRECTORY_RENDER_PAGE_SIZE, scrollFileTreeItemToTop } from './file-utils';
import { listDirectory, openPath, getFileSize } from '../../services/tauri';
import { useAppStore } from '../../stores/appStore';
import { getAppSettings } from '../../utils/settings';
import { showAlert } from '../../services/dialog';

export interface TreeNodeProps {
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



export const TreeNode: FC<TreeNodeProps> = ({ node, depth, parentPath, selectedPath, onActivate, onSelect, onNavigate, onContextMenu, onRename, renamingPath, setRenamingPath }) => {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FileNode[]>([]);
  const [visibleChildCount, setVisibleChildCount] = useState(DIRECTORY_RENDER_PAGE_SIZE);
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
        setVisibleChildCount(DIRECTORY_RENDER_PAGE_SIZE);
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
          setVisibleChildCount(DIRECTORY_RENDER_PAGE_SIZE);
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
          void showAlert('文件过大，无法在编辑器中打开（超过 1MB）');
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
          {children.slice(0, visibleChildCount).map((child) => (
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
          {visibleChildCount < children.length && (
            <button
              type="button"
              className="tree-load-more"
              onClick={() => setVisibleChildCount(count => count + DIRECTORY_RENDER_PAGE_SIZE)}
            >
              显示更多（剩余 {children.length - visibleChildCount} 项）
            </button>
          )}
        </div>
      )}
    </div>
  );
};
