import { FC, useEffect, useRef, useState, useCallback } from 'react';
import Editor, { OnMount } from '@monaco-editor/react';
import { editor as MonacoEditor, KeyMod, KeyCode } from 'monaco-editor';
import { readFileContent, writeFileContent, remoteUpload, getFileMeta, onTransferProgress, onTransferError } from '../services/tauri';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { useAppStore } from '../stores/appStore';
import { getMonacoLanguage } from '../utils/fileExtensions';
import './TextEditor.css';

const CONTEXT_MENU_ITEMS = [
  { id: 'editor.action.clipboardCutAction', label: '剪切', shortcut: 'Ctrl+X' },
  { id: 'editor.action.clipboardCopyAction', label: '复制', shortcut: 'Ctrl+C' },
  { id: 'editor.action.clipboardPasteAction', label: '粘贴', shortcut: 'Ctrl+V' },
  { id: '---' },
  { id: 'editor.action.selectAll', label: '全选', shortcut: 'Ctrl+A' },
  { id: '---' },
  { id: 'editor.action.undo', label: '撤销', shortcut: 'Ctrl+Z' },
  { id: 'editor.action.redo', label: '重做', shortcut: 'Ctrl+Y' },
  { id: '---' },
  { id: 'actions.find', label: '查找', shortcut: 'Ctrl+F' },
  { id: 'editor.action.startFindReplaceAction', label: '替换', shortcut: 'Ctrl+H' },
  { id: '---' },
  { id: 'editor.action.formatDocument', label: '格式化文档', shortcut: 'Shift+Alt+F' },
  { id: 'editor.action.commentLine', label: '切换行注释', shortcut: 'Ctrl+/' },
  { id: 'editor.action.blockComment', label: '切换块注释', shortcut: 'Shift+Alt+A' },
];

interface TextEditorProps {
  filePath: string;
  isDirty: boolean;
  onDirtyChange: (dirty: boolean) => void;
  isActive: boolean;
}

