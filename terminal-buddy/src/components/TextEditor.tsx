import { FC, useEffect, useRef, useState, useCallback } from 'react';
import Editor, { OnMount } from '@monaco-editor/react';
import { editor as MonacoEditor, KeyMod, KeyCode } from 'monaco-editor';
import { readFileContent, writeFileContent } from '../services/tauri';
import { getMonacoLanguage } from '../utils/fileExtensions';
import './TextEditor.css';

interface TextEditorProps {
  filePath: string;
  isDirty: boolean;
  onDirtyChange: (dirty: boolean) => void;
  isActive: boolean;
}

export const TextEditor: FC<TextEditorProps> = ({ filePath, isDirty: _isDirty, onDirtyChange, isActive: _isActive }) => {
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

    editor.addAction({
      id: 'save-file',
      label: '保存文件',
      keybindings: [KeyMod.CtrlCmd | KeyCode.KeyS],
      run: async (ed) => {
        const value = ed.getValue();
        try {
          await writeFileContent(filePath, value);
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
    <div className="text-editor-container">
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
  );
};
