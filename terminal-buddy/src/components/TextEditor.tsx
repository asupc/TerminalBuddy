import { FC, useEffect, useRef, useState, useCallback } from 'react';
import Editor, { OnMount } from '@monaco-editor/react';
import { editor as MonacoEditor, KeyMod, KeyCode } from 'monaco-editor';
import { readFileContent, writeFileContent, remoteUpload } from '../services/tauri';
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

export const TextEditor: FC<TextEditorProps> = ({ filePath, isDirty: _isDirty, onDirtyChange, isActive: _isActive }) => {
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    readFileContent(filePath)
      .then((text) => {
        if (!cancelled) {
          setContent(text);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(String(err));
          setContent(null);
        }
      });
    return () => { cancelled = true; };
  }, [filePath]);

  const handleEditorMount: OnMount = useCallback((editor) => {
    editorRef.current = editor;
    editor.updateOptions({ contextmenu: false });

    editor.addAction({
      id: 'save-file',
      label: '保存文件',
      keybindings: [KeyMod.CtrlCmd | KeyCode.KeyS],
      run: async (ed) => {
        const value = ed.getValue();
        try {
          await writeFileContent(filePath, value);
          const session = useAppStore.getState().sessions.find(
            s => s.sessionType === 'editor' && s.profileId === filePath
          );
          if (session?.sshRemotePath && session?.sshTerminalId) {
            try {
              await remoteUpload(session.sshTerminalId, filePath, session.sshRemotePath);
              console.log('已自动上传到服务器:', session.sshRemotePath);
            } catch (uploadErr) {
              console.error('Auto-upload to server failed:', uploadErr);
            }
          }
          onDirtyChange(false);
        } catch (err) {
          console.error('Failed to save file:', err);
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
      onDirtyChange(true);
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
      {ctxMenu && (
        <>
          <div className="editor-ctx-overlay" onClick={() => setCtxMenu(null)} />
          <div className="editor-ctx-menu" style={{ left: ctxMenu.x, top: ctxMenu.y }}>
            {CONTEXT_MENU_ITEMS.map((item) =>
              item.id === '---' ? (
                <div key={Math.random()} className="editor-ctx-separator" />
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
    </div>
  );
};
