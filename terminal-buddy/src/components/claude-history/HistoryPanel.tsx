import { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listen } from './../../services/remoteWorkspace/events';
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  Eye,
  Folder,
  FolderOpen,
  Pencil,
  Play,
  Star,
  StarOff,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  openInExplorer,
  getBackendAppSettings,
  saveConfigNavWidth,
  saveFileNavWidth,
  aiSessionResumeHistory,
  type ClaudeHistoryScanResult,
  type ClaudeSessionItem,
  type ClaudeSearchHit,
} from '../../services/tauri';
import { useAppStore } from '../../stores/appStore';
import { normalizeProjectPath, projectForDirectory } from '../../utils/projectPath';
import { useActiveTabProjectDirectory } from '../../hooks/useActiveTabProjectDirectory';
import { useResizablePanel } from '../../hooks/useResizablePanel';
import { notifyTerminalPanelResize } from '../../utils/terminalResizeEvent';
import { fitContextMenuToViewport } from '../../utils/contextMenu';
import { supportsSystemExplorerOpen } from '../../services/platform';
import { ConfirmDialog } from '../shared/Dialog';
import { ClaudeModelMenuSection } from '../shared/ClaudeModelMenuSection';
import { ClaudeExportDialog } from './ClaudeExportDialog';
import { type ClaudeVendorRef } from './resumeClaudeSession';
import type { Project, SessionHistoryProvider } from '../../types';
import { AGENT_HISTORY_AUTO_ARCHIVED_EVENT, sessionHistory } from '../../services/sessionHistory';
import { getAgentCliEnvironment } from '../../services/agentCli';
import { resumedCodexSessionId } from '../../utils/codexLaunch';
import { openExistingAgentSession } from '../../utils/openAgentChat';
import { getAppSettings } from '../../utils/settings';
import './HistoryPanel.css';

interface ContextMenuState {
  x: number;
  y: number;
  item: ClaudeSessionItem;
}

interface HistoryPanelProps {
  isSidebarMode?: boolean;
  /** 面板当前可见且在最前：不可见时不响应 F1 / Del 快捷键。 */
  isActive?: boolean;
}

function formatTime(millis: number | null): string {
  if (!millis) return '';
  return new Date(millis).toLocaleString('zh-CN', { hour12: false });
}

/** 会话所属分组（目录）的键；无目录时归到「未知目录」组。 */
function groupKeyOf(item: ClaudeSessionItem, projects: Project[]): string {
  const project = projectForDirectory(projects, item.projectDir);
  return project ? `project:${normalizeProjectPath(project.path)}` : item.projectDir || '（未知目录）';
}

/**
 * 分组展开态。集合的语义随过滤状态翻转：限定到单个项目时默认全展开、集合记「手动收起」
 * （否则只能看到一行目录名）；全目录视图默认全收起、集合记「手动展开」。
 */
function isGroupExpanded(toggled: Set<string>, dir: string, scoped: boolean): boolean {
  return scoped ? !toggled.has(dir) : toggled.has(dir);
}

function setGroupExpanded(
  toggled: Set<string>,
  dir: string,
  scoped: boolean,
  expanded: boolean,
): Set<string> {
  if (isGroupExpanded(toggled, dir, scoped) === expanded) return toggled;
  const next = new Set(toggled);
  if (next.has(dir)) next.delete(dir);
  else next.add(dir);
  return next;
}

function formatTokens(input: number, output: number): string {
  const total = input + output;
  if (total <= 0) return '';
  return total >= 1000 ? `${Math.round(total / 1000)}k tok` : `${total} tok`;
}

interface MenuItemProps {
  icon: LucideIcon;
  label: string;
  hint?: string;
  danger?: boolean;
  onClick: () => void;
}

const MenuItem: FC<MenuItemProps> = ({ icon: Icon, label, hint, danger, onClick }) => (
  <div
    className={`claude-hist-context-item${danger ? ' danger' : ''}`}
    onClick={onClick}
  >
    <span className="claude-hist-context-icon"><Icon size={14} strokeWidth={1.6} /></span>
    <span className="claude-hist-context-label">{label}</span>
    {hint && <span className="claude-hist-context-hint">{hint}</span>}
  </div>
);

