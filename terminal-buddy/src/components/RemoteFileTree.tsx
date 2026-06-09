import { FC, useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useAppStore } from '../stores/appStore';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import {
  remoteListDir, remoteCreateDir, remoteCreateFile, remoteRemove,
  remoteRename, remoteMove, remoteCopy, remoteChmod, remoteUpload,
  remoteDownload, remoteDownloadDir, writeToTerminal, getSshTempDirectory, ensureDir, getDownloadsDirectory,
  connectSshSession, getSshHomeDir, openPath, onTransferProgress, onTransferError,
} from '../services/tauri';
import { isTextFile } from '../utils/fileExtensions';
import { getAppSettings } from '../utils/settings';
import { ChmodDialog } from './ChmodDialog';
import { TransferPanel } from './TransferPanel';
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
    mode & 0o400 ? 'r' : '-', mode & 0o200 ? 'w' : '-', mode & 0o100 ? 'x' : '-',
    mode & 0o040 ? 'r' : '-', mode & 0o020 ? 'w' : '-', mode & 0o010 ? 'x' : '-',
    mode & 0o004 ? 'r' : '-', mode & 0o002 ? 'w' : '-', mode & 0o001 ? 'x' : '-',
  ];
  return (mode & 0o040000 ? 'd' : '-') + perms.join('');
}

function waitForDownload(transferId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let unlistenProgress: (() => void) | undefined;
    let unlistenError: (() => void) | undefined;
    const cleanup = () => { unlistenProgress?.(); unlistenError?.(); };

    onTransferProgress((progress) => {
      if (progress.transferId === transferId && progress.percent >= 100) {
        cleanup();
        resolve();
      }
    }).then(fn => { unlistenProgress = fn; });

    onTransferError((evt) => {
      if (evt.transferId === transferId) {
        cleanup();
        reject(new Error(evt.error));
      }
    }).then(fn => { unlistenError = fn; });
  });
}

interface RemoteFileTreeProps {
  terminalId: string;
}

