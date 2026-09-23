import { CSSProperties, FC, KeyboardEvent, PointerEvent, useEffect, useRef, useState, useCallback } from 'react';
import { Columns2, Eye, FileCode2, FileWarning } from 'lucide-react';
import Editor, { OnMount } from '@monaco-editor/react';
import { editor as MonacoEditor, KeyMod, KeyCode } from 'monaco-editor';
import { readFileContent, writeFileContent, remoteUpload, getFileMeta, onTransferProgress, onTransferError } from '../../services/tauri';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { useAppStore } from '../../stores/appStore';
import { getMonacoLanguage, isMarkdownFile } from '../../utils/fileExtensions';
import { Dialog } from '../shared/Dialog';
import { MarkdownPreview, MarkdownPreviewHandle } from './MarkdownPreview';
import { showAlert } from '../../services/dialog';
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

const MARKDOWN_PREVIEW_DEFAULT_WIDTH = 50;
const MARKDOWN_PREVIEW_MIN_PANE_WIDTH = 240;
const MARKDOWN_PREVIEW_RESIZER_WIDTH = 5;

type MarkdownViewMode = 'source' | 'split' | 'preview';

const MARKDOWN_VIEW_MODES: { mode: MarkdownViewMode; label: string; title: string; icon: typeof Columns2 }[] = [
  { mode: 'source', label: '源码', title: '源码模式：只显示 Markdown 源文本', icon: FileCode2 },
  { mode: 'split', label: '分屏', title: '分屏模式：源码与预览并排显示', icon: Columns2 },
  { mode: 'preview', label: '预览', title: '预览模式：只显示渲染后的预览', icon: Eye },
];

/** 三态视图轮换顺序：源码 → 分屏 → 预览 → 源码 */
function cycleMarkdownViewMode(current: MarkdownViewMode): MarkdownViewMode {
  return current === 'source' ? 'split' : current === 'split' ? 'preview' : 'source';
}

function getEditorSourceLineAtTop(editor: MonacoEditor.IStandaloneCodeEditor): number {
  const model = editor.getModel();
  const firstVisiblePosition = editor.getVisibleRanges()[0]?.getStartPosition();
  if (!model || !firstVisiblePosition) return 0;

  const lineLength = model.getLineLength(firstVisiblePosition.lineNumber);
  const lineProgress = (firstVisiblePosition.column - 1) / (lineLength + 2);
  return firstVisiblePosition.lineNumber - 1 + lineProgress;
}

interface TextEditorProps {
  filePath: string;
  isDirty: boolean;
  onDirtyChange: (dirty: boolean) => void;
  isActive: boolean;
}

