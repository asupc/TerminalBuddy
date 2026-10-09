import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type UIEvent,
} from 'react';
import { ArrowLeft, MoreHorizontal } from 'lucide-react';
import { api, exportClaudeSessionContent } from '../api';
import { Dialog } from '../components/Dialog';
import { useStore } from '../store';
import type { ClaudeReplayMessage, ClaudeReplayPage, Project } from '../types';

const PAGE_SIZE = 50;
const ROLE_LABEL: Record<string, string> = {
  user: '你',
  assistant: 'Claude',
  tool: '工具结果',
};

/** 与 PC 端 utils/projectPath.ts 同规则的目录匹配，用于分组名与恢复目录 */
function normalizeProjectPath(path: string): string {
  const normalized = path.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const prefix = normalized.startsWith('//') ? '//' : normalized.startsWith('/') ? '/' : '';
  const segments: string[] = [];
  for (const segment of normalized.slice(prefix.length).split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..' && segments.length && segments[segments.length - 1] !== '..' && !segments[segments.length - 1].endsWith(':')) segments.pop();
    else if (segment !== '..' || !prefix) segments.push(segment);
  }
  return prefix + segments.join('/');
}

function projectForDirectory(projects: Project[], dir: string): Project | undefined {
  const key = normalizeProjectPath(dir);
  return projects
    .filter((p) => {
      const base = normalizeProjectPath(p.path);
      return base && (key === base || key.startsWith(`${base}/`));
    })
    .sort((a, b) => normalizeProjectPath(b.path).length - normalizeProjectPath(a.path).length)[0];
}

function formatTime(millis: number | null): string {
  if (!millis) return '';
  return new Date(millis).toLocaleString('zh-CN', { hour12: false });
}

interface Props {
  sessionId: string;
  title?: string;
  /** 全文检索命中锚定跳转的消息 seq（循环翻页直到覆盖后滚动定位） */
  focusSeq?: number;
}