/** Claude Code / Codex 会话面板：列表、检索、回放与恢复共用同一套交互。 */
export const HistoryPanel: FC<HistoryPanelProps> = props => {
  const requestedProvider = useAppStore(s => s.historyPanelProvider);
  const focusToken = useAppStore(s => s.historyPanelFocusToken);
  const [provider, setProvider] = useState<SessionHistoryProvider>(requestedProvider ?? 'claude');
  // 状态栏 Agent 历史入口等外部请求：切到指定来源；未指定时保持用户手动选择。
  useEffect(() => {
    if (requestedProvider) setProvider(requestedProvider);
  }, [requestedProvider, focusToken]);
  const [codexAvailable, setCodexAvailable] = useState(false);
  // 环境探测完成前不要因为 providers 暂时只有 Claude 就把外部请求切回的 Codex 打回去。
  const [environmentChecked, setEnvironmentChecked] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const apply = (environment: { codex?: { status: string } }) => {
      if (cancelled) return;
      setCodexAvailable(
        environment.codex?.status === 'installed'
        || environment.codex?.status === 'updating'
        || environment.codex?.status === 'installing',
      );
      setEnvironmentChecked(true);
    };
    void getAgentCliEnvironment().then(apply).catch(() => {
      if (!cancelled) setEnvironmentChecked(true);
    });
    const onChange = (event: Event) => {
      const detail = (event as CustomEvent<{ codex?: { status: string } }>).detail;
      if (detail) apply(detail);
    };
    window.addEventListener('agent-cli-status-changed', onChange);
    return () => {
      cancelled = true;
      window.removeEventListener('agent-cli-status-changed', onChange);
    };
  }, []);
  const providers = useMemo<SessionHistoryProvider[]>(() => [
    'claude',
    ...(codexAvailable ? ['codex' as const] : []),
  ], [codexAvailable]);
  useEffect(() => {
    if (environmentChecked && !providers.includes(provider)) setProvider('claude');
  }, [providers, provider, environmentChecked]);
  return (
    <HistoryPanelContent
      key={provider}
      {...props}
      provider={provider}
      providers={providers}
      onProviderChange={setProvider}
      focusToken={focusToken}
    />
  );
};

