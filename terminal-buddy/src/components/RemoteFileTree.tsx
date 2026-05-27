import { FC, useState, useEffect, useCallback, useRef } from 'react';
import { useAppStore } from '../stores/appStore';
import {
  remoteListDir, remoteCreateDir, remoteCreateFile, remoteRemove,
  remoteRename, remoteMove, remoteCopy, remoteChmod, remoteUpload,
  remoteDownload, writeToTerminal, getSshTempDirectory, ensureDir,
} from '../services/tauri';
import { isTextFile } from '../utils/fileExtensions';
import { ChmodDialog } from './ChmodDialog';
import type { RemoteFileEntry } from '../types';
import './FileTree.css';

interface ContextMenuState {
  x: number;
  y: number;
  file?: RemoteFileEntry;
}

interface TransferProgress {
  terminalId: string;
  transferred: number;
  total: number;
  percent: number;
  direction: string;
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatPermissions(mode: number): string {
  const perms = [
    mode & 0o400 ? 'r' : '-',
    mode & 0o200 ? 'w' : '-',
    mode & 0o100 ? 'x' : '-',
    mode & 0o040 ? 'r' : '-',
    mode & 0o020 ? 'w' : '-',
    mode & 0o010 ? 'x' : '-',
    mode & 0o004 ? 'r' : '-',
    mode & 0o002 ? 'w' : '-',
    mode & 0o001 ? 'x' : '-',
  ];
  return (mode & 0o040000 ? 'd' : '-') + perms.join('');
}

function formatDate(timestamp: number): string {
  if (!timestamp) return '-';
  const d = new Date(timestamp * 1000);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface RemoteFileTreeProps {
  terminalId: string;
}

export const RemoteFileTree: FC<RemoteFileTreeProps> = ({ terminalId }) => {
  const [files, setFiles] = useState<RemoteFileEntry[]>([]);
  const [currentPath, setCurrentPath] = useState('/');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [renaming, setRenaming] = useState<RemoteFileEntry | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [creating, setCreating] = useState<'file' | 'dir' | null>(null);
  const [createValue, setCreateValue] = useState('');
  const [chmodFile, setChmodFile] = useState<RemoteFileEntry | null>(null);
  const [transferProgress, setTransferProgress] = useState<TransferProgress | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [width, setWidth] = useState(250);
  const [isResizing, setIsResizing] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const createInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const remoteClipboard = useAppStore(s => s.remoteClipboard);
  const setRemoteClipboard = useAppStore(s => s.setRemoteClipboard);
  const setSessionDirectory = useAppStore(s => s.setSessionDirectory);

  const loadDirectory = useCallback(async (path: string) => {
    setLoading(true);
    setError(null);
    try {
      const entries = await remoteListDir(terminalId, path);
      setFiles(entries);
      setCurrentPath(path);
      setSessionDirectory(terminalId, path);
    } catch (err) {
      console.error('Failed to list remote directory:', err);
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [terminalId, setSessionDirectory]);

  useEffect(() => {
    loadDirectory('/');
  }, [terminalId]);

  // Transfer progress listener
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    import('../services/tauri').then(mod => {
      mod.onTransferProgress((progress) => {
        if (progress.terminalId === terminalId) {
          setTransferProgress(progress);
          if (progress.percent >= 100) {
            setTimeout(() => setTransferProgress(null), 1500);
          }
        }
      }).then(fn => { unlisten = fn; });
    });
    return () => { unlisten?.(); };
  }, [terminalId]);

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    document.addEventListener('click', close);
    document.addEventListener('keydown', close);
    document.addEventListener('wheel', close);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', close);
      document.removeEventListener('wheel', close);
    };
  }, [contextMenu]);

  // Auto-focus rename/create inputs
  useEffect(() => {
    if (renaming) renameInputRef.current?.select();
  }, [renaming]);

  useEffect(() => {
    if (creating) createInputRef.current?.select();
  }, [creating]);

  // Breadcrumb segments
  const breadcrumbs = currentPath.split('/').filter(Boolean);

  const navigateToBreadcrumb = (index: number) => {
    const path = '/' + breadcrumbs.slice(0, index + 1).join('/');
    loadDirectory(path);
  };

  const handleGoUp = () => {
    if (currentPath === '/') return;
    const parts = currentPath.split('/').filter(Boolean);
    parts.pop();
    loadDirectory('/' + parts.join('/'));
  };

  const handleRefresh = () => {
    loadDirectory(currentPath);
  };

  const handleDoubleClick = (file: RemoteFileEntry) => {
    if (file.isDir) {
      loadDirectory(file.path);
    }
  };

  const handleContextMenu = (e: React.MouseEvent, file?: RemoteFileEntry) => {
    e.preventDefault();
    e.stopPropagation();
    if (file) setSelectedPath(file.path);
    setContextMenu({ x: e.clientX, y: e.clientY, file });
  };

  const handleOpen = (file: RemoteFileEntry) => {
    setContextMenu(null);
    if (file.isDir) {
      loadDirectory(file.path);
    } else {
      // cd to parent directory in terminal
      const parent = file.path.substring(0, file.path.lastIndexOf('/'));
      writeToTerminal(terminalId, `cd "${parent}"\r`).catch(console.error);
    }
  };

  const handleDownload = async (file: RemoteFileEntry) => {
    setContextMenu(null);
    try {
      const baseTempDir = await getSshTempDirectory();
      const tempDir = `${baseTempDir}/${terminalId}`;
      await ensureDir(tempDir);
      const localPath = `${tempDir}/${file.name}`;
      await remoteDownload(terminalId, file.path, localPath);
      // Open the file's directory in explorer
      const { openInExplorer } = await import('../services/tauri');
      await openInExplorer(localPath);
    } catch (err) {
      console.error('Download failed:', err);
      alert('下载失败: ' + String(err));
    }
  };

  const handleEdit = async (file: RemoteFileEntry) => {
    setContextMenu(null);
    try {
      const baseTempDir = await getSshTempDirectory();
      const tempDir = `${baseTempDir}/${terminalId}`;
      await ensureDir(tempDir);
      const localPath = `${tempDir}/${file.name}`;
      await remoteDownload(terminalId, file.path, localPath);
      useAppStore.getState().openEditorSession(localPath, file.path, terminalId);
    } catch (err) {
      console.error('Edit failed:', err);
      alert('打开编辑器失败: ' + String(err));
    }
  };

  const handleRename = (file: RemoteFileEntry) => {
    setContextMenu(null);
    setRenaming(file);
    setRenameValue(file.name);
  };

  const confirmRename = async () => {
    if (!renaming) return;
    const trimmed = renameValue.trim();
    if (!trimmed || trimmed === renaming.name) {
      setRenaming(null);
      return;
    }
    try {
      const parent = renaming.path.substring(0, renaming.path.lastIndexOf('/'));
      const newPath = `${parent}/${trimmed}`;
      await remoteRename(terminalId, renaming.path, newPath);
      await handleRefresh();
    } catch (err) {
      console.error('Rename failed:', err);
      alert('重命名失败: ' + String(err));
    }
    setRenaming(null);
  };

  const handleCopy = (file: RemoteFileEntry) => {
    setContextMenu(null);
    setRemoteClipboard({ items: [file.path], operation: 'copy' });
  };

  const handleMove = (file: RemoteFileEntry) => {
    setContextMenu(null);
    setRemoteClipboard({ items: [file.path], operation: 'move' });
  };

  const handlePaste = async () => {
    if (!remoteClipboard) return;
    setContextMenu(null);
    try {
      for (const item of remoteClipboard.items) {
        const name = item.split('/').pop() || item;
        const dest = `${currentPath}/${name}`;
        if (remoteClipboard.operation === 'copy') {
          await remoteCopy(terminalId, item, dest);
        } else {
          await remoteMove(terminalId, item, dest);
        }
      }
      if (remoteClipboard.operation === 'move') {
        setRemoteClipboard(null);
      }
      await handleRefresh();
    } catch (err) {
      console.error('Paste failed:', err);
      alert('粘贴失败: ' + String(err));
    }
  };

  const handleChmod = (file: RemoteFileEntry) => {
    setContextMenu(null);
    setChmodFile(file);
  };

  const confirmChmod = async (mode: number) => {
    if (!chmodFile) return;
    try {
      await remoteChmod(terminalId, chmodFile.path, mode);
      await handleRefresh();
    } catch (err) {
      console.error('Chmod failed:', err);
      alert('修改权限失败: ' + String(err));
    }
    setChmodFile(null);
  };

  const handleDelete = async (file: RemoteFileEntry) => {
    setContextMenu(null);
    if (!confirm(`确定删除 "${file.name}" 吗？`)) return;
    try {
      await remoteRemove(terminalId, file.path, file.isDir);
      await handleRefresh();
    } catch (err) {
      console.error('Delete failed:', err);
      alert('删除失败: ' + String(err));
    }
  };

  const handleCreate = (type: 'file' | 'dir') => {
    setContextMenu(null);
    setCreating(type);
    setCreateValue('');
  };

  const confirmCreate = async () => {
    if (!creating) return;
    const trimmed = createValue.trim();
    if (!trimmed) {
      setCreating(null);
      return;
    }
    try {
      const newPath = `${currentPath}/${trimmed}`;
      if (creating === 'dir') {
        await remoteCreateDir(terminalId, newPath);
      } else {
        await remoteCreateFile(terminalId, newPath);
      }
      await handleRefresh();
    } catch (err) {
      console.error('Create failed:', err);
      alert('创建失败: ' + String(err));
    }
    setCreating(null);
  };

  const handleUpload = () => {
    setContextMenu(null);
    fileInputRef.current?.click();
  };

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // With Tauri file input, the value is the file path
    const localPath = (file as any).path || file.name;
    const remotePath = `${currentPath}/${file.name}`;
    try {
      await remoteUpload(terminalId, localPath, remotePath);
      await handleRefresh();
    } catch (err) {
      console.error('Upload failed:', err);
      alert('上传失败: ' + String(err));
    }
    // Reset input
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // Resize handlers
  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  }, []);

  useEffect(() => {
    if (!isResizing) return;
    const handleMove = (e: MouseEvent) => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        if (containerRef.current) {
          const rect = containerRef.current.getBoundingClientRect();
          const newWidth = e.clientX - rect.left;
          if (newWidth >= 150 && newWidth <= 500) setWidth(newWidth);
        }
      });
    };
    const handleUp = () => {
      setIsResizing(false);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
    return () => {
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);
    };
  }, [isResizing]);

  const sortedFiles = [...files].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <div ref={containerRef} className="file-tree" style={{ width }}>
      <div className="panel-titlebar">
        <span className="panel-title">远程文件</span>
        <div className="file-tree-actions">
          <button onClick={handleGoUp} title="上级目录">⬆</button>
          <button onClick={handleRefresh} title="刷新">↻</button>
        </div>
      </div>

      {/* Breadcrumb navigation */}
      <div className="file-tree-path" style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
        <span
          style={{ cursor: 'pointer', flexShrink: 0 }}
          onClick={() => loadDirectory('/')}
          title="根目录"
        >/</span>
        {breadcrumbs.map((seg, i) => (
          <span key={i} style={{ display: 'inline', whiteSpace: 'nowrap' }}>
            <span
              style={{ cursor: 'pointer', color: i === breadcrumbs.length - 1 ? 'var(--text-primary)' : 'var(--text-secondary)' }}
              onClick={() => navigateToBreadcrumb(i)}
            >
              {seg}
            </span>
            {i < breadcrumbs.length - 1 && <span>/</span>}
          </span>
        ))}
      </div>

      {/* Transfer progress */}
      {transferProgress && (
        <div style={{ padding: '2px 8px', fontSize: 11, color: 'var(--text-secondary)' }}>
          {transferProgress.direction === 'upload' ? '上传' : '下载'}: {transferProgress.percent}%
        </div>
      )}

      <div className="file-tree-content" onContextMenu={(e) => handleContextMenu(e)}>
        {loading && (
          <div className="tree-loading" style={{ padding: '8px 12px' }}>加载中...</div>
        )}
        {error && (
          <div style={{ padding: '8px 12px', fontSize: 12, color: '#f44747' }}>{error}</div>
        )}
        {!loading && !error && sortedFiles.map((file) => (
          <div
            key={file.path}
            className={`tree-item ${selectedPath === file.path ? 'selected' : ''}`}
            style={{ paddingLeft: 8 }}
            onClick={() => setSelectedPath(file.path)}
            onDoubleClick={() => handleDoubleClick(file)}
            onContextMenu={(e) => handleContextMenu(e, file)}
          >
            <span className="tree-icon" style={{ fontSize: 12, flexShrink: 0 }}>
              {file.isDir ? '📁' : '📄'}
            </span>
            {renaming?.path === file.path ? (
              <input
                ref={renameInputRef}
                className="tree-rename-input"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onBlur={confirmRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); confirmRename(); }
                  if (e.key === 'Escape') { e.preventDefault(); setRenaming(null); }
                }}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span className="tree-name">{file.name}</span>
            )}
            <span style={{ fontSize: 10, color: 'var(--text-secondary)', flexShrink: 0, marginLeft: 4, minWidth: 48, textAlign: 'right' }}>
              {file.isDir ? '' : formatSize(file.size)}
            </span>
            <span style={{ fontSize: 10, color: 'var(--text-secondary)', flexShrink: 0, marginLeft: 4, fontFamily: 'monospace' }}>
              {formatPermissions(file.permissions).slice(1)}
            </span>
            <span style={{ fontSize: 10, color: 'var(--text-secondary)', flexShrink: 0, marginLeft: 4 }}>
              {formatDate(file.modified)}
            </span>
          </div>
        ))}

        {/* Create new file/dir inline input */}
        {creating && (
          <div className="tree-item" style={{ paddingLeft: 8 }}>
            <span className="tree-icon" style={{ fontSize: 12, flexShrink: 0 }}>
              {creating === 'dir' ? '📁' : '📄'}
            </span>
            <input
              ref={createInputRef}
              className="tree-rename-input"
              value={createValue}
              placeholder={creating === 'dir' ? '新文件夹名' : '新文件名'}
              onChange={(e) => setCreateValue(e.target.value)}
              onBlur={confirmCreate}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); confirmCreate(); }
                if (e.key === 'Escape') { e.preventDefault(); setCreating(null); }
              }}
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        )}
      </div>

      {/* Hidden file input for upload */}
      <input
        ref={fileInputRef}
        type="file"
        style={{ display: 'none' }}
        onChange={handleFileSelected}
      />

      <div
        className={`resize-handle ${isResizing ? 'active' : ''}`}
        onMouseDown={handleResizeMouseDown}
      />

      {/* Context menu */}
      {contextMenu && (
        <div
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="context-menu-item" onClick={handleRefresh}>刷新</div>
          {contextMenu.file && (
            <>
              <div className="context-menu-separator" />
              <div className="context-menu-item" onClick={() => handleOpen(contextMenu.file!)}>
                {contextMenu.file.isDir ? '打开' : '打开目录(cd)'}
              </div>
              {!contextMenu.file.isDir && (
                <div className="context-menu-item" onClick={() => handleDownload(contextMenu.file!)}>
                  下载
                </div>
              )}
              {!contextMenu.file.isDir && isTextFile(contextMenu.file.name) && (
                <div className="context-menu-item" onClick={() => handleEdit(contextMenu.file!)}>
                  用本地编辑器打开
                </div>
              )}
              <div className="context-menu-separator" />
              <div className="context-menu-item" onClick={() => handleRename(contextMenu.file!)}>
                重命名
              </div>
              <div className="context-menu-item" onClick={() => handleCopy(contextMenu.file!)}>
                复制
              </div>
              <div className="context-menu-item" onClick={() => handleMove(contextMenu.file!)}>
                剪切
              </div>
              <div className="context-menu-item" onClick={() => handleChmod(contextMenu.file!)}>
                权限
              </div>
              <div className="context-menu-item danger" onClick={() => handleDelete(contextMenu.file!)}>
                删除
              </div>
            </>
          )}
          <div className="context-menu-separator" />
          {remoteClipboard && (
            <div className="context-menu-item" onClick={handlePaste}>
              粘贴 ({remoteClipboard.operation === 'copy' ? '复制' : '移动'} {remoteClipboard.items.length} 项)
            </div>
          )}
          <div className="context-menu-item" onClick={() => handleCreate('file')}>新建文件</div>
          <div className="context-menu-item" onClick={() => handleCreate('dir')}>新建文件夹</div>
          <div className="context-menu-separator" />
          <div className="context-menu-item" onClick={handleUpload}>上传文件</div>
        </div>
      )}

      {/* Chmod dialog */}
      {chmodFile && (
        <ChmodDialog
          path={chmodFile.path}
          currentMode={chmodFile.permissions}
          onConfirm={confirmChmod}
          onClose={() => setChmodFile(null)}
        />
      )}
    </div>
  );
};