/** 会话回放（Web 版）：JSONL 渲染成对话流，滚动触底分页加载，可恢复 / 导出 / 删除。 */
export default function ClaudeReplay({ sessionId, title: initialTitle, focusSeq }: Props) {
  const setView = useStore((state) => state.setView);
  const projects = useStore((state) => state.projects);

  const [messages, setMessages] = useState<ClaudeReplayMessage[]>([]);
  const [total, setTotal] = useState(0);
  const [title, setTitle] = useState(initialTitle ?? '');
  const [projectDir, setProjectDir] = useState('');
  const [model, setModel] = useState<string | null>(null);
  const [inputTokens, setInputTokens] = useState(0);
  const [outputTokens, setOutputTokens] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [resuming, setResuming] = useState(false);
  const loadingRef = useRef(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  // 载入下一页；focusSeq 存在时循环载入直到覆盖该条（与 PC 端 ReplayPage 一致）
  const loadPage = useCallback(
    async (offset: number, autoCoverSeq?: number): Promise<void> => {
      if (loadingRef.current) return;
      loadingRef.current = true;
      setLoading(true);
      try {
        let currentOffset = offset;
        let first = offset === 0;
        for (;;) {
          const page: ClaudeReplayPage = await api.getClaudeReplay(sessionId, currentOffset, PAGE_SIZE);
          setTotal(page.total);
          setTitle(page.title);
          setProjectDir(page.projectDir);
          setModel(page.model);
          setInputTokens(page.inputTokens);
          setOutputTokens(page.outputTokens);
          setMessages((prev) => (first ? page.messages : [...prev, ...page.messages]));
          first = false;
          currentOffset += page.messages.length;
          const lastSeq = page.messages[page.messages.length - 1]?.seq ?? -1;
          const needMore =
            autoCoverSeq !== undefined &&
            page.messages.length > 0 &&
            currentOffset < page.total &&
            lastSeq < autoCoverSeq;
          if (!needMore) break;
        }
        setError('');
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : '加载会话内容失败');
      } finally {
        loadingRef.current = false;
        setLoading(false);
      }
    },
    [sessionId],
  );

  useEffect(() => {
    setMessages([]);
    setTotal(0);
    void loadPage(0, focusSeq);
  }, [sessionId, focusSeq, loadPage]);

  // 滚动接近底部时继续加载下一页
  const loadIfNearBottom = useCallback(() => {
    const body = bodyRef.current;
    if (!body || loadingRef.current || messages.length >= total || !messages.length) return;
    if (body.scrollHeight - body.scrollTop - body.clientHeight < 240) void loadPage(messages.length);
  }, [messages.length, total, loadPage]);

  useEffect(() => {
    loadIfNearBottom();
  }, [loadIfNearBottom, loading]);

  // 搜索命中锚定滚动
  useEffect(() => {
    if (focusSeq === undefined || messages.length === 0) return;
    const last = messages[messages.length - 1];
    if (!last || last.seq < focusSeq) return;
    document.getElementById(`claude-replay-msg-${focusSeq}`)?.scrollIntoView({ block: 'center' });
  }, [focusSeq, messages]);

  const goBack = () => setView({ screen: 'nav' });

  const resumeSession = useCallback(async () => {
    if (!projectDir) return;
    setResuming(true);
    setError('');
    try {
      const info = await api.createTerminal('', {
        displayName: title,
        startupPath: projectDir,
        startupGroup: projectForDirectory(projects, projectDir)?.name,
        startupCommand: `claude --resume ${sessionId}`,
      });
      setView({
        screen: 'terminal',
        terminalId: info.id,
        profileName: info.profileName || title,
        loadingMode: info.loadingMode,
        owner: 'web',
      });
    } catch (resumeError) {
      setError(resumeError instanceof Error ? resumeError.message : '恢复会话失败');
    } finally {
      setResuming(false);
    }
  }, [projectDir, title, sessionId, projects, setView]);

  const doExport = useCallback(async (format: 'markdown' | 'jsonl') => {
    setExporting(true);
    setError('');
    try {
      const content = await exportClaudeSessionContent(sessionId, format);
      const safe = title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || 'claude-session';
      const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${safe}.${format === 'markdown' ? 'md' : 'jsonl'}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : '导出失败');
    } finally {
      setExporting(false);
    }
  }, [sessionId, title]);

  const doDelete = useCallback(async () => {
    try {
      await api.deleteClaudeSession(sessionId);
      goBack();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : '删除失败');
      setConfirmDelete(false);
    }
  }, [sessionId]);

  const tokens = inputTokens + outputTokens;

  return (
    <div className="screen claude-replay-screen">
      <header className="topbar claude-replay-topbar">
        <button className="icon-button" onClick={goBack} title="返回" aria-label="返回历史列表">
          <ArrowLeft size={20} />
        </button>
        <div className="terminal-title">
          <span className="title">{title || '会话回放'}</span>
          <span className="claude-replay-sub">
            {projectDir && (
              <span className="claude-replay-dir" title={projectDir}>
                {projectForDirectory(projects, projectDir)?.name ?? projectDir}
              </span>
            )}
            {model && ` · ${model}`}
            {` · ${total || messages.length} 条消息`}
            {tokens > 0 && ` · ${tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : tokens} tok`}
          </span>
        </div>
        <button
          className="icon-button"
          onClick={() => setMenuOpen((v) => !v)}
          title="操作菜单"
          aria-label="操作菜单"
          aria-expanded={menuOpen}
        >
          <MoreHorizontal size={21} />
        </button>
        {menuOpen && (
          <>
            <div className="terminal-menu-mask" onClick={() => setMenuOpen(false)} />
            <div className="terminal-menu">
              <button
                className="terminal-menu-danger"
                onClick={() => {
                  setMenuOpen(false);
                  setConfirmDelete(true);
                }}
              >
                删除会话记录
              </button>
            </div>
          </>
        )}
      </header>

      <div className="claude-replay-body" ref={bodyRef} onScroll={(e: UIEvent<HTMLDivElement>) => loadIfNearBottom()}>
        {error && <div className="claude-replay-error">{error}</div>}
        {!error && !loading && messages.length === 0 && (
          <div className="claude-replay-empty">会话内容为空</div>
        )}
        {messages.map((message) => (
          <div
            key={message.seq}
            id={`claude-replay-msg-${message.seq}`}
            className={`claude-replay-msg role-${message.role}${focusSeq === message.seq ? ' focused' : ''}`}
          >
            <div className="claude-replay-msg-head">
              <span className="claude-replay-role">● {ROLE_LABEL[message.role] ?? message.role}</span>
              {formatTime(message.timestamp) && (
                <span className="claude-replay-time">{formatTime(message.timestamp)}</span>
              )}
              {message.toolName && <span className="claude-replay-toolname">{message.toolName}</span>}
            </div>
            {message.role === 'tool' ? (
              <details className="claude-replay-tool-result">
                <summary>工具结果{message.toolName ? ` · ${message.toolName}` : ''}</summary>
                <pre className="claude-replay-text">{message.text}</pre>
              </details>
            ) : (
              <>
                {message.text && (message.text.length > 1200 || message.text.split('\n').length > 18 ? (
                  <details className="claude-replay-long-text">
                    <summary>
                      {message.text.slice(0, 180).replace(/\s+/g, ' ')}…
                      <span>展开完整内容（{message.text.length} 字）</span>
                    </summary>
                    <div className="claude-replay-text">{message.text}</div>
                  </details>
                ) : (
                  <div className="claude-replay-text">{message.text}</div>
                ))}
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

      <footer className="claude-replay-actions">
        <button
          type="button"
          className="btn primary"
          disabled={!projectDir || resuming}
          title={projectDir ? '在项目目录中恢复此会话' : '该会话没有项目目录，无法恢复'}
          onClick={() => void resumeSession()}
        >
          {resuming ? '恢复中…' : '▶ 恢复此会话'}
        </button>
        <button type="button" className="btn" disabled={exporting} onClick={() => void doExport('markdown')}>
          ⤓ Markdown
        </button>
        <button type="button" className="btn" disabled={exporting} onClick={() => void doExport('jsonl')}>
          ⤓ JSONL
        </button>
      </footer>

      {confirmDelete && (
        <Dialog
          title="删除会话记录"
          onClose={() => setConfirmDelete(false)}
          footer={(
            <>
              <button className="btn" onClick={() => setConfirmDelete(false)}>取消</button>
              <button className="btn primary" onClick={() => void doDelete()}>删除</button>
            </>
          )}
        >
          <div className="web-dialog-desc">
            「{title}」的记录文件将移入回收目录（dataPath/Trash），索引同步清理。确定删除吗？
          </div>
        </Dialog>
      )}
    </div>
  );
}
