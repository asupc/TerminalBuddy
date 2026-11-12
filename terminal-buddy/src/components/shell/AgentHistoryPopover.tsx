import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { listen } from '@tauri-apps/api/event';
import { Play, RefreshCw, Star, X } from 'lucide-react';
import { AgentIcon } from '../agent-chat/AgentIcon';
import { ClaudeModelMenuSection } from '../shared/ClaudeModelMenuSection';
import { sessionHistory } from '../../services/sessionHistory';
import {
  aiSessionResumeHistory,
  type ClaudeHistoryScanResult,
  type ClaudeSessionItem,
} from '../../services/tauri';
import { useAppStore } from '../../stores/appStore';
import { getAppSettings } from '../../utils/settings';
import { openExistingAgentSession } from '../../utils/openAgentChat';
import { fitContextMenuToViewport } from '../../utils/contextMenu';
import { projectForDirectory } from '../../utils/projectPath';
import type { SessionHistoryProvider } from '../../types';
import './AgentHistoryPopover.css';

interface AgentHistoryPopoverProps {
  provider: SessionHistoryProvider;
  /** 只展示该目录（项目根或会话当前目录）下的历史会话。 */
  projectDir: string;
  /** 相对视口的定位：距左边缘、距底部（状态栏上沿之上）。 */
  anchor: { left: number; bottom: number };
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  /** 跳到完整会话历史面板（支持搜索、回放与批量操作）。 */
  onOpenFullHistory: () => void;
}