export const TextEditor: FC<TextEditorProps> = ({ filePath, isDirty, onDirtyChange, isActive }) => {
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [conflictDialog, setConflictDialog] = useState<'overwrite' | 'discard' | null>(null);
  const [saveNotify, setSaveNotify] = useState<{ type: 'saving' | 'success' | 'error'; msg: string } | null>(null);
  const saveNotifyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const diskModTimeRef = useRef<number>(0);
  const isDirtyRef = useRef(isDirty);
  const lastLoadedContentRef = useRef<string | null>(null);
  const isInternalUpdateRef = useRef(false);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  isDirtyRef.current = isDirty;

  const loadFileContent = useCallback(async (forceReload = false) => {
    try {
      const meta = await getFileMeta(filePath);
      if (!forceReload && diskModTimeRef.current !== 0 && meta.lastModified === diskModTimeRef.current) {
        return;
      }
      const text = await readFileContent(filePath);
      diskModTimeRef.current = meta.lastModified;
      lastLoadedContentRef.current = text;

      isInternalUpdateRef.current = true;
      setContent(text);
      setError(null);

      if (editorRef.current) {
        const model = editorRef.current.getModel();
        if (model && model.getValue() !== text) {
          model.setValue(text);
        }
      }
    } catch (err) {
      setError(String(err));
      setContent(null);
    }
  }, [filePath]);

  // Auto-save for draft files (files in ClientData/drafts/)
  const isDraft = filePath.includes('\\drafts\\draft_') || filePath.includes('/drafts/draft_');
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentRef = useRef(content);
  contentRef.current = content;

  useEffect(() => {
    if (!isDraft) return;
    const autoSave = () => {
      const current = contentRef.current;
      if (current !== null && current !== lastLoadedContentRef.current) {
        writeFileContent(filePath, current).then(() => {
          lastLoadedContentRef.current = current;
          getFileMeta(filePath).then(meta => { diskModTimeRef.current = meta.lastModified; }).catch(() => {});
        }).catch(console.error);
      }
    };
    autoSaveTimerRef.current = setInterval(autoSave, 3000);
    return () => {
      if (autoSaveTimerRef.current) {
        clearInterval(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      }
    };
  }, [isDraft, filePath]);

  // Initial load
  useEffect(() => {
    let cancelled = false;
    readFileContent(filePath)
      .then((text) => {
        if (!cancelled) {
          setContent(text);
          setError(null);
          lastLoadedContentRef.current = text;
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(String(err));
          setContent(null);
        }
      });
    getFileMeta(filePath)
      .then((meta) => {
        if (!cancelled) diskModTimeRef.current = meta.lastModified;
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [filePath]);

  // Re-read file when switching to this tab
  useEffect(() => {
    if (!isActive) return;
    const checkForChanges = async () => {
      try {
        const meta = await getFileMeta(filePath);
        if (meta.lastModified === diskModTimeRef.current) return;

        if (!isDirtyRef.current) {
          await loadFileContent(true);
        } else {
          setConflictDialog('overwrite');
        }
      } catch {}
    };
    checkForChanges();
  }, [isActive, filePath, loadFileContent]);

  // Poll for external changes when active
  useEffect(() => {
    if (!isActive) {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      return;
    }
    const poll = async () => {
      try {
        const meta = await getFileMeta(filePath);
        if (meta.lastModified === diskModTimeRef.current) return;

        if (!isDirtyRef.current) {
          await loadFileContent(true);
        } else if (!conflictDialog) {
          setConflictDialog('overwrite');
        }
      } catch {}
    };
    pollTimerRef.current = setInterval(poll, 3000);
    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [isActive, filePath, loadFileContent, conflictDialog]);

  const handleEditorMount: OnMount = useCallback((editor) => {
    editorRef.current = editor;
    editor.updateOptions({ contextmenu: false });

    const showSaveNotify = (type: 'saving' | 'success' | 'error', msg: string) => {
      if (saveNotifyTimerRef.current) clearTimeout(saveNotifyTimerRef.current);
      setSaveNotify({ type, msg });
      if (type !== 'saving') {
        saveNotifyTimerRef.current = setTimeout(() => setSaveNotify(null), 3000);
      }
    };

    editor.addAction({
      id: 'save-file',
      label: '保存文件',
      keybindings: [KeyMod.CtrlCmd | KeyCode.KeyS],
      run: async (ed) => {
        const value = ed.getValue();
        try {
          let savePath = filePath;
          let isNewSave = false;

          // If this is a draft file, prompt for save location
          if (isDraft) {
            const savedPath = await saveDialog({
              defaultPath: '未命名.txt',
              filters: [{ name: '文本文件', extensions: ['txt'] }, { name: '所有文件', extensions: ['*'] }],
            });
            if (!savedPath) return; // User cancelled
            savePath = savedPath;
            isNewSave = true;
          }

          await writeFileContent(savePath, value);

          // If this was a draft that was saved to a new location, clean up
          if (isNewSave) {
            // Remove draft file and update draft index
            const { removeDraftFile, updateSession } = useAppStore.getState();
            await removeDraftFile(filePath);

            // Update session with new path and name
            const session = useAppStore.getState().sessions.find(
              s => s.sessionType === 'editor' && s.profileId === filePath
            );
            if (session) {
              const fileName = savePath.split(/[/\\]/).pop() || '未命名';
              updateSession(session.id, {
                profileId: savePath,
                profileName: fileName,
              });
            }
          }

          const session = useAppStore.getState().sessions.find(
            s => s.sessionType === 'editor' && s.profileId === savePath
          );
          if (session?.sshRemotePath && session?.sshTerminalId) {
            showSaveNotify('saving', '正在上传到服务器...');
            const transferId = crypto.randomUUID();
            try {
              const terminalSession = useAppStore.getState().sessions.find(s => s.id === session.sshTerminalId);
              await remoteUpload(session.sshTerminalId, savePath, session.sshRemotePath, transferId, terminalSession?.profileId || '');
            } catch (uploadErr) {
              showSaveNotify('error', '上传失败: ' + String(uploadErr));
              return;
            }
            // Wait for async upload to complete
            await new Promise<void>((resolve) => {
              let done = false;
              let unlistenProgress: (() => void) | undefined;
              let unlistenError: (() => void) | undefined;
              const finish = () => { unlistenProgress?.(); unlistenError?.(); resolve(); };

              onTransferProgress((progress) => {
                if (progress.transferId === transferId && progress.percent >= 100 && !done) {
                  done = true;
                  showSaveNotify('success', '已保存并上传到服务器');
                  finish();
                }
              }).then(fn => { unlistenProgress = fn; if (done) fn(); });

              onTransferError((evt) => {
                if (evt.transferId === transferId && !done) {
                  done = true;
                  showSaveNotify('error', '上传失败: ' + evt.error);
                  finish();
                }
              }).then(fn => { unlistenError = fn; if (done) fn(); });

              // Timeout fallback
              setTimeout(() => { if (!done) { done = true; finish(); } }, 30000);
            });
          } else {
            showSaveNotify('success', '已保存');
          }
          onDirtyChange(false);
          const meta = await getFileMeta(savePath).catch(() => null);
          if (meta) diskModTimeRef.current = meta.lastModified;
          lastLoadedContentRef.current = value;
        } catch (err) {
          console.error('Failed to save file:', err);
          showSaveNotify('error', '保存失败');
        }
      },
    });

    editor.addAction({
      id: 'format-document',
      label: '格式化文档',
      keybindings: [KeyMod.Shift | KeyMod.Alt | KeyCode.KeyF],
      run: async (ed) => {
        await ed.getAction('editor.action.formatDocument')?.run();
      },
    });

    editor.onDidChangeModelContent(() => {
      if (!isInternalUpdateRef.current) {
        onDirtyChange(true);
      }
      isInternalUpdateRef.current = false;
    });
  }, [filePath, onDirtyChange]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY });
  }, []);

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

  const handleMenuItemClick = useCallback((actionId: string) => {
    editorRef.current?.getAction(actionId)?.run();
    setCtxMenu(null);
  }, []);

  const handleOverwriteSave = useCallback(async () => {
    if (editorRef.current) {
      const value = editorRef.current.getValue();
      try {
        await writeFileContent(filePath, value);
        const session = useAppStore.getState().sessions.find(
          s => s.sessionType === 'editor' && s.profileId === filePath
        );
        if (session?.sshRemotePath && session?.sshTerminalId) {
          try {
            const terminalSession = useAppStore.getState().sessions.find(s => s.id === session.sshTerminalId);
            await remoteUpload(session.sshTerminalId, filePath, session.sshRemotePath, crypto.randomUUID(), terminalSession?.profileId || '');
          } catch (uploadErr) {
            console.error('Auto-upload to server failed:', uploadErr);
            alert('已保存到本地，但上传到服务器失败: ' + String(uploadErr));
          }
        }
        onDirtyChange(false);
        const meta = await getFileMeta(filePath).catch(() => null);
        if (meta) diskModTimeRef.current = meta.lastModified;
        lastLoadedContentRef.current = value;
      } catch (err) {
        console.error('Failed to save file:', err);
      }
    }
    setConflictDialog(null);
  }, [filePath, onDirtyChange]);

  const handleDiscard = useCallback(async () => {
    await loadFileContent(true);
    onDirtyChange(false);
    setConflictDialog(null);
  }, [loadFileContent, onDirtyChange]);

  if (error) {
    return (
      <div className="text-editor-error">
        <div className="text-editor-error-icon">📄</div>
        <div className="text-editor-error-text">无法打开文件</div>
        <div className="text-editor-error-detail">{error}</div>
      </div>
    );
  }

  if (content === null) {
    return <div className="text-editor-loading">加载中...</div>;
  }

  return (
    <div className="text-editor-container" ref={containerRef} onContextMenu={handleContextMenu}>
      <Editor
        height="100%"
        language={getMonacoLanguage(filePath)}
        value={content}
        onMount={handleEditorMount}
        theme="vs-dark"
        options={{
          fontSize: 14,
          minimap: { enabled: true },
          automaticLayout: true,
          scrollBeyondLastLine: false,
          wordWrap: 'on',
          tabSize: 4,
          insertSpaces: true,
          lineNumbers: 'on',
          folding: true,
          renderWhitespace: 'selection',
        }}
        onChange={(value) => {
          if (value !== undefined) setContent(value);
        }}
      />
      {saveNotify && (
        <div className={`editor-save-notify editor-save-notify-${saveNotify.type}`}>
          {saveNotify.type === 'saving' && <span className="editor-save-spinner" />}
          {saveNotify.msg}
        </div>
      )}
      {ctxMenu && (
        <>
          <div className="editor-ctx-overlay" onClick={() => setCtxMenu(null)} />
          <div className="editor-ctx-menu" style={{ left: ctxMenu.x, top: ctxMenu.y }}>
            {CONTEXT_MENU_ITEMS.map((item, idx) =>
              item.id === '---' ? (
                <div key={`sep-${idx}`} className="editor-ctx-separator" />
              ) : (
                <div
                  key={item.id}
                  className="editor-ctx-item"
                  onClick={() => handleMenuItemClick(item.id)}
                >
                  <span>{item.label}</span>
                  <span className="editor-ctx-shortcut">{item.shortcut}</span>
                </div>
              )
            )}
          </div>
        </>
      )}
      {conflictDialog && (
        <>
          <div className="editor-conflict-overlay" />
          <div className="editor-conflict-dialog">
            <div className="editor-conflict-title">文件已被外部修改</div>
            <div className="editor-conflict-message">
              此文件在编辑器外已被修改，且您有未保存的更改。
            </div>
            <div className="editor-conflict-actions">
              <button className="editor-conflict-btn overwrite" onClick={handleOverwriteSave}>
                覆盖保存
              </button>
              <button className="editor-conflict-btn discard" onClick={handleDiscard}>
                放弃修改
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