const HistoryPanelContent: FC<HistoryPanelProps & {
  provider: SessionHistoryProvider;
  providers: SessionHistoryProvider[];
  onProviderChange: (provider: SessionHistoryProvider) => void;
  focusToken: number;
}> = ({ isSidebarMode = false, isActive = true, provider, providers, onProviderChange, focusToken }) => {
  const history = sessionHistory(provider);
  const showToast = useAppStore(s => s.showToast);
  const openSettingsDialog = useAppStore(s => s.openSettingsDialog);
  const refreshClaudeLaunchTargets = useAppStore(s => s.refreshClaudeLaunchTargets);
  const refreshCodexLaunchTargets = useAppStore(s => s.refreshCodexLaunchTargets);
  const sessions = useAppStore(s => s.sessions);
  const claudeSessionIds = useAppStore(s => s.claudeSessionIds);
  const openClaudeReplayTab = useAppStore(s => s.openClaudeReplayTab);
  const projects = useAppStore(s => s.projects);
  // 默认风格下由标题栏的显示/隐藏按钮控制（侧栏风格下由面板互斥控制，不看它）
  const historyPanelVisible = useAppStore(s => s.historyPanelVisible);
  const scopeDir = useActiveTabProjectDirectory();
  const activeSessionId = useAppStore(s => s.activeSessionId);
  const activeSpecialTab = useAppStore(s => s.activeSpecialTab);
  const claudeReplayTab = useAppStore(s => s.claudeReplayTab);
  // 过滤条件可被手动 ×掉看全部目录
  const [scopeDismissed, setScopeDismissed] = useState(false);
  const activeScope = scopeDismissed ? undefined : scopeDir;

  const [items, setItems] = useState<ClaudeSessionItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [query, setQuery] = useState('');
  const [fulltextHits, setFulltextHits] = useState<ClaudeSearchHit[] | null>(null);
  const [fulltextQuery, setFulltextQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const selectionAnchor = useRef<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [exportTarget, setExportTarget] = useState<ClaudeSessionItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ClaudeSessionItem[]>([]);
  // 分组手动翻转过的目录（默认态随过滤状态翻转，见 isGroupExpanded）
  const [toggledDirs, setToggledDirs] = useState<Set<string>>(() => new Set());
  const menuRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // 指针最后一次按下是否落在本面板内：快捷键只认这个，不认面板是否可见
  const pointerInPanelRef = useRef(false);
  const initialLoadRef = useRef(false);
  const scanPromiseRef = useRef<Promise<ClaudeHistoryScanResult> | null>(null);
  const loadRequestRef = useRef(0);
  const searchRequestRef = useRef(0);

  useEffect(() => {
    setScopeDismissed(false);
  }, [activeSessionId, activeSpecialTab, claudeReplayTab?.sessionId, claudeReplayTab?.provider]);

  // 外部入口每次请求都重新应用「当前项目」过滤，即使用户之前手动 × 掉过。
  useEffect(() => {
    setScopeDismissed(false);
  }, [focusToken]);

  // 模型菜单数据源：挂载时加载，右键打开时用缓存。
  useEffect(() => {
    void (provider === 'claude' ? refreshClaudeLaunchTargets() : refreshCodexLaunchTargets());
  }, [provider, refreshClaudeLaunchTargets, refreshCodexLaunchTargets]);

  useEffect(() => {
    searchRequestRef.current += 1;
    setFulltextHits(null);
    setSearching(false);
    setItems([]);
    setSelectedId(null);
    setSelectedIds(new Set());
    selectionAnchor.current = null;
  }, [activeScope]);

  useEffect(() => () => {
    loadRequestRef.current += 1;
    searchRequestRef.current += 1;
  }, []);

  // 宽度与其余侧栏面板共用一套：侧栏风格下都是 configNavWidth，拖完互相广播同步
  const { width, setWidth, isResizing, resizeHandleProps } = useResizablePanel({
    defaultWidth: 250,
    minWidth: 150,
    maxWidth: isSidebarMode ? 400 : 500,
    onResizeEnd: (w) => {
      const saveWidth = isSidebarMode ? saveConfigNavWidth : saveFileNavWidth;
      saveWidth(w).catch(console.error);
      notifyTerminalPanelResize();
      if (isSidebarMode) {
        window.dispatchEvent(new CustomEvent('navigation-width-changed', { detail: w }));
      }
    },
  });

  useEffect(() => {
    if (isResizing) notifyTerminalPanelResize();
  }, [isResizing, width]);

  useEffect(() => {
    getBackendAppSettings()
      .then(s => setWidth(isSidebarMode ? s.configNavWidth || 250 : s.fileNavWidth || 250))
      .catch(() => {});
  }, [isSidebarMode, setWidth]);

  useEffect(() => {
    if (!isSidebarMode) return;
    const syncWidth = (event: Event) => {
      const next = (event as CustomEvent<number>).detail;
      if (Number.isFinite(next)) setWidth(next);
    };
    window.addEventListener('navigation-width-changed', syncWidth);
    return () => window.removeEventListener('navigation-width-changed', syncWidth);
  }, [isSidebarMode, setWidth]);

  // 过滤生效 ↔ 全目录视图切换时清掉手动翻转，让默认态接管：
  // 切页签收窄到单项目 → 该分组自动展开；× 掉过滤 → 各分组自动收起
  useEffect(() => {
    setToggledDirs(new Set());
  }, [activeScope]);

  const toggleDirExpanded = useCallback((dir: string) => {
    setToggledDirs(prev => setGroupExpanded(
      prev, dir, Boolean(activeScope), !isGroupExpanded(prev, dir, Boolean(activeScope)),
    ));
  }, [activeScope]);

  const load = useCallback(async (withRescan: boolean) => {
    const request = ++loadRequestRef.current;
    setLoading(true);
    try {
      if (withRescan && !scanPromiseRef.current) scanPromiseRef.current = history.rescan();
      const scanPromise = scanPromiseRef.current;
      if (scanPromise) {
        try {
          const scan = await scanPromise;
          if (request === loadRequestRef.current) setPendingCount(scan.pending);
        } finally {
          if (scanPromiseRef.current === scanPromise) scanPromiseRef.current = null;
        }
      }
      const nextItems = await history.list(includeArchived, activeScope);
      if (request !== loadRequestRef.current) return;
      setItems(nextItems);
      setLoaded(true);
    } catch (error) {
      if (request === loadRequestRef.current) showToast(`加载 ${history.label} 会话失败: ${String(error)}`, 'error');
    } finally {
      if (request === loadRequestRef.current) setLoading(false);
    }
  }, [history, includeArchived, activeScope, showToast]);

  // 首次进入扫描 + 索引；之后（如切换归档开关）只重取列表，不重扫
  useEffect(() => {
    void load(!initialLoadRef.current);
    initialLoadRef.current = true;
  }, [load]);

  // 扫描只处理最近一批，剩余由后台补齐任务分批索引；每批完成广播一次，
  // 这里跟着重取列表即可，绝不能再触发 rescan（否则补齐任务层层叠加）。
  useEffect(() => {
    const unlisten = listen<ClaudeHistoryScanResult>(history.indexedEvent, event => {
      setPendingCount(event.payload.pending);
      void load(false);
    });
    return () => {
      void unlisten.then(fn => fn());
    };
  }, [history, load]);

  // 服务端自动归档完成后重取列表：两个 Agent 的会话都可能被归档，与当前面板无关。
  useEffect(() => {
    const unlisten = listen(AGENT_HISTORY_AUTO_ARCHIVED_EVENT, () => {
      void load(false);
    });
    return () => {
      void unlisten.then(fn => fn());
    };
  }, [load]);

  // 点击空白关闭右键菜单
  useEffect(() => {
    if (!contextMenu) return;
    const dismiss = () => setContextMenu(null);
    document.addEventListener('click', dismiss);
    return () => document.removeEventListener('click', dismiss);
  }, [contextMenu]);

  // 记录指针最后按下的位置是否在面板内。本面板自身的 F2/Del 用 pointerInPanelRef 判：
  // lastClickRegion 落进终端区不会改写，那样终端里敲 Delete 会被当成删除会话记录。
  // 面板内点击时同步写 lastClickRegion='history'，让 TabNav/ConfigNav 的 F2 不再抢走按键。
  useEffect(() => {
    const track = (e: MouseEvent) => {
      const root = rootRef.current;
      pointerInPanelRef.current = Boolean(
        root && e.target instanceof Node && root.contains(e.target),
      );
      if (pointerInPanelRef.current) {
        useAppStore.getState().setLastClickRegion('history');
      }
    };
    document.addEventListener('mousedown', track, true);
    return () => document.removeEventListener('mousedown', track, true);
  }, []);

  // 会话 → 运行中终端映射（terminalId → claudeSessionId 反查）
  const liveTerminalBySession = useMemo(() => {
    const map = new Map<string, string>();
    if (provider === 'claude') {
      for (const [terminalId, claudeId] of Object.entries(claudeSessionIds)) map.set(claudeId, terminalId);
    } else {
      for (const session of sessions) {
        if (session.extraParamMode !== 'independent') continue;
        const id = resumedCodexSessionId(session.extraParams);
        if (id) map.set(id, session.id);
      }
    }
    return map;
  }, [provider, sessions, claudeSessionIds]);

  const filteredItems = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return items;
    return items.filter(item =>
      (item.customTitle || item.title).toLowerCase().includes(keyword)
      || item.projectDir.toLowerCase().includes(keyword)
      || (projectForDirectory(projects, item.projectDir)?.name.toLowerCase().includes(keyword) ?? false));
  }, [items, projects, query]);

  const groups = useMemo(() => {
    const map = new Map<string, ClaudeSessionItem[]>();
    for (const item of filteredItems) {
      const key = groupKeyOf(item, projects);
      const list = map.get(key) ?? [];
      list.push(item);
      map.set(key, list);
    }
    return [...map.entries()].sort((a, b) => (b[1][0]?.updatedAt ?? 0) - (a[1][0]?.updatedAt ?? 0));
  }, [filteredItems, projects]);

  const hitGroups = useMemo(() => {
    if (!fulltextHits) return null;
    const map = new Map<string, ClaudeSearchHit[]>();
    for (const hit of fulltextHits) {
      const list = map.get(hit.sessionId) ?? [];
      list.push(hit);
      map.set(hit.sessionId, list);
    }
    return [...map.entries()];
  }, [fulltextHits]);

  const runFulltextSearch = useCallback(async () => {
    const keyword = query.trim();
    if (!keyword) return;
    const request = ++searchRequestRef.current;
    setSearching(true);
    setFulltextQuery(keyword);
    try {
      const hits = await history.search(keyword, activeScope);
      if (request === searchRequestRef.current) setFulltextHits(hits);
    } catch (error) {
      if (request === searchRequestRef.current) showToast(`全文检索失败: ${String(error)}`, 'error');
    } finally {
      if (request === searchRequestRef.current) setSearching(false);
    }
  }, [history, query, activeScope, showToast]);

  const exitFulltext = useCallback(() => {
    searchRequestRef.current += 1;
    setSearching(false);
    setFulltextHits(null);
    setFulltextQuery('');
  }, []);

  // 「新会话形态」为原生会话时，历史恢复走原生聊天标签（独立 CLI 进程 + --resume/thread 续接），
  // 与项目模型启动共用同一开关；会话仍活在某个终端里时保持终端路径（聚焦原终端）。
  const resumeNative = useCallback(async (item: ClaudeSessionItem, vendorRef?: ClaudeVendorRef) => {
    const session = await aiSessionResumeHistory(
      provider,
      item.sessionId,
      vendorRef?.providerId || null,
      vendorRef?.modelId || null,
    );
    openExistingAgentSession(session);
  }, [provider]);

  const handleResume = useCallback((item: ClaudeSessionItem) => {
    if (getAppSettings().nativeChatSessions && !liveTerminalBySession.has(item.sessionId)) {
      void resumeNative(item).catch(error => showToast(`恢复会话失败: ${String(error)}`, 'error'));
      return;
    }
    void history.resume({
      sessionId: item.sessionId,
      title: item.customTitle || item.title,
      projectDir: item.projectDir,
    }).catch(error => showToast(`恢复会话失败: ${String(error)}`, 'error'));
  }, [history, liveTerminalBySession, resumeNative, showToast]);

  const handleResumeWithModel = useCallback((item: ClaudeSessionItem, vendorRef: ClaudeVendorRef) => {
    if (getAppSettings().nativeChatSessions && !liveTerminalBySession.has(item.sessionId)) {
      void resumeNative(item, vendorRef).catch(error => showToast(`恢复会话失败: ${String(error)}`, 'error'));
      return;
    }
    void history.resume({
      sessionId: item.sessionId,
      title: item.customTitle || item.title,
      projectDir: item.projectDir,
    }, vendorRef).catch(error => showToast(`恢复会话失败: ${String(error)}`, 'error'));
  }, [history, liveTerminalBySession, resumeNative, showToast]);

  const handleReplay = useCallback((sessionId: string, title: string, projectDir: string, focusSeq?: number) => {
    openClaudeReplayTab({ sessionId, title, projectDir, focusSeq, provider });
  }, [openClaudeReplayTab, provider]);

  const openContextMenu = useCallback((e: React.MouseEvent, item: ClaudeSessionItem) => {
    e.preventDefault();
    e.stopPropagation();
    if (!selectedIds.has(item.sessionId)) {
      setSelectedIds(new Set([item.sessionId]));
      selectionAnchor.current = item.sessionId;
    }
    setSelectedId(item.sessionId);
    const MENU_W = 210;
    const MENU_H = 320;
    const pos = fitContextMenuToViewport(e.clientX, e.clientY, MENU_W, MENU_H);
    setContextMenu({ x: pos.x, y: pos.y, item });
  }, [selectedIds]);

  const handleToggleFlag = useCallback(async (
    item: ClaudeSessionItem,
    options: { starred?: boolean; archived?: boolean },
  ) => {
    try {
      await history.setFlags(item.sessionId, options);
      await load(false);
    } catch (error) {
      showToast(`操作失败: ${String(error)}`, 'error');
    }
  }, [history, load, showToast]);

  const handleRenameSubmit = useCallback(async (item: ClaudeSessionItem) => {
    const title = renameValue.trim();
    setRenamingId(null);
    if (!title || title === (item.customTitle || item.title)) return;
    try {
      await history.rename(item.sessionId, title);
      await load(false);
    } catch (error) {
      showToast(`重命名失败: ${String(error)}`, 'error');
    }
  }, [history, renameValue, load, showToast]);

  const handleDelete = useCallback(async (targets: ClaudeSessionItem[]) => {
    try {
      await history.deleteMany(targets.map(item => item.sessionId));
      setDeleteTarget([]);
      setSelectedIds(new Set());
      setSelectedId(null);
      showToast('已删除 ' + targets.length + ' 条记录', 'success');
      await load(false);
    } catch (error) { showToast(`删除失败: ${String(error)}`, 'error'); }
  }, [history, load, showToast]);

  const handleBulkFlag = useCallback(async (targets: ClaudeSessionItem[], options: { starred?: boolean; archived?: boolean }) => {
    const results = await Promise.allSettled(targets.map(item => history.setFlags(item.sessionId, options)));
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length) showToast(`${failures.length} 条操作失败`, 'error');
    await load(false);
  }, [history, load, showToast]);

  const visibleSessionIds = useMemo(() => groups.flatMap(([dir, list]) =>
    isGroupExpanded(toggledDirs, dir, Boolean(activeScope)) || query.trim() ? list.map(item => item.sessionId) : []
  ), [groups, toggledDirs, activeScope, query]);

  const selectRow = (event: React.MouseEvent, id: string) => {
    if (event.shiftKey && selectionAnchor.current) {
      const start = visibleSessionIds.indexOf(selectionAnchor.current);
      const end = visibleSessionIds.indexOf(id);
      setSelectedIds(start < 0 || end < 0 ? new Set([id]) :
        new Set(visibleSessionIds.slice(Math.min(start, end), Math.max(start, end) + 1)));
    } else if (event.ctrlKey || event.metaKey) {
      setSelectedIds(previous => {
        const next = new Set(previous);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
      });
      selectionAnchor.current = id;
    } else {
      setSelectedIds(new Set([id]));
      selectionAnchor.current = id;
    }
    setSelectedId(id);
  };

  const selectedItems = items.filter(item => selectedIds.has(item.sessionId));

  // 右键菜单在打开后可能被后台索引刷新替换掉旧对象；操作时始终取列表里的最新条目，
  // 否则「收藏/归档」会按打开菜单时的旧状态反向切换。
  const contextMenuItem = contextMenu
    ? items.find(item => item.sessionId === contextMenu.item.sessionId) ?? contextMenu.item
    : null;

  const itemTitle = (item: ClaudeSessionItem) => item.customTitle || item.title;

  // F2 重命名 / Del 删除选中的会话
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'F2' && e.key !== 'Delete') return;
      if (!isActive || !pointerInPanelRef.current) return;
      // 搜索框与重命名框里打字时不劫持按键
      if (e.target instanceof HTMLElement && e.target.closest('input, textarea')) return;
      if (renamingId || deleteTarget.length || exportTarget) return;
      const item = items.find(i => i.sessionId === selectedId);
      if (!item && selectedItems.length === 0) return;
      e.preventDefault();
      if (e.key === 'F2' && selectedItems.length <= 1 && item) {
        // 折叠中的分组先展开，否则重命名输入框看不见
        const key = groupKeyOf(item, projects);
        setToggledDirs(prev => setGroupExpanded(prev, key, Boolean(activeScope), true));
        setRenameValue(item.customTitle || item.title);
        setRenamingId(item.sessionId);
      } else if (e.key === 'Delete') {
        setDeleteTarget(selectedItems.length ? selectedItems : item ? [item] : []);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isActive, items, selectedId, selectedItems, renamingId, deleteTarget, exportTarget, activeScope, projects]);

  const renderSessionRow = (item: ClaudeSessionItem) => {
    const live = liveTerminalBySession.get(item.sessionId);
    const selected = selectedIds.has(item.sessionId);
    return (
      <div
        key={item.sessionId}
        className={`claude-hist-item${selected ? ' selected' : ''}`}
        onClick={e => selectRow(e, item.sessionId)}
        onDoubleClick={() => handleResume(item)}
        onContextMenu={e => openContextMenu(e, item)}
        title="单击选中 · Shift 连选 · Ctrl 多选 · Del 批量删除"
      >
        {renamingId === item.sessionId ? (
          <input
            className="claude-hist-rename-input"
            value={renameValue}
            autoFocus
            onChange={e => setRenameValue(e.target.value)}
            onBlur={() => void handleRenameSubmit(item)}
            onKeyDown={e => {
              if (e.key === 'Enter') void handleRenameSubmit(item);
              if (e.key === 'Escape') setRenamingId(null);
            }}
            onClick={e => e.stopPropagation()}
          />
        ) : (
          <div className="claude-hist-item-title">
            {item.starred && <span className="claude-hist-star">★</span>}
            <span className="claude-hist-item-name">{itemTitle(item)}</span>
            {item.archived && <span className="claude-hist-badge archived">归档</span>}
            {live && <span className="claude-hist-badge live">进行中</span>}
          </div>
        )}
        <div className="claude-hist-item-meta">
          {formatTime(item.updatedAt)}
          {item.messageCount > 0 && ` · ${item.messageCount} 条`}
          {formatTokens(item.inputTokens, item.outputTokens) && ` · ${formatTokens(item.inputTokens, item.outputTokens)}`}
        </div>
      </div>
    );
  };

  return (
    <div
      ref={rootRef}
      className={`claude-hist${isSidebarMode ? ' sidebar-mode' : ''}${historyPanelVisible ? '' : ' collapsed'}`}
      style={{ width }}
    >
      <div className="panel-titlebar">
        <span className="panel-title">会话历史</span>
        <span className="panel-title-count">{items.length}</span>
      </div>
      <div className="session-history-tabs" role="tablist" aria-label="会话来源">
        {providers.map((source, index) => (
          <button
            key={source}
            id={`session-history-tab-${source}`}
            type="button"
            role="tab"
            aria-selected={provider === source}
            aria-controls="session-history-list"
            tabIndex={provider === source ? 0 : -1}
            className={`session-history-tab${provider === source ? ' active' : ''}`}
            onClick={() => onProviderChange(source)}
            onKeyDown={event => {
              if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                event.preventDefault();
                const direction = event.key === 'ArrowLeft' ? -1 : 1;
                const next = providers[(index + direction + providers.length) % providers.length];
                onProviderChange(next);
                requestAnimationFrame(() => document.getElementById(`session-history-tab-${next}`)?.focus());
              }
            }}
          >
            {sessionHistory(source).label}
          </button>
        ))}
      </div>
      <div className="claude-hist-toolbar">
        <input
          className="claude-hist-search"
          placeholder="搜索会话…"
          value={query}
          onChange={e => {
            setQuery(e.target.value);
            exitFulltext();
          }}
          onKeyDown={e => {
            if (e.key === 'Enter') void runFulltextSearch();
            if (e.key === 'Escape') {
              setQuery('');
              exitFulltext();
            }
          }}
        />
        {scopeDir && (activeScope ? (
          <div className="claude-hist-filter" title={`仅显示该项目的会话：${scopeDir}`}>
            <Folder size={12} />
            <span className="claude-hist-filter-path">{projectForDirectory(projects, scopeDir)?.name ?? scopeDir}</span>
            <button
              type="button"
              className="claude-hist-filter-clear"
              title="显示全部目录的会话"
              aria-label="显示全部目录的会话"
              onClick={() => setScopeDismissed(true)}
            >
              <X size={12} />
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="claude-hist-filter-reset"
            onClick={() => setScopeDismissed(false)}
          >
            仅看当前项目
          </button>
        ))}
        <div className="claude-hist-toolbar-row">
          <label className="claude-hist-archived-toggle">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={e => setIncludeArchived(e.target.checked)}
            />
            显示已归档
          </label>
          <button
            type="button"
            className="claude-hist-tool-btn"
            title="重新扫描并索引"
            onClick={() => void load(true)}
          >
            {loading ? '…' : '↻'}
          </button>
          {pendingCount > 0 && (
            <span className="claude-hist-indexing" title="后台正在补齐剩余会话索引">
              索引中 · 剩 {pendingCount}
            </span>
          )}
        </div>
        {query.trim() && !fulltextHits && (
          <button
            type="button"
            className="claude-hist-fulltext-btn"
            disabled={searching}
            onClick={() => void runFulltextSearch()}
          >
            {searching ? '检索中…' : `在全部会话内容中搜索「${query.trim()}」`}
          </button>
        )}
      </div>

      {selectedItems.length > 1 && <div className="claude-hist-bulk-bar">
        <span className="claude-hist-bulk-count">已选 {selectedItems.length} 条</span>
        <button type="button" onClick={() => void handleBulkFlag(selectedItems, { starred: true })}>收藏</button>
        <button type="button" onClick={() => void handleBulkFlag(selectedItems, { starred: false })}>取消收藏</button>
        <button type="button" onClick={() => void handleBulkFlag(selectedItems, { archived: true })}>归档</button>
        <button type="button" onClick={() => void handleBulkFlag(selectedItems, { archived: false })}>取消归档</button>
        <button type="button" className="danger" onClick={() => setDeleteTarget(selectedItems)}>删除所选</button>
        <button type="button" onClick={() => { setSelectedIds(new Set()); setSelectedId(null); }}>取消选择</button>
      </div>}
      <div id="session-history-list" className="claude-hist-list" role="tabpanel" aria-labelledby={`session-history-tab-${provider}`}>
        {!loaded && loading && <div className="claude-hist-empty">正在扫描 {history.home} 会话记录…</div>}
        {loaded && !loading && items.length === 0 && (
          <div className="claude-hist-empty">暂无历史会话记录</div>
        )}

        {hitGroups && (
          <>
            <div className="claude-hist-fulltext-head">
              全文搜索「{fulltextQuery}」· 命中 {fulltextHits!.length} 处 / {hitGroups.length} 个会话
              <button type="button" className="claude-hist-tool-btn" onClick={exitFulltext}>返回列表</button>
            </div>
            {hitGroups.length === 0 && <div className="claude-hist-empty">没有命中任何会话内容</div>}
            {hitGroups.map(([sessionId, hits]) => {
              const item = items.find(i => i.sessionId === sessionId);
              const title = item ? itemTitle(item) : hits[0].title;
              return (
                <div key={sessionId} className="claude-hist-group">
                  <div
                    className="claude-hist-hit-session"
                    onClick={() => setSelectedId(sessionId)}
                    onDoubleClick={() => item && handleResume(item)}
                    onContextMenu={e => item && openContextMenu(e, item)}
                  >
                    {item?.starred && <span className="claude-hist-star">★</span>}
                    {title}
                  </div>
                  {hits.slice(0, 4).map(hit => (
                    <div
                      key={`${hit.sessionId}-${hit.seq}`}
                      className="claude-hist-hit"
                      onClick={() => handleReplay(sessionId, title, hit.projectDir, hit.seq)}
                      title="点击跳转回放定位"
                    >
                      <div className="claude-hist-hit-snippet">{hit.snippet}</div>
                      <div className="claude-hist-hit-meta">
                        {formatTime(hit.timestamp)} · 第 {hit.seq + 1} 条消息 · 点击定位回放
                      </div>
                    </div>
                  ))}
                  {hits.length > 4 && (
                    <div className="claude-hist-hit-more">还有 {hits.length - 4} 处命中</div>
                  )}
                </div>
              );
            })}
          </>
        )}

        {!hitGroups && groups.map(([dir, list]) => {
          // 有过滤词时强制展开，否则命中的会话会被收起的分组藏住
          const expanded = isGroupExpanded(toggledDirs, dir, Boolean(activeScope))
            || Boolean(query.trim());
          const project = projectForDirectory(projects, list[0].projectDir);
          return (
            <div key={dir} className="claude-hist-group">
              <div
                className="claude-hist-group-title"
                title={project?.path ?? dir}
                role="button"
                tabIndex={0}
                aria-expanded={expanded}
                onClick={() => toggleDirExpanded(dir)}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggleDirExpanded(dir);
                  }
                }}
              >
                {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <Folder size={13} />
                <span className="claude-hist-group-name">{project?.name ?? dir}</span>
                <span className="claude-hist-group-count">{list.length}</span>
              </div>
              {expanded && list.map(renderSessionRow)}
            </div>
          );
        })}
      </div>

      <div
        className={`resize-handle ${isResizing ? 'active' : ''}`}
        {...resizeHandleProps}
      />

      {contextMenu && contextMenuItem && (
        <div
          ref={menuRef}
          className="claude-hist-context"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={e => e.stopPropagation()}
        >
          {selectedItems.length > 1 ? <>
            <div className="claude-hist-fulltext-head">已选 {selectedItems.length} 条会话</div>
            <MenuItem icon={Star} label="批量收藏" onClick={() => { void handleBulkFlag(selectedItems, { starred: true }); setContextMenu(null); }} />
            <MenuItem icon={StarOff} label="批量取消收藏" onClick={() => { void handleBulkFlag(selectedItems, { starred: false }); setContextMenu(null); }} />
            <MenuItem icon={Archive} label="批量归档" onClick={() => { void handleBulkFlag(selectedItems, { archived: true }); setContextMenu(null); }} />
            <MenuItem icon={ArchiveRestore} label="批量取消归档" onClick={() => { void handleBulkFlag(selectedItems, { archived: false }); setContextMenu(null); }} />
            <MenuItem icon={Trash2} label="批量删除…" danger onClick={() => { setDeleteTarget(selectedItems); setContextMenu(null); }} />
          </> : <>
          <MenuItem
            icon={Play}
            label="恢复会话"
            hint="（双击）"
            onClick={() => { handleResume(contextMenuItem); setContextMenu(null); }}
          />
          <ClaudeModelMenuSection
            source={provider}
            itemClassName="claude-hist-context-item"
            separatorClassName="claude-hist-context-sep"
            title="指定模型恢复"
            onPickModel={(providerId, modelId) => {
              const item = contextMenuItem;
              setContextMenu(null);
              handleResumeWithModel(item, { providerId, modelId });
            }}
            onGotoProviders={() => { setContextMenu(null); useAppStore.getState().setProviderSettingsTab(provider); openSettingsDialog('llm-providers'); }}
          />
          <MenuItem
            icon={Eye}
            label="查看详情 / 回放"
            onClick={() => {
              handleReplay(contextMenuItem.sessionId, itemTitle(contextMenuItem), contextMenuItem.projectDir);
              setContextMenu(null);
            }}
          />
          <MenuItem
            icon={Download}
            label="导出…"
            onClick={() => { setExportTarget(contextMenuItem); setContextMenu(null); }}
          />
          <div className="claude-hist-context-sep" />
          <MenuItem
            icon={Pencil}
            label="重命名…"
            onClick={() => {
              setRenameValue(itemTitle(contextMenuItem));
              setRenamingId(contextMenuItem.sessionId);
              setContextMenu(null);
            }}
          />
          <MenuItem
            icon={contextMenuItem.starred ? StarOff : Star}
            label={contextMenuItem.starred ? '取消收藏' : '收藏'}
            onClick={() => {
              void handleToggleFlag(contextMenuItem, { starred: !contextMenuItem.starred });
              setContextMenu(null);
            }}
          />
          <MenuItem
            icon={contextMenuItem.archived ? ArchiveRestore : Archive}
            label={contextMenuItem.archived ? '取消归档' : '归档'}
            onClick={() => {
              void handleToggleFlag(contextMenuItem, { archived: !contextMenuItem.archived });
              setContextMenu(null);
            }}
          />
          <MenuItem
            icon={Trash2}
            label="删除记录…"
            danger
            onClick={() => { setDeleteTarget([contextMenuItem]); setContextMenu(null); }}
          />
          <div className="claude-hist-context-sep" />
          <MenuItem
            icon={Copy}
            label="复制会话 ID"
            onClick={() => {
              void navigator.clipboard.writeText(contextMenuItem.sessionId)
                .then(() => showToast('会话 ID 已复制', 'success'))
                .catch(error => showToast(`复制失败: ${String(error)}`, 'error'));
              setContextMenu(null);
            }}
          />
          {supportsSystemExplorerOpen() && (
          <MenuItem
            icon={FolderOpen}
            label="打开所在文件夹"
            onClick={() => {
              void openInExplorer(contextMenuItem.filePath).catch(error => showToast(String(error), 'error'));
              setContextMenu(null);
            }}
          />
          )}
          </>}
        </div>
      )}

      {exportTarget && (
        <ClaudeExportDialog
          provider={provider}
          sessionId={exportTarget.sessionId}
          title={itemTitle(exportTarget)}
          onClose={() => setExportTarget(null)}
        />
      )}
      {deleteTarget.length > 0 && (
        <ConfirmDialog
          title="删除会话记录"
          message={`确定删除 ${deleteTarget.length} 条会话记录吗？记录文件将移入回收目录。`}
          confirmText="删除"
          onClose={() => setDeleteTarget([])}
          onConfirm={() => void handleDelete(deleteTarget)}
        />
      )}
    </div>
  );
};
