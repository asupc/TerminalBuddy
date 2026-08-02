import { useState } from "react";
import { DiffEditor } from "@monaco-editor/react";
import type { AiReviewDiffContent, AiReviewDiffFile } from "../../types/aiDelivery";

export interface ReviewComment {
  line: number;
  text: string;
}

interface ReviewDiffViewProps {
  files: AiReviewDiffFile[];
  diffs: AiReviewDiffContent[];
  comments: Record<string, ReviewComment[]>;
  onComment: (path: string, line: number, text: string) => void;
}

function fileLanguage(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  switch (extension) {
    case "ts":
    case "tsx":
      return "typescript";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "javascript";
    case "rs":
      return "rust";
    case "json":
      return "json";
    case "md":
      return "markdown";
    case "css":
      return "css";
    case "html":
      return "html";
    case "py":
      return "python";
    case "go":
      return "go";
    case "sh":
    case "bat":
    case "ps1":
      return "shell";
    default:
      return "plaintext";
  }
}

/** 增量 Diff 审查：文件 tab + Monaco Diff Editor + 行评论（点击修改侧行号添加）。 */
export function ReviewDiffView({ files, diffs, comments, onComment }: ReviewDiffViewProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [commentLine, setCommentLine] = useState<number | null>(null);
  const [commentDraft, setCommentDraft] = useState("");
  const [commentPath, setCommentPath] = useState("");

  const activeFile = files[activeIndex];
  const activeDiff = diffs.find((item) => item.path === activeFile?.path);
  const fileComments = activeFile ? comments[activeFile.path] ?? [] : [];
  const statusLabel: Record<string, string> = { A: "新增", M: "修改", D: "删除", R: "重命名" };

  const submitComment = () => {
    if (!commentDraft.trim() || !commentPath) return;
    onComment(commentPath, commentLine ?? 1, commentDraft.trim());
    setCommentLine(null);
    setCommentDraft("");
  };

  return (
    <div className="ai-review-diff">
      <div className="ai-review-file-tabs">
        {files.map((file, index) => {
          const count = (comments[file.path] ?? []).length;
          return (
            <button
              type="button"
              key={file.path}
              className={index === activeIndex ? "active" : ""}
              onClick={() => {
                setActiveIndex(index);
                setCommentLine(null);
                setCommentDraft("");
              }}
            >
              <span className="ai-review-file-path">{file.path}</span>
              <small>
                {statusLabel[file.status] ?? file.status}
                {file.additions > 0 && ` +${file.additions}`}
                {file.deletions > 0 && ` -${file.deletions}`}
                {count > 0 && ` · ${count} 评`}
              </small>
            </button>
          );
        })}
      </div>
      {activeDiff && (
        <div className="ai-review-diff-editor">
          <DiffEditor
            language={fileLanguage(activeDiff.path)}
            original={activeDiff.original}
            modified={activeDiff.modified}
            height="400px"
            theme="vs-dark"
            onMount={(editor, monaco) => {
              const modified = editor.getModifiedEditor();
              modified.onMouseDown((event) => {
                if (
                  event.target.type === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS
                  && event.target.position
                ) {
                  setCommentPath(activeFile?.path ?? "");
                  setCommentLine(event.target.position.lineNumber);
                  setCommentDraft("");
                }
              });
            }}
            options={{
              readOnly: true,
              minimap: { enabled: false },
              fontSize: 13,
              scrollBeyondLastLine: false,
              automaticLayout: true,
              renderSideBySide: true,
              originalEditable: false,
            }}
          />
        </div>
      )}
      {commentLine !== null && (
        <div className="ai-review-comment-input">
          <span>行 {commentLine} 评论</span>
          <textarea
            value={commentDraft}
            placeholder="输入行评论..."
            onChange={(event) => setCommentDraft(event.target.value)}
          />
          <button
            type="button"
            className="btn-primary"
            disabled={!commentDraft.trim()}
            onClick={submitComment}
          >
            添加评论
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setCommentLine(null)}
          >
            取消
          </button>
        </div>
      )}
      {fileComments.length > 0 && (
        <ul className="ai-review-comments">
          {fileComments.map((item, index) => (
            <li key={`${item.line}-${index}`}>
              <span className="ai-review-comment-line">行 {item.line}</span>
              <span>{item.text}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
