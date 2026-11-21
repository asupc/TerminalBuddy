import { FC } from 'react';
import { DiffEditor, type DiffOnMount } from '@monaco-editor/react';
import type { editor as MonacoEditor } from 'monaco-editor';
import { attachSafeDiffModelDisposal } from '../../utils/monacoLoader';
import type { GitHistoryFile, GitHistoryFileDiff } from '../../services/tauri';
import { getMonacoLanguage } from '../../utils/fileExtensions';

const HISTORY_DIFF_OPTIONS: MonacoEditor.IDiffEditorConstructionOptions = {
  readOnly: true,
  originalEditable: false,
  automaticLayout: true,
  renderSideBySide: true,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  wordWrap: 'off',
  folding: true,
  renderWhitespace: 'selection',
};

const handleDiffMount: DiffOnMount = (diffEditor) => {
  attachSafeDiffModelDisposal(diffEditor);
};

interface GitHistoryDiffPreviewProps {
  selectedFile: GitHistoryFile | null;
  diff: GitHistoryFileDiff | null;
  loading: boolean;
  error: string;
}

function shortRevision(revision?: string): string {
  return revision ? revision.slice(0, 8) : '-';
}

export const GitHistoryDiffPreview: FC<GitHistoryDiffPreviewProps> = ({
  selectedFile,
  diff,
  loading,
  error,
}) => {
  if (!selectedFile) {
    return <div className="git-history-diff-empty">未选择文件</div>;
  }

  const title = selectedFile.oldPath && selectedFile.oldPath !== selectedFile.path
    ? `${selectedFile.oldPath} -> ${selectedFile.path}`
    : selectedFile.path;

  return (
    <div className="git-history-diff">
      <div className="git-history-diff-header">
        <div className="git-history-diff-title" title={title}>
          <span className={`git-history-file-status ${selectedFile.statusCode}`}>{selectedFile.statusCode}</span>
          <span>{title}</span>
        </div>
        <div className="git-history-diff-meta">
          {diff ? `${shortRevision(diff.oldRevision)} -> ${shortRevision(diff.newRevision)}` : selectedFile.status}
        </div>
      </div>

      {loading && <div className="git-history-diff-empty">加载中...</div>}
      {!loading && error && <div className="git-history-diff-empty error">{error}</div>}
      {!loading && !error && diff?.binary && (
        <div className="git-history-diff-empty">二进制文件暂不支持文本预览。</div>
      )}
      {!loading && !error && diff && !diff.binary && (
        <DiffEditor
          height="100%"
          language={getMonacoLanguage(diff.path)}
          modified={diff.newContent}
          original={diff.oldContent}
          keepCurrentOriginalModel
          keepCurrentModifiedModel
          onMount={handleDiffMount}
          theme="vs-dark"
          options={HISTORY_DIFF_OPTIONS}
        />
      )}
    </div>
  );
};