export const TextEditor: FC<TextEditorProps> = ({ filePath, isDirty, onDirtyChange, isActive }) => {
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const markdownPreviewRef = useRef<MarkdownPreviewHandle>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [conflictDialog, setConflictDialog] = useState<'overwrite' | 'discard' | null>(null);
  const [saveNotify, setSaveNotify] = useState<{ type: 'saving' | 'success' | 'error'; msg: string } | null>(null);
  const [markdownViewMode, setMarkdownViewMode] = useState<MarkdownViewMode>('source');
  const [markdownPreviewWidth, setMarkdownPreviewWidth] = useState(MARKDOWN_PREVIEW_DEFAULT_WIDTH);
  const [isMarkdownPreviewResizing, setIsMarkdownPreviewResizing] = useState(false);
  const [markdownPreviewToggleRight, setMarkdownPreviewToggleRight] = useState(112);
  const prevMarkdownViewModeRef = useRef<MarkdownViewMode>('source');
  const saveNotifyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const markdownResizePointerRef = useRef<number | null>(null);
  const editorScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingEditorSourceLineRef = useRef(0);
  const previewDrivingEditorUntilRef = useRef(0);
  const diskModTimeRef = useRef<number>(0);
  const isDirtyRef = useRef(isDirty);
  const lastLoadedContentRef = useRef<string | null>(null);
  const isInternalUpdateRef = useRef(false);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isMarkdown = isMarkdownFile(filePath);

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

  useEffect(() => {
    if (!isMarkdown) setMarkdownViewMode('source');
  }, [isMarkdown]);

  useEffect(() => {
    if (!isMarkdownPreviewResizing) return;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };
  }, [isMarkdownPreviewResizing]);

  useEffect(() => () => {
    if (editorScrollTimerRef.current) clearTimeout(editorScrollTimerRef.current);
  }, []);

  const setMarkdownPreviewWidthFromClientX = useCallback((clientX: number) => {
    const bounds = containerRef.current?.getBoundingClientRect();
    if (!bounds) return;

    const availableWidth = bounds.width - MARKDOWN_PREVIEW_RESIZER_WIDTH;
    if (availableWidth < MARKDOWN_PREVIEW_MIN_PANE_WIDTH * 2) return;

    const previewWidth = Math.min(
      availableWidth - MARKDOWN_PREVIEW_MIN_PANE_WIDTH,
      Math.max(
        MARKDOWN_PREVIEW_MIN_PANE_WIDTH,
        bounds.right - clientX - MARKDOWN_PREVIEW_RESIZER_WIDTH / 2,
      ),
    );
    setMarkdownPreviewWidth((previewWidth / bounds.width) * 100);
  }, []);

  const handleMarkdownResizeStart = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    markdownResizePointerRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsMarkdownPreviewResizing(true);
    setMarkdownPreviewWidthFromClientX(event.clientX);
  }, [setMarkdownPreviewWidthFromClientX]);

  const handleMarkdownResizeMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (markdownResizePointerRef.current !== event.pointerId) return;
    setMarkdownPreviewWidthFromClientX(event.clientX);
  }, [setMarkdownPreviewWidthFromClientX]);

  const handleMarkdownResizeEnd = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (markdownResizePointerRef.current !== event.pointerId) return;
    markdownResizePointerRef.current = null;
    setIsMarkdownPreviewResizing(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const handleMarkdownResizeKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Home') {
      event.preventDefault();
      setMarkdownPreviewWidth(MARKDOWN_PREVIEW_DEFAULT_WIDTH);
      return;
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;

    event.preventDefault();
    const bounds = containerRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const currentDividerX = bounds.right - bounds.width * (markdownPreviewWidth / 100);
    const step = event.shiftKey ? 48 : 16;
    setMarkdownPreviewWidthFromClientX(
      event.key === 'ArrowLeft' ? currentDividerX - step : currentDividerX + step,
    );
  }, [markdownPreviewWidth, setMarkdownPreviewWidthFromClientX]);

  const handleMarkdownPreviewScroll = useCallback((line: number) => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;

    const sourceLine = Math.max(0, Math.min(line, model.getLineCount() - 1));
    const lineNumber = Math.floor(sourceLine) + 1;
    const lineProgress = sourceLine - Math.floor(sourceLine);
    const startColumn = Math.min(
      model.getLineMaxColumn(lineNumber),
      Math.floor(lineProgress * model.getLineLength(lineNumber)) + 1,
    );
    const endLineNumber = Math.min(lineNumber + 1, model.getLineCount());
    previewDrivingEditorUntilRef.current = performance.now() + 200;
    editor.revealRangeAtTop({
      startLineNumber: lineNumber,
      startColumn,
      endLineNumber,
      endColumn: 1,
    }, MonacoEditor.ScrollType.Immediate);
  }, []);

  // 视图模式切换后重新布局编辑器，并按切换方向同步一次滚动：
  // 源码 → 分屏：预览跟随编辑器顶部；预览 → 分屏：编辑器跟随预览顶部。
  useEffect(() => {
    const prevMode = prevMarkdownViewModeRef.current;
    prevMarkdownViewModeRef.current = markdownViewMode;
    if (!editorRef.current) return;
    const frame = requestAnimationFrame(() => {
      const editor = editorRef.current;
      if (!editor) return;
      editor.layout();
      if (markdownViewMode === 'split') {
        if (prevMode === 'preview') {
          const line = markdownPreviewRef.current?.getCurrentSourceLine();
          if (line !== null && line !== undefined) handleMarkdownPreviewScroll(line);
        } else {
          markdownPreviewRef.current?.scrollToSourceLine(getEditorSourceLineAtTop(editor));
        }
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [markdownViewMode, markdownPreviewWidth, handleMarkdownPreviewScroll]);

  const handleEditorMount: OnMount = useCallback((editor) => {
    editorRef.current = editor;
    editor.updateOptions({ contextmenu: false });

    const updateMarkdownPreviewTogglePosition = (layoutInfo: MonacoEditor.EditorLayoutInfo) => {
      const editorChromeWidth = layoutInfo.minimap.minimapWidth > 0
        ? layoutInfo.width - layoutInfo.minimap.minimapLeft
        : layoutInfo.verticalScrollbarWidth;
      const nextRight = Math.max(12, Math.round(editorChromeWidth + 8));
      setMarkdownPreviewToggleRight(current => current === nextRight ? current : nextRight);
    };
    updateMarkdownPreviewTogglePosition(editor.getLayoutInfo());
    editor.onDidLayoutChange(updateMarkdownPreviewTogglePosition);

    editor.onDidScrollChange((event) => {
      if (!event.scrollTopChanged) return;
      if (performance.now() < previewDrivingEditorUntilRef.current) return;
      pendingEditorSourceLineRef.current = getEditorSourceLineAtTop(editor);
      if (editorScrollTimerRef.current) return;
      editorScrollTimerRef.current = setTimeout(() => {
        editorScrollTimerRef.current = null;
        markdownPreviewRef.current?.scrollToSourceLine(pendingEditorSourceLineRef.current);
      }, 50);
    });

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

    if (isMarkdown) {
      editor.addAction({
        id: 'cycle-markdown-view',
        label: '切换 Markdown 视图（源码/分屏/预览）',
        keybindings: [KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyV],
        run: () => setMarkdownViewMode(cycleMarkdownViewMode),
      });
    }

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
  }, [filePath, isMarkdown, onDirtyChange]);

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
            void showAlert('已保存到本地，但上传到服务器失败: ' + String(uploadErr), '上传失败');
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

  // 视图切换控件的位置：源码模式贴在编辑器右上角（避开 minimap/滚动条），
  // 分屏模式同样对齐编辑器右缘，预览模式则贴在预览区右上角。
  const viewToggleRight = markdownViewMode === 'source'
    ? markdownPreviewToggleRight
    : markdownViewMode === 'split'
      ? `calc(var(--markdown-preview-width) + ${markdownPreviewToggleRight + MARKDOWN_PREVIEW_RESIZER_WIDTH}px)`
      : 12;

  if (error) {
    return (
      <div className="text-editor-error">
        <FileWarning className="text-editor-error-icon" aria-hidden="true" />
        <div className="text-editor-error-text">无法打开文件</div>
        <div className="text-editor-error-detail">{error}</div>
      </div>
    );
  }

  if (content === null) {
    return <div className="text-editor-loading">加载中...</div>;
  }

  return (
    <div
      className={
        `text-editor-container`
        + (markdownViewMode === 'split' ? ' markdown-preview-open' : '')
        + (markdownViewMode === 'preview' ? ' markdown-view-preview' : '')
        + (markdownViewMode === 'source' ? ' markdown-view-source' : '')
        + (isMarkdownPreviewResizing ? ' markdown-preview-resizing' : '')
      }
      ref={containerRef}
      style={{ '--markdown-preview-width': `${markdownPreviewWidth}%` } as CSSProperties}
    >
      <div className="text-editor-source" onContextMenu={handleContextMenu}>
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
      </div>
      {isMarkdown && (
        <div
          className="markdown-view-toggle"
          role="group"
          aria-label="Markdown 视图切换"
          style={{ right: viewToggleRight }}
        >
          {MARKDOWN_VIEW_MODES.map(({ mode, label, title, icon: Icon }) => {
            const active = markdownViewMode === mode;
            return (
              <button
                key={mode}
                type="button"
                className={`markdown-view-btn${active ? ' active' : ''}`}
                onClick={() => setMarkdownViewMode(mode)}
                aria-label={`${label}模式`}
                aria-pressed={active}
                title={title}
              >
                <Icon aria-hidden="true" />
              </button>
            );
          })}
        </div>
      )}
      {isMarkdown && (
        <>
          {markdownViewMode === 'split' && (
            <div
              className="markdown-preview-resizer"
              role="separator"
              aria-label="调整编辑区和预览区宽度"
              aria-orientation="vertical"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(100 - markdownPreviewWidth)}
              tabIndex={0}
              title="拖动调整宽度，双击恢复等宽"
              onPointerDown={handleMarkdownResizeStart}
              onPointerMove={handleMarkdownResizeMove}
              onPointerUp={handleMarkdownResizeEnd}
              onPointerCancel={handleMarkdownResizeEnd}
              onKeyDown={handleMarkdownResizeKeyDown}
              onDoubleClick={() => setMarkdownPreviewWidth(MARKDOWN_PREVIEW_DEFAULT_WIDTH)}
            />
          )}
          <div className="markdown-preview-pane">
            <MarkdownPreview
              ref={markdownPreviewRef}
              content={content}
              filePath={filePath}
              onScrollSourceLine={markdownViewMode === 'split' ? handleMarkdownPreviewScroll : undefined}
            />
          </div>
        </>
      )}
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
        <Dialog
          title="文件已被外部修改"
          role="alertdialog"
          className="editor-conflict-dialog"
          bodyClassName="editor-conflict-message"
          footerClassName="editor-conflict-actions"
          onClose={() => setConflictDialog(null)}
          footer={(
            <>
              <button className="editor-conflict-btn overwrite" onClick={handleOverwriteSave}>
                覆盖保存
              </button>
              <button className="editor-conflict-btn discard" onClick={handleDiscard}>
                放弃修改
              </button>
            </>
          )}
        >
          此文件在编辑器外已被修改，且您有未保存的更改。
        </Dialog>
      )}
    </div>
  );
};