interface ContextMenuState {
  /** 右键点击位置：菜单高度测量后据此重新贴边，而不是预估高度。 */
  anchorX: number;
  anchorY: number;
  x: number;
  y: number;
  item: ClaudeSessionItem;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** 列表里的时间优先说「今天/昨天」，更久远的才显示日期。 */
function formatWhen(millis: number): string {
  if (!millis) return '';
  const date = new Date(millis);
  const now = new Date();
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (date.toDateString() === now.toDateString()) return `今天 ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `昨天 ${time}`;
  return `${date.getMonth() + 1}-${date.getDate()} ${time}`;
}

function formatTokens(input: number, output: number): string {
  const total = input + output;
  if (total <= 0) return '';
  return total >= 1000 ? `${Math.round(total / 1000)}k tok` : `${total} tok`;
}

/** 浮层每次打开都会挂载一次；短时间内重复扫描同一来源没有意义。 */
const rescanAt = new Map<string, number>();
const RESCAN_THROTTLE_MS = 30_000;

/**
 * 状态栏 Agent 历史浮层：只列当前 Agent 在当前项目下的历史会话。
 * 双击 / Enter / 播放按钮恢复会话；底部入口跳到完整历史面板做搜索、回放等重操作。
 */
export function AgentHistoryPopover({
  provider,
  projectDir,
  anchor,
  anchorRef,
  onClose,
  onOpenFullHistory,
}: AgentHistoryPopoverProps) {
  const history = useMemo(() => sessionHistory(provider), [provider]);
  const projects = useAppStore(s => s.projects);
  const claudeSessionIds = useAppStore(s => s.claudeSessionIds);
  const agentSessionBindings = useAppStore(s => s.agentSessionBindings);
  const refreshClaudeLaunchTargets = useAppStore(s => s.refreshClaudeLaunchTargets);
  const refreshCodexLaunchTargets = useAppStore(s => s.refreshCodexLaunchTargets);
  const showToast = useAppStore(s => s.showToast);

  const [items, setItems] = useState<ClaudeSessionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const requestRef = useRef(0);

  const projectName = projectForDirectory(projects, projectDir)?.name ?? projectDir;

  const load = useCallback(async (options: { rescan?: boolean; silent?: boolean } = {}) => {
    const request = ++requestRef.current;
    if (!options.silent) setLoading(true);
    if (options.rescan) setRefreshing(true);
    setError(null);
    try {
      if (options.rescan) await history.rescan().catch(() => {});
      const next = await history.list(false, projectDir);
      if (request === requestRef.current) setItems(next);
    } catch (loadError) {
      if (request === requestRef.current) setError(String(loadError));
    } finally {
      if (request === requestRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [history, projectDir]);

  // 先展示索引里的已有列表，再在后台补扫一次并刷新，避免打开浮层就卡在扫描上。
  useEffect(() => {
    let cancelled = false;
    void load();
    const scanKey = `${provider}\u0000${projectDir}`;
    if (Date.now() - (rescanAt.get(scanKey) ?? 0) >= RESCAN_THROTTLE_MS) {
      rescanAt.set(scanKey, Date.now());
      history.rescan()
        .then(() => { if (!cancelled) void load({ silent: true }); })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
      requestRef.current += 1;
    };
  }, [history, load, provider, projectDir]);

  // 后台分批补齐索引时跟着刷新列表。
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void listen<ClaudeHistoryScanResult>(history.indexedEvent, () => {
      if (!cancelled) void load({ silent: true });
    }).then(fn => {
      if (cancelled) fn();
      else unlisten = fn;
    }).catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [history, load]);

  // 点外部 / Esc / 窗口尺寸变化时关闭；点击入口按钮本身交给外层做开合切换。
  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (popoverRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      // 右键菜单及其子菜单通过 portal 挂在 body 下，不算「外部点击」。
      if (menuRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest('.claude-model-submenu')) return;
      onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // 右键菜单打开时先收菜单，再按一次才关浮层。
      if (menuRef.current) {
        setContextMenu(null);
        return;
      }
      onClose();
    };
    const handleResize = () => onClose();
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', handleResize);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', handleResize);
    };
  }, [anchorRef, onClose]);

  // 点击菜单/子菜单以外的位置收起右键菜单。
  useEffect(() => {
    if (!contextMenu) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest('.claude-model-submenu')) return;
      setContextMenu(null);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [contextMenu]);

  // 右键菜单里的「指定模型恢复」需要供应商/模型目录：打开菜单时刷新一次。
  useEffect(() => {
    if (!contextMenu) return;
    void (provider === 'claude' ? refreshClaudeLaunchTargets() : refreshCodexLaunchTargets());
  }, [contextMenu, provider, refreshClaudeLaunchTargets, refreshCodexLaunchTargets]);

  // 首帧按鼠标位置渲染，量出真实尺寸后再贴边修正（模型数量决定菜单高度，不能预估）。
  // 供应商目录异步到达会让菜单变高，用 ResizeObserver 再校正一次。
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu || !contextMenu) return;
    const reposition = () => {
      const { width, height } = menu.getBoundingClientRect();
      const pos = fitContextMenuToViewport(contextMenu.anchorX, contextMenu.anchorY, width, height);
      setContextMenu(current => {
        if (!current) return current;
        if (Math.abs(pos.x - current.x) <= 0.5 && Math.abs(pos.y - current.y) <= 0.5) return current;
        return { ...current, x: pos.x, y: pos.y };
      });
    };
    reposition();
    const observer = new ResizeObserver(reposition);
    observer.observe(menu);
    return () => observer.disconnect();
  }, [contextMenu]);

  const liveSessionIds = useMemo(() => {
    const set = new Set<string>();
    if (provider === 'claude') {
      for (const id of Object.values(claudeSessionIds)) set.add(id);
    }
    for (const binding of Object.values(agentSessionBindings)) {
      if (binding.provider === provider) set.add(binding.sessionId);
    }
    return set;
  }, [provider, claudeSessionIds, agentSessionBindings]);

  const visibleItems = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return items;
    return items.filter(item => (item.customTitle || item.title).toLowerCase().includes(keyword));
  }, [items, query]);

  const resumeItem = useCallback(async (item: ClaudeSessionItem) => {
    const title = item.customTitle || item.title;
    try {
      // 原生会话形态下优先续接 CLI 线程；会话已在终端里时仍走终端恢复路径（聚焦原终端）。
      if (!liveSessionIds.has(item.sessionId) && getAppSettings().nativeChatSessions) {
        const session = await aiSessionResumeHistory(provider, item.sessionId, null, null);
        openExistingAgentSession(session);
      } else {
        await history.resume({ sessionId: item.sessionId, title, projectDir: item.projectDir });
      }
      onClose();
    } catch (resumeError) {
      showToast(`恢复会话失败: ${String(resumeError)}`, 'error');
    }
  }, [history, liveSessionIds, onClose, provider, showToast]);

  /**
   * 指定供应商/模型恢复：原生会话把型号直接交给续接接口；
   * 终端路径沿用历史面板的 independent 参数，按所选模型重新起 CLI。
   */
  const resumeWithModel = useCallback(async (
    item: ClaudeSessionItem,
    vendorRef: { providerId: string; modelId: string },
  ) => {
    const title = item.customTitle || item.title;
    try {
      if (!liveSessionIds.has(item.sessionId) && getAppSettings().nativeChatSessions) {
        const session = await aiSessionResumeHistory(
          provider, item.sessionId, vendorRef.providerId, vendorRef.modelId,
        );
        openExistingAgentSession(session);
      } else {
        await history.resume(
          { sessionId: item.sessionId, title, projectDir: item.projectDir },
          undefined,
          vendorRef,
        );
      }
      onClose();
    } catch (resumeError) {
      showToast(`恢复会话失败: ${String(resumeError)}`, 'error');
    }
  }, [history, liveSessionIds, onClose, provider, showToast]);

  // 上下键在行之间移动焦点，Enter 由行自身处理。
  const handleListKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const rows = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>('[data-agent-history-row]') ?? [],
    );
    if (rows.length === 0) return;
    event.preventDefault();
    const index = rows.indexOf(document.activeElement as HTMLElement);
    const nextIndex = event.key === 'ArrowDown'
      ? Math.min(rows.length - 1, index + 1)
      : Math.max(0, index <= 0 ? 0 : index - 1);
    rows[nextIndex]?.focus();
  }, []);

  const agentLabel = provider === 'codex' ? 'Codex' : 'Claude Code';
  // 索引刷新后列表对象会被替换：右键操作始终取最新条目，避免用旧数据恢复。
  const contextMenuItem = contextMenu
    ? items.find(item => item.sessionId === contextMenu.item.sessionId) ?? contextMenu.item
    : null;

  return (
    <div
      ref={popoverRef}
      className="agent-history-popover"
      style={{ left: anchor.left, bottom: anchor.bottom }}
      role="dialog"
      aria-label={`${agentLabel} 会话历史`}
    >
      <div className="agent-history-header">
        <AgentIcon provider={provider} className={`agent-history-agent-logo provider-${provider}`} />
        <span className="agent-history-title">{agentLabel} 历史</span>
        <span className="agent-history-project" title={projectDir}>{projectName}</span>
        <button
          type="button"
          className={`agent-history-icon-btn${refreshing ? ' spinning' : ''}`}
          title="重新扫描并刷新"
          aria-label="重新扫描并刷新"
          onClick={() => void load({ rescan: true })}
          disabled={refreshing}
        >
          <RefreshCw aria-hidden="true" />
        </button>
        <button
          type="button"
          className="agent-history-icon-btn"
          title="关闭"
          aria-label="关闭 Agent 历史"
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </button>
      </div>

      <input
        className="agent-history-search"
        placeholder="搜索会话…"
        value={query}
        onChange={event => setQuery(event.target.value)}
        onKeyDown={event => { if (event.key === 'Escape') onClose(); }}
      />

      <div
        ref={listRef}
        className="agent-history-list"
        role="listbox"
        aria-label={`${agentLabel} 历史会话列表`}
        onKeyDown={handleListKeyDown}
      >
        {loading && items.length === 0 && (
          <div className="agent-history-empty">正在加载历史会话…</div>
        )}
        {!loading && error && (
          <div className="agent-history-empty error">
            加载失败：{error}
            <button type="button" onClick={() => void load({ rescan: true })}>重试</button>
          </div>
        )}
        {!loading && !error && visibleItems.length === 0 && (
          <div className="agent-history-empty">
            {query.trim() ? '没有匹配的会话' : `当前项目还没有 ${agentLabel} 历史会话`}
          </div>
        )}
        {visibleItems.map(item => {
          const title = item.customTitle || item.title;
          const tokens = formatTokens(item.inputTokens, item.outputTokens);
          return (
            <div
              key={item.sessionId}
              className={`agent-history-item${selectedId === item.sessionId ? ' selected' : ''}`}
              role="option"
              aria-selected={selectedId === item.sessionId}
              tabIndex={0}
              data-agent-history-row
              title="双击恢复会话 · 右键选择供应商/模型 · Enter 恢复"
              onClick={() => setSelectedId(item.sessionId)}
              onDoubleClick={() => void resumeItem(item)}
              onContextMenu={event => {
                event.preventDefault();
                event.stopPropagation();
                setSelectedId(item.sessionId);
                setContextMenu({
                  anchorX: event.clientX,
                  anchorY: event.clientY,
                  x: event.clientX,
                  y: event.clientY,
                  item,
                });
              }}
              onKeyDown={event => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                void resumeItem(item);
              }}
            >
              <div className="agent-history-item-title">
                {item.starred && <Star className="agent-history-star" aria-label="已收藏" />}
                <span className="agent-history-item-name">{title}</span>
                {liveSessionIds.has(item.sessionId) && (
                  <span className="agent-history-live">进行中</span>
                )}
                <button
                  type="button"
                  className="agent-history-play"
                  title="恢复会话"
                  aria-label={`恢复会话 ${title}`}
                  onClick={event => {
                    event.stopPropagation();
                    void resumeItem(item);
                  }}
                >
                  <Play aria-hidden="true" />
                </button>
              </div>
              <div className="agent-history-item-meta">
                {formatWhen(item.updatedAt)}
                {item.messageCount > 0 && ` · ${item.messageCount} 条`}
                {tokens && ` · ${tokens}`}
              </div>
            </div>
          );
        })}
      </div>

      <div className="agent-history-footer">
        <span>{visibleItems.length} 条 · 双击恢复 · 右键选模型</span>
        <button type="button" className="agent-history-full-btn" onClick={onOpenFullHistory}>
          打开完整历史 →
        </button>
      </div>

      {contextMenu && contextMenuItem && createPortal(
        <div
          ref={menuRef}
          className="agent-history-context"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={event => event.stopPropagation()}
          onContextMenu={event => event.preventDefault()}
        >
          <div
            className="agent-history-context-item"
            onClick={() => {
              setContextMenu(null);
              void resumeItem(contextMenuItem);
            }}
          >
            <span className="agent-history-context-icon">
              <Play size={14} strokeWidth={1.6} />
            </span>
            <span className="agent-history-context-label">恢复会话</span>
            <span className="agent-history-context-hint">默认</span>
          </div>
          <ClaudeModelMenuSection
            source={provider}
            itemClassName="agent-history-context-item"
            separatorClassName="agent-history-context-sep"
            submenuClassName="agent-history-model-submenu"
            title="指定模型恢复"
            onPickModel={(providerId, modelId) => {
              const item = contextMenuItem;
              setContextMenu(null);
              void resumeWithModel(item, { providerId, modelId });
            }}
            onGotoProviders={() => {
              setContextMenu(null);
              onClose();
              useAppStore.getState().setProviderSettingsTab(provider);
              useAppStore.getState().openSettingsDialog('llm-providers');
            }}
          />
        </div>,
        document.body,
      )}
    </div>
  );
}