export const RemoteFileTree: FC<RemoteFileTreeProps> = ({ terminalId }) => {
  const [files, setFiles] = useState<RemoteFileEntry[]>([]);
  const [currentPath, setCurrentPath] = useState('/');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connected, setConnected] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [renaming, setRenaming] = useState<RemoteFileEntry | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [creating, setCreating] = useState<'file' | 'dir' | null>(null);
  const [createValue, setCreateValue] = useState('');
  const [chmodFile, setChmodFile] = useState<RemoteFileEntry | null>(null);
  const [transferProgress, setTransferProgress] = useState<TransferProgress | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [width, setWidth] = useState(250);
  const [isResizing, setIsResizing] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const createInputRef = useRef<HTMLInputElement>(null);

  const remoteClipboard = useAppStore(s => s.remoteClipboard);
  const setRemoteClipboard = useAppStore(s => s.setRemoteClipboard);
  const setSessionDirectory = useAppStore(s => s.setSessionDirectory);
  const session = useAppStore(s => s.sessions.find(s => s.id === terminalId));
  const addTransfer = useAppStore(s => s.addTransfer);
  const remoteFileCache = useAppStore(s => s.remoteFileCache[terminalId]);
  const setRemoteFileCache = useAppStore(s => s.setRemoteFileCache);
  const connectedRef = useRef(false);
  const [showTransferPanel, setShowTransferPanel] = useState(false);

  const connectSession = useCallback(async () => {
    if (connectedRef.current) return true;
    if (!session?.profileId) return false;
    setConnecting(true);
    setError(null);
    try {
      await connectSshSession(terminalId, session.profileId);
      connectedRef.current = true;
      setConnected(true);
      return true;
    } catch (e) {
      console.error('SSH session connect failed:', e);
      setError('连接失败: ' + String(e));
      return false;
    } finally {
      setConnecting(false);
    }
  }, [terminalId, session?.profileId]);

  const loadDirectory = useCallback(async (path: string) => {
    if (!connectedRef.current) return;
    setLoading(true);
    setError(null);
    try {
      const entries = await remoteListDir(terminalId, path);
      setFiles(entries);
      setCurrentPath(path);
      setSessionDirectory(terminalId, path);
      setSelectedPaths(new Set());
      setRemoteFileCache(terminalId, { files: entries, currentPath: path });
    } catch (err) {
      console.error('Failed to list remote directory:', err);
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [terminalId, setSessionDirectory, setRemoteFileCache]);

  // Reset and auto-connect when switching to a different SSH terminal
  useEffect(() => {
    connectedRef.current = false;
    setConnected(false);
    setError(null);
    setSelectedPaths(new Set());

    // Restore from cache for instant display
    if (remoteFileCache) {
      setFiles(remoteFileCache.files);
      setCurrentPath(remoteFileCache.currentPath);
    } else {
      setFiles([]);
      setCurrentPath('/');
    }

    if (session?.profileId) {
      connectSession().then(async ok => {
        if (ok) {
          // If we had a cache, refresh the cached directory in the background
          const cachedPath = remoteFileCache?.currentPath;
          if (cachedPath) {
            loadDirectory(cachedPath);
          } else {
            try {
              const homeDir = await getSshHomeDir(terminalId);
              loadDirectory(homeDir || '/');
            } catch {
              loadDirectory('/');
            }
          }
        }
      });
    }
  }, [terminalId, session?.profileId]);

  // Transfer progress listener — match by transferId for async transfers
  useEffect(() => {
    let unlistenProgress: (() => void) | undefined;
    let unlistenError: (() => void) | undefined;

    onTransferProgress((progress) => {
      if (progress.terminalId !== terminalId) return;
      const store = useAppStore.getState();

      // Match by transferId (async transfers)
      if (progress.transferId) {
        const item = store.transfers.find(t => t.id === progress.transferId);
        if (item) {
          store.updateTransferProgress(item.id, progress.transferred, progress.total, progress.percent);
          if (progress.percent >= 100) {
            store.completeTransfer(item.id);
          }
          return;
        }
      }

      // Legacy: match by active transfer (handleEdit / handleOpenInSystem)
      const activeTransfer = store.transfers.find(t =>
        t.terminalId === terminalId && t.status === 'active'
      );
      if (activeTransfer) {
        store.updateTransferProgress(activeTransfer.id, progress.transferred, progress.total, progress.percent);
        if (progress.percent >= 100) {
          store.completeTransfer(activeTransfer.id);
        }
        return;
      }
      setTransferProgress(progress);
      if (progress.percent >= 100) {
        setTimeout(() => setTransferProgress(null), 1500);
      }
    }).then(fn => { unlistenProgress = fn; });

    onTransferError((evt) => {
      const store = useAppStore.getState();
      const item = store.transfers.find(t => t.id === evt.transferId);
      if (item) {
        store.failTransfer(item.id, evt.error);
      }
    }).then(fn => { unlistenError = fn; });

    return () => { unlistenProgress?.(); unlistenError?.(); };
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
  const breadcrumbs = currentPath.replace(/\\/g, '/').split('/').filter(Boolean);

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
    } else if (isTextFile(file.name)) {
      if (file.size > 10 * 1024 * 1024) {
        alert('超大文件不支持编辑（>10MB）');
        return;
      }
      handleEdit(file);
    }
  };

  const handleContextMenu = (e: React.MouseEvent, file?: RemoteFileEntry) => {
    e.preventDefault();
    e.stopPropagation();
    if (file && !selectedPaths.has(file.path)) {
      setSelectedPaths(new Set([file.path]));
    }
    setContextMenu({ x: e.clientX, y: e.clientY, file });
  };

  const handleFileClick = (e: React.MouseEvent, file: RemoteFileEntry) => {
    if (e.ctrlKey || e.metaKey) {
      setSelectedPaths(prev => {
        const next = new Set(prev);
        if (next.has(file.path)) next.delete(file.path);
        else next.add(file.path);
        return next;
      });
    } else {
      setSelectedPaths(new Set([file.path]));
    }
  };

  const handleOpen = (file: RemoteFileEntry) => {
    setContextMenu(null);
    if (file.isDir) {
      loadDirectory(file.path);
    } else {
      const parent = file.path.substring(0, file.path.lastIndexOf('/'));
      writeToTerminal(terminalId, `cd "${parent}"\r`).catch(console.error);
    }
  };

  const getDownloadDir = async () => {
    const settings = getAppSettings();
    if (settings.sshDownloadDir) return settings.sshDownloadDir;
    return getDownloadsDirectory();
  };

  const startDownload = async (file: RemoteFileEntry) => {
    const baseDir = await getDownloadDir();
    const localPath = `${baseDir}/${file.name}`;
    const id = crypto.randomUUID();
    addTransfer({
      id,
      terminalId,
      direction: 'download',
      remotePath: file.path,
      localPath,
      fileName: file.name,
      status: 'active',
      transferred: 0,
      total: file.isDir ? 0 : file.size,
      percent: 0,
    });
    setShowTransferPanel(true);
    const downloadFn = file.isDir ? remoteDownloadDir : remoteDownload;
    downloadFn(terminalId, file.path, localPath, id, session?.profileId || '').catch(err => {
      const store = useAppStore.getState();
      store.failTransfer(id, String(err));
    });
  };

  const handleDownload = (file: RemoteFileEntry) => {
    setContextMenu(null);
    startDownload(file).catch(err => {
      console.error('Download failed:', err);
      alert('下载失败: ' + String(err));
    });
  };

  const handleBatchDownload = () => {
    setContextMenu(null);
    const selected = files.filter(f => selectedPaths.has(f.path) && !f.isDir);
    for (const file of selected) {
      startDownload(file).catch(err => {
        console.error('Download failed:', err);
      });
    }
  };

  const handleOpenInSystem = async (file: RemoteFileEntry) => {
    setContextMenu(null);
    try {
      const baseTempDir = await getSshTempDirectory();
      const tempDir = `${baseTempDir}/${terminalId}`;
      await ensureDir(tempDir);
      const localPath = `${tempDir}/${file.name}`;
      const id = crypto.randomUUID();
      await remoteDownload(terminalId, file.path, localPath, id, session?.profileId || '');
      await waitForDownload(id);
      await openPath(localPath);
    } catch (err) {
      console.error('Open in system failed:', err);
      alert('打开失败: ' + String(err));
    }
  };

  const handleEdit = async (file: RemoteFileEntry) => {
    setContextMenu(null);
    try {
      const baseTempDir = await getSshTempDirectory();
      const tempDir = `${baseTempDir}/${terminalId}`;
      await ensureDir(tempDir);
      const localPath = `${tempDir}/${file.name}`;
      const id = crypto.randomUUID();
      await remoteDownload(terminalId, file.path, localPath, id, session?.profileId || '');
      await waitForDownload(id);
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

  const handleUpload = async () => {
    setContextMenu(null);
    const selected = await openDialog({ multiple: true, title: '选择上传文件' });
    if (!selected) return;
    const files = Array.isArray(selected) ? selected : [selected];
    for (const f of files) {
      const localPath = f;
      const fileName = localPath.split(/[/\\]/).pop() || localPath;
      const remotePath = `${currentPath}/${fileName}`;
      const id = crypto.randomUUID();
      addTransfer({
        id,
        terminalId,
        direction: 'upload',
        remotePath,
        localPath,
        fileName,
        status: 'active',
        transferred: 0,
        total: 0,
        percent: 0,
      });
      setShowTransferPanel(true);
      remoteUpload(terminalId, localPath, remotePath, id, session?.profileId || '')
        .then(() => handleRefresh())
        .catch(err => {
          console.error('Upload failed:', err);
          const store = useAppStore.getState();
          store.failTransfer(id, String(err));
          alert('上传失败: ' + String(err));
        });
    }
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

  const activeTransferCount = useAppStore((s) =>
    s.transfers.filter(t => t.terminalId === terminalId && t.status === 'active').length
  );

  const selectedFileCount = useMemo(
    () => [...selectedPaths].filter(p => { const f = files.find(ff => ff.path === p); return f && !f.isDir; }).length,
    [selectedPaths, files]
  );

  return (
    <div ref={containerRef} className="file-tree" style={{ width }}>
      <div className="panel-titlebar">
        <span className="panel-title">{showTransferPanel ? '传输列表' : '远程文件'}</span>
        <div className="file-tree-actions">
          {showTransferPanel ? (
            <button onClick={() => setShowTransferPanel(false)} title="文件列表">文件列表</button>
          ) : (
            <>
              <button
                onClick={() => setShowTransferPanel(true)}
                title="传输列表"
                style={activeTransferCount > 0 ? { color: 'var(--accent)' } : {}}
              >
                ↓↑{activeTransferCount > 0 ? activeTransferCount : ''}
              </button>
              <button onClick={handleGoUp} title="上级目录">⬆</button>
              <button onClick={handleRefresh} title="刷新">↻</button>
            </>
          )}
        </div>
      </div>

      {showTransferPanel ? (
        <TransferPanel terminalId={terminalId} />
      ) : (
        <>
      {/* Breadcrumb navigation */}
      <div className="file-tree-path" style={{ display: 'flex', alignItems: 'center' }}>
        {breadcrumbs.map((seg, i) => (
          <span key={i} style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>
            {i > 0 && <span className="breadcrumb-sep">/</span>}
            <span
              className={'breadcrumb-seg' + (i === breadcrumbs.length - 1 ? ' active' : '')}
              onClick={() => navigateToBreadcrumb(i)}
            >
              {i === 0 ? '/' + seg : seg}
            </span>
          </span>
        ))}
        {selectedFileCount > 1 && (
          <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--accent)', flexShrink: 0 }}>
            已选 {selectedFileCount} 个文件
          </span>
        )}
      </div>

      {/* Transfer progress */}
      {transferProgress && (
        <div style={{ padding: '2px 8px', fontSize: 11, color: 'var(--text-secondary)' }}>
          {transferProgress.direction === 'upload' ? '上传' : '下载'}: {transferProgress.percent}%
        </div>
      )}

      <div className="file-tree-content" onContextMenu={(e) => handleContextMenu(e)}>
        {!connected && (
          <div style={{ padding: '16px 12px', textAlign: 'center' }}>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12 }}>
              远程文件管理需要建立 SSH 连接
            </div>
            <button
              className="btn-secondary"
              disabled={connecting}
              onClick={async () => {
                const ok = await connectSession();
                if (ok) {
                  try {
                    const homeDir = await getSshHomeDir(terminalId);
                    loadDirectory(homeDir || '/');
                  } catch {
                    loadDirectory('/');
                  }
                }
              }}
              style={{ padding: '6px 20px', cursor: connecting ? 'default' : 'pointer' }}
            >
              {connecting ? '连接中...' : '连接'}
            </button>
            {error && (
              <div style={{ padding: '8px 0', fontSize: 12, color: '#f44747' }}>{error}</div>
            )}
          </div>
        )}
        {connected && loading && (
          <div className="tree-loading" style={{ padding: '8px 12px' }}>加载中...</div>
        )}
        {connected && error && (
          <div style={{ padding: '8px 12px', fontSize: 12, color: '#f44747' }}>{error}</div>
        )}
        {connected && !loading && !error && sortedFiles.map((file) => (
          <div
            key={file.path}
            className={`tree-item ${selectedPaths.has(file.path) ? 'selected' : ''}`}
            style={{ paddingLeft: 8 }}
            onClick={(e) => handleFileClick(e, file)}
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
      </>
      )}

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
              <div className="context-menu-item" onClick={() => handleDownload(contextMenu.file!)}>
                {contextMenu.file.isDir ? '下载文件夹' : '下载'}
              </div>
              {!contextMenu.file.isDir && (
                <div className="context-menu-item" onClick={() => handleOpenInSystem(contextMenu.file!)}>
                  在系统中打开
                </div>
              )}
              {!contextMenu.file.isDir && isTextFile(contextMenu.file.name) && contextMenu.file.size <= 10 * 1024 * 1024 && (
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
          {selectedFileCount > 1 && (
            <>
              <div className="context-menu-separator" />
              <div className="context-menu-item" onClick={handleBatchDownload}>
                下载选中的 {selectedFileCount} 个文件
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
