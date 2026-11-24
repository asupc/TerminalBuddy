import { CSSProperties, FC, KeyboardEvent, PointerEvent, memo, useEffect, useRef, useState, useCallback } from 'react';
import { Columns2, Eye, FileCode2, FileWarning, TriangleAlert, X } from 'lucide-react';
import Editor, { DiffEditor, type DiffOnMount, type OnMount } from '@monaco-editor/react';
import { editor as MonacoEditor, KeyMod, KeyCode, type IDisposable } from 'monaco-editor';
import { attachSafeDiffModelDisposal } from '../../utils/monacoLoader';
import { onPageVisible } from '../../utils/visibility';
import { readFileContent, writeFileContent, remoteUpload, getFileMeta, onTransferProgress, onTransferError } from '../../services/tauri';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { useAppStore } from '../../stores/appStore';
import { getMonacoLanguage, isMarkdownFile } from '../../utils/fileExtensions';
import { getMarkdownDefaultViewMode } from '../../utils/settings';
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

const TEXT_EDITOR_OPTIONS: MonacoEditor.IStandaloneEditorConstructionOptions = {
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
};

const TEXT_EDITOR_DIFF_OPTIONS: MonacoEditor.IDiffEditorConstructionOptions = {
  fontSize: 14,
  readOnly: true,
  renderSideBySide: true,
  automaticLayout: true,
  scrollBeyondLastLine: false,
  wordWrap: 'on',
  renderOverviewRuler: false,
};

const handleConflictDiffMount: DiffOnMount = (diffEditor) => {
  attachSafeDiffModelDisposal(diffEditor);
};

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

/** 打开文件时的初始视图：Markdown 按设置项，其他文件固定源码模式。 */
function getInitialMarkdownViewMode(path: string): MarkdownViewMode {
  return isMarkdownFile(path) ? getMarkdownDefaultViewMode() : 'source';
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
  sessionId?: string;
  filePath: string;
  isDirty: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  onSessionDirtyChange?: (sessionId: string, dirty: boolean) => void;
  isActive: boolean;
}

