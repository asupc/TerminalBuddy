import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type TouchEvent,
} from 'react';
import { api, exportClaudeSessionContent } from '../api';
import { Dialog } from '../components/Dialog';
import { useStore } from '../store';
import type { ClaudeSearchHit, ClaudeSessionItem, Project } from '../types';

/** 与 PC 端 utils/projectPath.ts 同规则：路径归一后做「相等或子目录」匹配，最长项目优先 */
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

function formatTokens(input: number, output: number): string {
  const total = input + output;
  if (total <= 0) return '';
  return total >= 1000 ? `${Math.round(total / 1000)}k tok` : `${total} tok`;
}

/** 会话文件名（导出下载用）：过滤 Windows 非法字符 */
function downloadName(title: string, ext: string): string {
  const safe = title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || 'claude-session';
  return `${safe}.${ext}`;
}

function downloadText(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

interface SessionMenuState {
  x: number;
  y: number;
  sessionId: string;
}

/**
 * Claude Code 会话历史（Web 版）：项目分组列表 + 全文检索 + 右键/长按管理 + 恢复会话。
 * 与 PC 端 HistoryPanel 功能对齐；交互沿用 web 端既有模式（右键/长按菜单、Dialog 确认）。
 */
export default function ClaudeHistory() {
  const projects = useStore((state) => state.projects);
  const setView = useStore((state) => state.setView);

  const [items, setItems] = useState<ClaudeSessionItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  /** 全文检索模式：显示命中片段，点击锚定进入回放 */
  const [fulltext, setFulltext] = useState(false);
  const [hits, setHits] = useState<ClaudeSearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const [menu, setMenu] = useState<SessionMenuState | null>(null);
  const [renaming, setRenaming] = useState<{ sessionId: string; value: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ single?: ClaudeSessionItem; batch?: string[] } | null>(null);
  const [resuming, setResuming] = useState<string | null>(null);
  // 多选批量操作（与 PC 端 v1.7.0 批量删除对齐）
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  const longPressTimer = useRef<number | null>(null);
  const longPressFired = useRef(false);

  const toggleSelected = useCallback((sessionId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  }, []);

  const exitSelectMode = useCallback(() => {
    setSelectMode(false);
    setSelected(new Set());
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setItems(await api.getClaudeHistory(includeArchived));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '加载会话历史失败');
    } finally {
      setLoading(false);
    }
  }, [includeArchived]);

  useEffect(() => {
    void load();
  }, [load]);

  // 打开面板时增量索引一次（与 PC 端一致），完成后刷新列表；
  // 后台补齐的部分暂无推送，下次刷新自然可见
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    api.rescanClaudeHistory()
      .then(() => loadRef.current())
      .catch(() => { /* 索引失败不阻塞浏览旧索引 */ });
  }, []);

  const menuSession = menu ? items.find((s) => s.sessionId === menu.sessionId) : null;

  const openReplay = useCallback(
    (sessionId: string, title: string, focusSeq?: number) => {
      setView({ screen: 'claudeReplay', sessionId, title, focusSeq });
    },
    [setView],
  );

  /** 恢复会话：在会话原目录起 PowerShell 并执行 claude --resume（依赖空白终端启动链路） */
  const resumeSession = useCallback(
    async (session: ClaudeSessionItem) => {
      if (!session.projectDir) {
        setError('该会话没有项目目录，无法恢复');
        return;
      }
      setResuming(session.sessionId);
      setError('');
      try {
        const info = await api.createTerminal('', {
          displayName: session.title,
          startupPath: session.projectDir,
          startupGroup: projectForDirectory(projects, session.projectDir)?.name,
          startupCommand: `claude --resume ${session.sessionId}`,
        });
        setView({
          screen: 'terminal',
          terminalId: info.id,
          profileName: info.profileName || session.title,
          loadingMode: info.loadingMode,
          owner: 'web',
        });
      } catch (resumeError) {
        setError(resumeError instanceof Error ? resumeError.message : '恢复会话失败');
      } finally {
        setResuming(null);
      }
    },
    [projects, setView],
  );

  const patchLocal = useCallback((sessionId: string, patch: Partial<ClaudeSessionItem>) => {
    setItems((prev) => prev.map((s) => (s.sessionId === sessionId ? { ...s, ...patch } : s)));
  }, []);

  const toggleFlag = useCallback(
    async (session: ClaudeSessionItem, flag: 'starred' | 'archived') => {
      const next = !session[flag];
      try {
        await api.setClaudeSessionFlags(session.sessionId, { [flag]: next });
        patchLocal(session.sessionId, { [flag]: next });
      } catch (flagError) {
        setError(flagError instanceof Error ? flagError.message : '更新状态失败');
      }
    },
    [patchLocal],
  );

  const submitRename = useCallback(async () => {
    if (!renaming) return;
    const title = renaming.value.trim();
    if (!title) return;
    try {
      await api.renameClaudeSession(renaming.sessionId, title);
      patchLocal(renaming.sessionId, { title, customTitle: title });
      setRenaming(null);
    } catch (renameError) {
      setError(renameError instanceof Error ? renameError.message : '重命名失败');
    }
  }, [renaming, patchLocal]);

  const doDelete = useCallback(async () => {
    if (!confirmDelete) return;
    try {
      if (confirmDelete.single) {
        await api.deleteClaudeSession(confirmDelete.single.sessionId);
      } else if (confirmDelete.batch) {
        await api.deleteClaudeSessions(confirmDelete.batch);
      }
      setConfirmDelete(null);
      if (confirmDelete.batch) exitSelectMode();
      await load();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : '删除失败');
      setConfirmDelete(null);
    }
  }, [confirmDelete, load, exitSelectMode]);

  const doExport = useCallback(async (session: ClaudeSessionItem, format: 'markdown' | 'jsonl') => {
    setError('');
    try {
      const content = await exportClaudeSessionContent(session.sessionId, format);
      downloadText(downloadName(session.title, format === 'markdown' ? 'md' : 'jsonl'), content);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : '导出失败');
    }
  }, []);

  const runFulltextSearch = useCallback(async () => {
    const q = query.trim();
    if (!q) {
      setHits(null);
      return;
    }
    setSearching(true);
    setError('');
    try {
      setHits(await api.searchClaudeHistory(q));
    } catch (searchError) {
      setError(searchError instanceof Error ? searchError.message : '全文检索失败');
    } finally {
      setSearching(false);
    }
  }, [query]);

  // 标题子串过滤（非全文模式）
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || fulltext) return items;
    return items.filter((s) => s.title.toLowerCase().includes(q));
  }, [items, query, fulltext]);

  const groups = useMemo(() => {
    const grouped = new Map<string, { key: string; label: string; items: ClaudeSessionItem[] }>();
    for (const item of filtered) {
      const project = projectForDirectory(projects, item.projectDir);
      const key = project ? `project:${normalizeProjectPath(project.path)}` : item.projectDir || '（未知目录）';
      const label = project ? project.name : item.projectDir || '（未知目录）';
      const entry = grouped.get(key);
      if (entry) entry.items.push(item);
      else grouped.set(key, { key, label, items: [item] });
    }
    return Array.from(grouped.values()).sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'));
  }, [filtered, projects]);

  const toggleGroup = useCallback((key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // ===== 右键 / 长按菜单 =====
  const clearLongPress = () => {
    if (longPressTimer.current !== null) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  const showMenu = useCallback((sessionId: string, x: number, y: number) => {
    const clampedX = Math.min(x, window.innerWidth - 220);
    const clampedY = Math.min(y, window.innerHeight - 300);
    setMenu({ sessionId, x: Math.max(8, clampedX), y: Math.max(8, clampedY) });
  }, []);

  const handleContextMenu = (e: MouseEvent, session: ClaudeSessionItem) => {
    e.preventDefault();
    showMenu(session.sessionId, e.clientX, e.clientY);
  };

  const handleTouchStart = (e: TouchEvent, session: ClaudeSessionItem) => {
    longPressFired.current = false;
    const touch = e.touches[0];
    clearLongPress();
    longPressTimer.current = window.setTimeout(() => {
      longPressFired.current = true;
      showMenu(session.sessionId, touch.clientX, touch.clientY);
    }, 500);
  };

  // 点击外部 / 滚动关闭菜单
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    document.addEventListener('mousedown', close);
    document.addEventListener('touchstart', close, { passive: true });
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('touchstart', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [menu]);

  return (
    <div className="claude-history">
      <div className="claude-history-toolbar">
        <input
          className="claude-history-search"
          type="search"
          value={query}
          placeholder={fulltext ? '全文检索会话内容…' : '按标题过滤…'}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && fulltext) void runFulltextSearch();
          }}
          aria-label="搜索会话"
        />
        <button
          type="button"
          className={`btn small${fulltext ? ' primary' : ''}`}
          onClick={() => {
            setFulltext((v) => !v);
            setHits(null);
          }}
        >
          全文
        </button>
        <button
          type="button"
          className={`btn small${includeArchived ? ' primary' : ''}`}
          onClick={() => setIncludeArchived((v) => !v)}
        >
          含归档
        </button>
        {!fulltext && (
          <button
            type="button"
            className={`btn small${selectMode ? ' primary' : ''}`}
            onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
          >
            {selectMode ? '退出多选' : '多选'}
          </button>
        )}
        <button type="button" className="btn small" onClick={() => void load()} disabled={loading}>
          {loading ? '刷新中…' : '刷新'}
        </button>
      </div>

      {error && <div className="nav-error" role="alert">{error}</div>}

      {fulltext ? (
        <div className="claude-history-hits">
          {searching && <div className="claude-history-empty">检索中…</div>}
          {!searching && hits === null && (
            <div className="claude-history-empty">输入关键词后回车，跨全部会话检索内容</div>
          )}
          {!searching && hits?.length === 0 && <div className="claude-history-empty">没有命中会话</div>}
          {hits?.map((hit) => (
            <button
              type="button"
              key={`${hit.sessionId}-${hit.seq}`}
              className="claude-history-hit"
              onClick={() => openReplay(hit.sessionId, hit.title, hit.seq)}
            >
              <span className="claude-history-hit-title">{hit.title}</span>
              <span className="claude-history-snippet">{hit.snippet}</span>
              <span className="claude-history-hit-meta">
                {projectForDirectory(projects, hit.projectDir)?.name ?? hit.projectDir}
                {hit.timestamp ? ` · ${formatTime(hit.timestamp)}` : ''}
              </span>
            </button>
          ))}
        </div>
      ) : items.length === 0 && !loading ? (
        <div className="claude-history-empty">
          {includeArchived ? '暂无会话记录' : '暂无会话记录（归档会话可点「含归档」查看）'}
        </div>
      ) : (
        <div className="session-tree" aria-label="Claude 会话历史">
          {groups.map((group) => {
            const isCollapsed = collapsedGroups.has(group.key);
            return (
              <div className="tree-node" key={group.key}>
                <div
                  className="tree-item"
                  style={{ paddingLeft: 8 }}
                  role="button"
                  tabIndex={0}
                  aria-expanded={!isCollapsed}
                  onClick={() => toggleGroup(group.key)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      toggleGroup(group.key);
                    }
                  }}
                >
                  <button
                    type="button"
                    className={`tree-arrow${isCollapsed ? '' : ' expanded'}`}
                    aria-label={isCollapsed ? '展开分组' : '折叠分组'}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleGroup(group.key);
                    }}
                    tabIndex={-1}
                  >
                    ▶
                  </button>
                  <span className="tree-name">{group.label}</span>
                  <span className="tree-item-end">
                    <span className="tree-item-count">{group.items.length}</span>
                  </span>
                </div>
                {!isCollapsed && (
                  <div className="tree-children">
                    {group.items.map((session) => (
                      <div
                        key={session.sessionId}
                        className="tree-item claude-history-item"
                        style={{ paddingLeft: 20 }}
                        role="button"
                        tabIndex={0}
                        onClick={() => {
                          if (longPressFired.current) {
                            longPressFired.current = false;
                            return;
                          }
                          if (selectMode) toggleSelected(session.sessionId);
                          else openReplay(session.sessionId, session.title);
                        }}
                        onContextMenu={(e) => {
                          if (selectMode) return;
                          handleContextMenu(e, session);
                        }}
                        onTouchStart={(e) => {
                          if (selectMode) return;
                          handleTouchStart(e, session);
                        }}
                        onTouchEnd={clearLongPress}
                        onTouchMove={clearLongPress}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            if (selectMode) toggleSelected(session.sessionId);
                            else openReplay(session.sessionId, session.title);
                          }
                        }}
                        aria-selected={selectMode ? selected.has(session.sessionId) : undefined}
                      >
                        {selectMode && (
                          <span
                            className={`claude-history-check${selected.has(session.sessionId) ? ' checked' : ''}`}
                            aria-hidden="true"
                          >
                            {selected.has(session.sessionId) ? '✓' : ''}
                          </span>
                        )}
                        <span className="tree-arrow-placeholder" aria-hidden="true" />
                        {session.starred && <span className="claude-history-badge starred">★</span>}
                        {session.archived && <span className="claude-history-badge archived">归档</span>}
                        <span className="tree-name">{session.title}</span>
                        <span className="tree-item-end">
                          {resuming === session.sessionId ? (
                            <span className="tree-item-count">恢复中…</span>
                          ) : (
                            <span className="claude-history-meta">
                              {formatTime(session.updatedAt)}
                              {session.messageCount > 0 && ` · ${session.messageCount}条`}
                              {formatTokens(session.inputTokens, session.outputTokens) &&
                                ` · ${formatTokens(session.inputTokens, session.outputTokens)}`}
                            </span>
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {selectMode && (
        <div className="claude-history-batch-bar">
          <span>已选 {selected.size} 个</span>
          <button
            type="button"
            className="btn small"
            onClick={() => setSelected(new Set(filtered.map((s) => s.sessionId)))}
          >
            全选
          </button>
          <button
            type="button"
            className="btn small"
            disabled={selected.size === 0}
            onClick={() => setConfirmDelete({ batch: [...selected] })}
          >
            批量删除
          </button>
        </div>
      )}

      {menu && menuSession && (
        <div
          className="profile-context-menu"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="context-menu-item"
            onClick={() => {
              void resumeSession(menuSession);
              setMenu(null);
            }}
          >
            恢复此会话
          </button>
          <button
            type="button"
            className="context-menu-item"
            onClick={() => {
              setRenaming({ sessionId: menuSession.sessionId, value: menuSession.title });
              setMenu(null);
            }}
          >
            重命名
          </button>
          <button
            type="button"
            className="context-menu-item"
            onClick={() => {
              void toggleFlag(menuSession, 'starred');
              setMenu(null);
            }}
          >
            {menuSession.starred ? '取消收藏' : '收藏'}
          </button>
          <button
            type="button"
            className="context-menu-item"
            onClick={() => {
              void toggleFlag(menuSession, 'archived');
              setMenu(null);
            }}
          >
            {menuSession.archived ? '取消归档' : '归档'}
          </button>
          <div className="context-menu-separator" />
          <button
            type="button"
            className="context-menu-item"
            onClick={() => {
              void doExport(menuSession, 'markdown');
              setMenu(null);
            }}
          >
            导出 Markdown
          </button>
          <button
            type="button"
            className="context-menu-item"
            onClick={() => {
              void doExport(menuSession, 'jsonl');
              setMenu(null);
            }}
          >
            导出 JSONL
          </button>
          <div className="context-menu-separator" />
          <button
            type="button"
            className="context-menu-item danger"
            onClick={() => {
              setConfirmDelete({ single: menuSession });
              setMenu(null);
            }}
          >
            删除
          </button>
        </div>
      )}

      {renaming && (
        <Dialog
          title="重命名会话"
          onClose={() => setRenaming(null)}
          footer={(
            <>
              <button className="btn" onClick={() => setRenaming(null)}>取消</button>
              <button className="btn primary" onClick={() => void submitRename()}>保存</button>
            </>
          )}
        >
          <input
            className="claude-history-rename-input"
            type="text"
            value={renaming.value}
            autoFocus
            onChange={(e) => setRenaming({ ...renaming, value: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submitRename();
            }}
            aria-label="会话标题"
          />
        </Dialog>
      )}

      {confirmDelete && (
        <Dialog
          title="删除会话记录"
          onClose={() => setConfirmDelete(null)}
          footer={(
            <>
              <button className="btn" onClick={() => setConfirmDelete(null)}>取消</button>
              <button className="btn primary" onClick={() => void doDelete()}>删除</button>
            </>
          )}
        >
          <div className="web-dialog-desc">
            {confirmDelete.single
              ? `「${confirmDelete.single.title}」的记录文件将移入回收目录（dataPath/Trash），索引同步清理。确定删除吗？`
              : `将删除选中的 ${confirmDelete.batch?.length ?? 0} 个会话记录（文件移入回收目录）。确定删除吗？`}
          </div>
        </Dialog>
      )}
    </div>
  );
}
