import { FC, useCallback, useEffect, useRef, useState } from 'react';
import type { ClaudeReplayMessage } from '../../services/tauri';
import type { ClaudeReplayTab } from '../../stores/appStore';
import { useAppStore } from '../../stores/appStore';
import { projectForDirectory } from '../../utils/projectPath';
import { ConfirmDialog } from '../shared/Dialog';
import { ClaudeExportDialog } from './ClaudeExportDialog';
import { sessionHistory } from '../../services/sessionHistory';
import './ReplayPage.css';

const PAGE_SIZE = 50;

interface ClaudeReplayTabProps {
  tab: ClaudeReplayTab;
  onClose: () => void;
}

function formatTime(millis: number | null): string {
  if (!millis) return '';
  return new Date(millis).toLocaleString('zh-CN', { hour12: false });
}

const ROLE_LABEL: Record<string, string> = {
  user: '你',
  assistant: 'Claude',
  tool: '工具结果',
  system: '系统摘要',
};

/** 会话回放（特殊标签页）：JSONL 渲染成对话流，分页加载，可锚定搜索命中。 */
export const ReplayPage: FC<ClaudeReplayTabProps> = ({ tab, onClose }) => {
  const provider = tab.provider ?? 'claude';
  const history = sessionHistory(provider);
  const showToast = useAppStore(s => s.showToast);
  const projects = useAppStore(s => s.projects);
  const [messages, setMessages] = useState<ClaudeReplayMessage[]>([]);
  const [total, setTotal] = useState(0);
  const [title, setTitle] = useState(tab.title);
  const [projectDir, setProjectDir] = useState('');
  const [model, setModel] = useState<string | null>(null);
  const [inputTokens, setInputTokens] = useState(0);
  const [outputTokens, setOutputTokens] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [exportOpen, setExportOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const loadingRef = useRef(false);
  const pageRequestRef = useRef(0);
  const bodyRef = useRef<HTMLDivElement>(null);

  // 载入下一页（offset = 当前已载入条数）；focusSeq 存在时循环载入直到覆盖该条
  const loadPage = useCallback(async (offset: number, autoCoverSeq?: number): Promise<void> => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    const request = ++pageRequestRef.current;
    setLoading(true);
    try {
      let currentOffset = offset;
      let first = offset === 0;
      for (;;) {
        const page = await history.replay(tab.sessionId, currentOffset, PAGE_SIZE);
        if (request !== pageRequestRef.current) return;
        setTotal(page.total);
        setTitle(page.title);
        setProjectDir(page.projectDir);
        setModel(page.model);
        setInputTokens(page.inputTokens);
        setOutputTokens(page.outputTokens);
        const replace = first;
        setMessages(prev => replace ? page.messages : [...prev, ...page.messages]);
        first = false;
        currentOffset += page.messages.length;
        const lastSeq = page.messages[page.messages.length - 1]?.seq ?? -1;
        const needMore = autoCoverSeq !== undefined
          && page.messages.length > 0
          && currentOffset < page.total
          && lastSeq < autoCoverSeq;
        if (!needMore) break;
      }
      if (request === pageRequestRef.current) setError('');
    } catch (err) {
      if (request === pageRequestRef.current) setError(String(err));
    } finally {
      if (request === pageRequestRef.current) {
        loadingRef.current = false;
        setLoading(false);
      }
    }
  }, [history, tab.sessionId]);

  useEffect(() => {
    setMessages([]);
    setTotal(0);
    void loadPage(0, tab.focusSeq);
    return () => {
      pageRequestRef.current += 1;
      loadingRef.current = false;
    };
  }, [tab.sessionId, tab.focusSeq, loadPage]);

  // 自动填充未占满的可视区域；滚动接近底部时继续加载下一页。
  const loadIfNearBottom = useCallback(() => {
    const body = bodyRef.current;
    if (!body || loadingRef.current || messages.length >= total || !messages.length) return;
    if (body.scrollHeight - body.scrollTop - body.clientHeight < 240) void loadPage(messages.length);
  }, [messages.length, total, loadPage]);

  useEffect(() => { loadIfNearBottom(); }, [loadIfNearBottom, loading]);

  // 搜索命中锚定滚动
  useEffect(() => {
    if (tab.focusSeq === undefined || messages.length === 0) return;
    const last = messages[messages.length - 1];
    if (!last || last.seq < tab.focusSeq) return;
    const el = document.getElementById(`claude-replay-msg-${tab.focusSeq}`);
    el?.scrollIntoView({ block: 'center' });
  }, [tab.focusSeq, messages]);

  const handleDelete = useCallback(async () => {
    try {
      await history.delete(tab.sessionId);
      showToast('会话记录已移入回收目录', 'success');
      onClose();
    } catch (error) {
      showToast(`删除失败: ${String(error)}`, 'error');
    }
  }, [history, tab.sessionId, onClose, showToast]);

  const tokens = inputTokens + outputTokens;

  return (
    <div className="claude-replay">
      <div className="claude-replay-head">
        <div className="claude-replay-title-block">
          <div className="claude-replay-title">{title}</div>
          <div className="claude-replay-sub">
            {projectDir && <span className="claude-replay-dir" title={projectDir}>
              {projectForDirectory(projects, projectDir)?.name ?? projectDir}
            </span>}
            {model && ` · ${model}`}
            {` · ${total || messages.length} 条消息`}
            {tokens > 0 && ` · ${tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : tokens} tok`}
          </div>
        </div>
        <div className="claude-replay-actions">
          <button
            type="button"
            className="claude-replay-action primary"
            onClick={() => void history.resume({
              sessionId: tab.sessionId,
              title,
              projectDir,
            }).catch(err => showToast(`恢复会话失败: ${String(err)}`, 'error'))}
          >
            ▶ 恢复此会话
          </button>
          <button type="button" className="claude-replay-action" onClick={() => setExportOpen(true)}>⤓ 导出</button>
          <button type="button" className="claude-replay-action danger" onClick={() => setDeleteOpen(true)}>🗑</button>
        </div>
      </div>

      <div className="claude-replay-body" ref={bodyRef} onScroll={loadIfNearBottom}>
        {error && <div className="claude-replay-error">{error}</div>}
        {!error && !loading && messages.length === 0 && (
          <div className="claude-replay-empty">会话内容为空</div>
        )}
        {messages.map(message => (
          <div
            key={message.seq}
            id={`claude-replay-msg-${message.seq}`}
            className={`claude-replay-msg role-${message.role}${tab.focusSeq === message.seq ? ' focused' : ''}`}
          >
            <div className="claude-replay-msg-head">
              <span className="claude-replay-role">● {message.role === 'assistant' ? (provider === 'codex' ? 'Codex' : provider === 'pi' ? 'Pi' : 'Claude') : ROLE_LABEL[message.role] ?? message.role}</span>
              {formatTime(message.timestamp) && <span className="claude-replay-time">{formatTime(message.timestamp)}</span>}
              {message.toolName && <span className="claude-replay-toolname">{message.toolName}</span>}
            </div>
            {message.role === 'tool' ? (
              <details className="claude-replay-tool-result">
                <summary>工具结果{message.toolName ? ` · ${message.toolName}` : ''}</summary>
                <pre className="claude-replay-text">{message.text}</pre>
              </details>
            ) : (
              <>
                {message.text && (message.text.length > 1200 || message.text.split("\n").length > 18 ? (
                  <details className="claude-replay-long-text">
                    <summary>{message.text.slice(0, 180).replace(/\s+/g, " ")}… <span>展开完整内容（{message.text.length} 字）</span></summary>
                    <div className="claude-replay-text">{message.text}</div>
                  </details>
                ) : <div className="claude-replay-text">{message.text}</div>)}
                {message.tools.map((tool, index) => (
                  <div key={`${message.seq}-tool-${index}`} className="claude-replay-tool">
                    ▸ {tool.name}{tool.summary ? ` · ${tool.summary}` : ''}
                  </div>
                ))}
              </>
            )}
          </div>
        ))}
        {messages.length < total && (
          <button
            type="button"
            className="claude-replay-more"
            disabled={loading}
            onClick={() => void loadPage(messages.length)}
          >
            {loading ? '加载中…' : `加载更多（已显示 ${messages.length} / ${total}）`}
          </button>
        )}
      </div>

      {exportOpen && (
        <ClaudeExportDialog
          provider={provider}
          sessionId={tab.sessionId}
          title={title}
          onClose={() => setExportOpen(false)}
        />
      )}
      {deleteOpen && (
        <ConfirmDialog
          title="删除会话记录"
          message={`「${title}」的记录文件将移入回收目录（dataPath/Trash），索引同步清理。确定删除吗？`}
          confirmText="删除"
          onClose={() => setDeleteOpen(false)}
          onConfirm={() => void handleDelete()}
        />
      )}
    </div>
  );
};