export const TextEditor: FC<TextEditorProps> = memo(({
  sessionId,
  filePath,
  isDirty,
  onDirtyChange,
  onSessionDirtyChange,
  isActive,
}) => {
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const editorDisposablesRef = useRef<IDisposable[]>([]);
  const markdownPreviewRef = useRef<MarkdownPreviewHandle>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [conflictNotice, setConflictNotice] = useState(false);
  const [diffDiskContent, setDiffDiskContent] = useState<string | null>(null);
  const [saveNotify, setSaveNotify] = useState<{ type: 'saving' | 'success' | 'error'; msg: string } | null>(null);
  const [markdownViewMode, setMarkdownViewMode] = useState<MarkdownViewMode>(() => getInitialMarkdownViewMode(filePath));
  const [markdownPreviewWidth, setMarkdownPreviewWidth] = useState(MARKDOWN_PREVIEW_DEFAULT_WIDTH);
  const [isMarkdownPreviewResizing, setIsMarkdownPreviewResizing] = useState(false);
  const [markdownPreviewToggleRight, setMarkdownPreviewToggleRight] = useState(112);
  const prevMarkdownViewModeRef = useRef<MarkdownViewMode>('source');
  const saveNotifyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const markdownResizePointerRef = useRef<number | null>(null);
  const editorScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingEditorSourceLineRef = useRef(0);
  const previewDrivingEditorUntilRef = useRef(0);
  const diskMetaRef = useRef<{ lastModified: number; size: number }>({ lastModified: 0, size: 0 });
  const isDirtyRef = useRef(isDirty);
  const lastLoadedContentRef = useRef<string | null>(null);
  const isInternalUpdateRef = useRef(false);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // 已提示过冲突的磁盘版本（关闭提示后不再为同一版本重弹，直到磁盘出现新变化）
  const notifiedModTimeRef = useRef(0);
  const diffDiskContentRef = useRef<string | null>(null);
  const isMarkdown = isMarkdownFile(filePath);
  const isMarkdownRef = useRef(isMarkdown);
  isMarkdownRef.current = isMarkdown;
  const loadSeqRef = useRef(0);
  const unmountedRef = useRef(false);

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      loadSeqRef.current += 1;
    };
  }, []);

  isDirtyRef.current = isDirty;
  diffDiskContentRef.current = diffDiskContent;

  const reportDirty = useCallback((dirty: boolean) => {
    onDirtyChange?.(dirty);
    if (sessionId !== undefined) onSessionDirtyChange?.(sessionId, dirty);
  }, [onDirtyChange, onSessionDirtyChange, sessionId]);
  const reportDirtyRef = useRef(reportDirty);
  reportDirtyRef.current = reportDirty;

  const loadFileContent = useCallback(async (forceReload = false) => {
    const seq = ++loadSeqRef.current;
    const targetPath = filePath;
    try {
      // 先取 meta 再读内容：若文件在两步之间被外部修改，记录的 mtime 落后于磁盘，
      // 下次轮询仍会发现并重载；反过来（记新 mtime 留旧内容）会造成漏检。
      const meta = await getFileMeta(targetPath);
      if (seq !== loadSeqRef.current) return;
      if (!forceReload && diskMetaRef.current.lastModified !== 0
        && meta.lastModified === diskMetaRef.current.lastModified && meta.size === diskMetaRef.current.size) {
        return;
      }
      const text = await readFileContent(targetPath);
      if (seq !== loadSeqRef.current) return;
      diskMetaRef.current = meta;
      lastLoadedContentRef.current = text;

      setContent(text);
      setError(null);

      if (editorRef.current) {
        const model = editorRef.current.getModel();
        if (model && model.getValue() !== text) {
          // isInternalUpdateRef 只在真正会触发 change 事件的 setValue 前置位，
          // 否则标志滞留会吞掉用户下一次编辑的 dirty 标记。
          isInternalUpdateRef.current = true;
          // 静默重载时保持光标与滚动位置
          const viewState = editorRef.current.saveViewState();
          model.setValue(text);
          if (viewState) editorRef.current.restoreViewState(viewState);
        }
      }

      // 磁盘内容已成为当前内容，冲突随之解除
      setConflictNotice(false);
      setDiffDiskContent(null);
      notifiedModTimeRef.current = 0;
    } catch (err) {
      if (seq !== loadSeqRef.current) return;
      setError(String(err));
      setContent(null);
    }
  }, [filePath]);

  // Auto-save for draft files (files in ClientData/drafts/)
  const isDraft = filePath.includes('\\drafts\\draft_') || filePath.includes('/drafts/draft_');
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentRef = useRef(content);
  contentRef.current = content;
  const isDraftRef = useRef(isDraft);
  isDraftRef.current = isDraft;
  const filePathRef = useRef(filePath);
  filePathRef.current = filePath;

  const flushDraftRef = useRef<() => void>(() => {});
  flushDraftRef.current = () => {
    const current = contentRef.current;
    const path = filePathRef.current;
    if (!isDraftRef.current || current === null || current === lastLoadedContentRef.current) return;
    writeFileContent(path, current).then(() => {
      lastLoadedContentRef.current = current;
      getFileMeta(path).then(meta => { diskMetaRef.current = meta; }).catch(() => {});
    }).catch(console.error);
  };

  useEffect(() => {
    if (!isDraft || !isActive) {
      if (autoSaveTimerRef.current) {
        clearInterval(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      }
      return;
    }
    autoSaveTimerRef.current = setInterval(() => {
      if (!document.hidden) flushDraftRef.current();
    }, 3000);
    return () => {
      if (autoSaveTimerRef.current) {
        clearInterval(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      }
      // 注意：这里不能在 filePath 变化时落盘。依赖变化（另存为）时闭包里的旧草稿路径
      // 已被删除；停用标签或卸载由下面的 effect 统一落盘。
    };
  }, [isDraft, isActive, filePath]);

  const wasActiveRef = useRef(isActive);
  useEffect(() => {
    if (wasActiveRef.current && !isActive) {
      flushDraftRef.current();
    }
    wasActiveRef.current = isActive;
  }, [isActive]);

  // 组件卸载（关闭/切换标签）时立即落盘并回收定时器和 Monaco 监听。
  useEffect(() => () => {
    flushDraftRef.current();
    if (saveNotifyTimerRef.current) {
      clearTimeout(saveNotifyTimerRef.current);
      saveNotifyTimerRef.current = null;
    }
    editorDisposablesRef.current.forEach(d => d.dispose());
    editorDisposablesRef.current = [];
  }, []);

  // Initial load（走 loadFileContent，保证“先取 meta 后读内容”的防漏检顺序）
  useEffect(() => {
    void loadFileContent(true);
  }, [filePath]);

  // 切到对比视图时源码编辑器被卸载，清空引用，避免对已 dispose 的 model 操作
  useEffect(() => {
    if (diffDiskContent !== null) editorRef.current = null;
  }, [diffDiskContent]);

  // 磁盘变化检查：未修改时静默重载；有未保存修改时提示冲突。
  // 同一磁盘版本只提示一次，用户关闭提示后不再重弹，直到磁盘出现新变化。
  const checkDiskChange = useCallback(async () => {
    try {
      const meta = await getFileMeta(filePath);
      if (meta.lastModified === diskMetaRef.current.lastModified && meta.size === diskMetaRef.current.size) return;

      if (!isDirtyRef.current) {
        await loadFileContent(true);
        return;
      }
      if (meta.lastModified !== notifiedModTimeRef.current) {
        notifiedModTimeRef.current = meta.lastModified;
        setConflictNotice(true);
        // 对比视图打开期间磁盘又变了，刷新左侧的磁盘版本
        if (diffDiskContentRef.current !== null) {
          readFileContent(filePath).then(setDiffDiskContent).catch(() => {});
        }
      }
    } catch {}
  }, [filePath, loadFileContent]);

  // Re-read file when switching to this tab
  useEffect(() => {
    if (!isActive) return;
    void checkDiskChange();
  }, [isActive, checkDiskChange]);

  // Poll for external changes when active and visible
  useEffect(() => {
    if (!isActive) {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      return;
    }
    pollTimerRef.current = setInterval(() => {
      if (!document.hidden) void checkDiskChange();
    }, 3000);
    const unlistenVisible = onPageVisible(() => { void checkDiskChange(); });
    return () => {
      unlistenVisible();
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [isActive, checkDiskChange]);

  // 打开 / 切换文件时按默认打开方式设置回到初始视图；非 Markdown 始终源码模式。
  useEffect(() => {
    setMarkdownViewMode(getInitialMarkdownViewMode(filePath));
  }, [filePath, isMarkdown]);

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
    editorDisposablesRef.current.forEach(d => d.dispose());
    editorDisposablesRef.current = [];
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
    editorDisposablesRef.current.push(editor.onDidLayoutChange(updateMarkdownPreviewTogglePosition));

    editorDisposablesRef.current.push(editor.onDidScrollChange((event) => {
      if (!event.scrollTopChanged) return;
      if (performance.now() < previewDrivingEditorUntilRef.current) return;
      pendingEditorSourceLineRef.current = getEditorSourceLineAtTop(editor);
      if (editorScrollTimerRef.current) return;
      editorScrollTimerRef.current = setTimeout(() => {
        editorScrollTimerRef.current = null;
        markdownPreviewRef.current?.scrollToSourceLine(pendingEditorSourceLineRef.current);
      }, 50);
    }));

    const showSaveNotify = (type: 'saving' | 'success' | 'error', msg: string) => {
      if (unmountedRef.current) return;
      if (saveNotifyTimerRef.current) clearTimeout(saveNotifyTimerRef.current);
      setSaveNotify({ type, msg });
      if (type !== 'saving') {
        saveNotifyTimerRef.current = setTimeout(() => {
          if (!unmountedRef.current) setSaveNotify(null);
        }, 3000);
      }
    };

    editorDisposablesRef.current.push(editor.addAction({
      id: 'save-file',
      label: '保存文件',
      keybindings: [KeyMod.CtrlCmd | KeyCode.KeyS],
      run: async (ed) => {
        const value = ed.getValue();
        try {
          const currentPath = filePathRef.current;
          let savePath = currentPath;
          let isNewSave = false;

          // If this is a draft file, prompt for save location
          if (isDraftRef.current) {
            const savedPath = await saveDialog({
              defaultPath: '未命名.txt',
              filters: [{ name: '文本文件', extensions: ['txt'] }, { name: '所有文件', extensions: ['*'] }],
            });
            if (!savedPath) return; // User cancelled
            savePath = savedPath;
            isNewSave = true;
          }

          await writeFileContent(savePath, value);

          // 本地写盘已成功：立即同步保存基准并解除冲突。
          // 必须在进入 SSH 上传等长等待之前执行，否则等待期内的输入会被
          // 收尾处的 onDirtyChange(false) 误标为已保存（关标签即丢内容）。
          lastLoadedContentRef.current = value;
          reportDirtyRef.current(ed.getValue() !== value);
          const savedMeta = await getFileMeta(savePath).catch(() => null);
          if (savedMeta) diskMetaRef.current = savedMeta;
          if (!unmountedRef.current) {
            setConflictNotice(false);
            setDiffDiskContent(null);
          }
          notifiedModTimeRef.current = 0;

          // If this was a draft that was saved to a new location, clean up
          if (isNewSave) {
            // Remove draft file and update draft index
            const { removeDraftFile, updateSession } = useAppStore.getState();
            await removeDraftFile(currentPath);

            // Update session with new path and name
            const session = useAppStore.getState().sessions.find(
              s => s.sessionType === 'editor' && s.profileId === currentPath
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
            // 先挂接传输监听再发起上传，避免秒传 100% 事件早于监听注册而超时
            let done = false;
            let settled = false;
            let unlistenProgress: (() => void) | undefined;
            let unlistenError: (() => void) | undefined;
            let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
            let resolveUpload!: () => void;
            const uploadDone = new Promise<void>((resolve) => {
              resolveUpload = resolve;
            });
            const finish = () => {
              if (settled) return;
              settled = true;
              if (timeoutTimer) {
                clearTimeout(timeoutTimer);
                timeoutTimer = null;
              }
              unlistenProgress?.();
              unlistenError?.();
              resolveUpload();
            };

            const listenReady = Promise.all([
              onTransferProgress((progress) => {
                if (progress.transferId === transferId && progress.percent >= 100 && !done) {
                  done = true;
                  showSaveNotify('success', '已保存并上传到服务器');
                  finish();
                }
              }).then(fn => { unlistenProgress = fn; if (done) fn(); }),
              onTransferError((evt) => {
                if (evt.transferId === transferId && !done) {
                  done = true;
                  showSaveNotify('error', '上传失败: ' + evt.error);
                  finish();
                }
              }).then(fn => { unlistenError = fn; if (done) fn(); }),
            ]);

            try {
              await listenReady;
              const terminalSession = useAppStore.getState().sessions.find(s => s.id === session.sshTerminalId);
              await remoteUpload(session.sshTerminalId, savePath, session.sshRemotePath, transferId, terminalSession?.profileId || '');
            } catch (uploadErr) {
              done = true;
              finish();
              showSaveNotify('error', '上传失败: ' + String(uploadErr));
              return;
            }

            if (!done) {
              // Timeout fallback（本地已保存，超时只影响上传确认，给出明确提示）
              timeoutTimer = setTimeout(() => {
                if (!done) {
                  done = true;
                  showSaveNotify('error', '上传超时：本地已保存，请在传输面板确认上传结果');
                  finish();
                }
              }, 30000);
            }
            await uploadDone;
          } else {
            showSaveNotify('success', '已保存');
          }
        } catch (err) {
          console.error('Failed to save file:', err);
          showSaveNotify('error', '保存失败');
        }
      },
    }));

    editorDisposablesRef.current.push(editor.addAction({
      id: 'cycle-markdown-view',
      label: '切换 Markdown 视图（源码/分屏/预览）',
      keybindings: [KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyV],
      run: () => {
        if (!isMarkdownRef.current) return;
        setMarkdownViewMode(cycleMarkdownViewMode);
      },
    }));

    editorDisposablesRef.current.push(editor.addAction({
      id: 'format-document',
      label: '格式化文档',
      keybindings: [KeyMod.Shift | KeyMod.Alt | KeyCode.KeyF],
      run: async (ed) => {
        await ed.getAction('editor.action.formatDocument')?.run();
      },
    }));

    editorDisposablesRef.current.push(editor.onDidChangeModelContent(() => {
      if (!isInternalUpdateRef.current) {
        // 与最后加载/保存的内容比较，undo 回到原样时 dirty 也随之恢复为 false
        reportDirtyRef.current(editor.getValue() !== lastLoadedContentRef.current);
      }
      isInternalUpdateRef.current = false;
    }));
  }, []);

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
    // 对比视图下源码编辑器已卸载，改用受控的 content state
    const value = editorRef.current?.getValue() ?? content;
    if (value !== null) {
      try {
        await writeFileContent(filePath, value);
        lastLoadedContentRef.current = value;
        const meta = await getFileMeta(filePath).catch(() => null);
        if (meta) diskMetaRef.current = meta;
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
        // 与保存动作一致：以上传发起前的实时内容复核，避免等待窗口内的输入被误标已保存
        reportDirty((editorRef.current?.getValue() ?? value) !== value);
      } catch (err) {
        console.error('Failed to save file:', err);
      }
    }
    setConflictNotice(false);
    setDiffDiskContent(null);
    notifiedModTimeRef.current = 0;
  }, [filePath, content, reportDirty]);

  const handleDiscard = useCallback(async () => {
    await loadFileContent(true);
    reportDirty(false);
  }, [loadFileContent, reportDirty]);

  const openDiffView = useCallback(async () => {
    try {
      const text = await readFileContent(filePath);
      setDiffDiskContent(text);
    } catch (err) {
      void showAlert(String(err), '读取磁盘文件失败');
    }
  }, [filePath]);

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
      {diffDiskContent !== null ? (
        <div className="text-editor-diff">
          <div className="text-editor-diff-header">
            <span>磁盘版本（左）</span>
            <span className="text-editor-diff-vs">对比</span>
            <span>当前修改（右）</span>
          </div>
          <div className="text-editor-diff-body">
            <DiffEditor
              height="100%"
              language={getMonacoLanguage(filePath)}
              original={diffDiskContent}
              modified={content}
              keepCurrentOriginalModel
              keepCurrentModifiedModel
              onMount={handleConflictDiffMount}
              theme="vs-dark"
              options={TEXT_EDITOR_DIFF_OPTIONS}
            />
          </div>
        </div>
      ) : (
        <>
          <div className="text-editor-source" onContextMenu={handleContextMenu}>
            <Editor
              height="100%"
              language={getMonacoLanguage(filePath)}
              value={content}
              onMount={handleEditorMount}
              theme="vs-dark"
              options={TEXT_EDITOR_OPTIONS}
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
          {isMarkdown && markdownViewMode !== 'source' && (
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
      {conflictNotice && (
        <div className="editor-conflict-banner" role="alert">
          <TriangleAlert className="editor-conflict-banner-icon" aria-hidden="true" />
          <span className="editor-conflict-banner-text">文件已在磁盘上被修改，编辑器中的更改尚未保存</span>
          <div className="editor-conflict-banner-actions">
            {diffDiskContent === null ? (
              <button className="editor-conflict-btn ghost" onClick={openDiffView}>
                对比差异
              </button>
            ) : (
              <button className="editor-conflict-btn ghost" onClick={() => setDiffDiskContent(null)}>
                返回编辑
              </button>
            )}
            <button className="editor-conflict-btn overwrite" onClick={handleOverwriteSave}>
              覆盖保存
            </button>
            <button className="editor-conflict-btn discard" onClick={handleDiscard}>
              还原磁盘版本
            </button>
          </div>
          <button
            className="editor-conflict-banner-close"
            aria-label="暂不处理"
            title="暂不处理，磁盘再次变化时重新提示"
            onClick={() => setConflictNotice(false)}
          >
            <X aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
});
