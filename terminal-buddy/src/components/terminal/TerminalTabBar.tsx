import { terminalTabTitle, useTaskSummaryStore } from '../../stores/taskSummaryStore';
import { FC, memo, RefObject, useState, useEffect, useCallback, useRef } from 'react';
import { CalendarClock, FileDiff, FileText, GitBranch, History, SquareTerminal, X } from 'lucide-react';
import { isTerminalWorking, useAppStore, sessionReplayTabKey } from '../../stores/appStore';
import { saveEnableTabNavigation } from '../../services/tauri';
import { getAppSettings, saveAppSettings } from '../../utils/settings';
import { getIndicatorLight, getIndicatorColor, getIndicatorTitle, getIndicatorClassName, getNativeAgentLight } from '../../utils/claudeIndicator';
import { AgentIcon } from '../agent-chat/AgentIcon';
import { parseClaudeRef } from '../../utils/claudeLaunch';
import { parseCodexRef } from '../../utils/codexLaunch';
import { getTaskLaunchInfo } from '../../utils/taskLaunchInfo';
import { isDockerClient } from '../../services/platform';
import { ConfirmDialog, Dialog } from '../shared/Dialog';
import { AgentTabContextMenu } from '../shell/AgentTabContextMenu';
import { cleanupDraftFiles, useSessionCloseActions } from '../../hooks/useSessionCloseActions';
import type { TerminalSession } from '../../types';
import './TerminalTabBar.css';

interface TerminalSessionTabItemProps {
  session: TerminalSession;
  isActive: boolean;
  isRenaming: boolean;
  renameValue: string;
  renameInputRef: RefObject<HTMLInputElement | null>;
  onRenameChange: (value: string) => void;
  onCommitRename: (sessionId: string) => void;
  onCancelRename: () => void;
  onClose: (sessionId: string) => void;
  onOpenContextMenu: (x: number, y: number, sessionId: string) => void;
}

/** 单标签订阅自身活动态与摘要，避免任意终端状态跳动导致全部标签重渲染 */
const TerminalSessionTabItem = memo(function TerminalSessionTabItem({
  session,
  isActive,
  isRenaming,
  renameValue,
  renameInputRef,
  onRenameChange,
  onCommitRename,
  onCancelRename,
  onClose,
  onOpenContextMenu,
}: TerminalSessionTabItemProps) {
  const activity = useAppStore(s => s.terminalActivities[session.id]);
  const takeover = useAppStore(s => s.terminalWebTakeovers[session.id]);
  const profileStartupCommands = useAppStore(
    useCallback(s => s.profiles.find(item => item.id === session.profileId)?.startupCommands, [session.profileId]),
  );
  const taskSummary = useTaskSummaryStore(s => s.summaries[session.id]);
  const taskProvider = useTaskSummaryStore(s => s.providers[session.id]);
  const tabTitle = terminalTabTitle(session.profileName, taskSummary, session.manualTitle);

  return (
    <div
      className={`terminal-tab ${isActive ? 'active' : ''}`}
      onClick={() => {
        const store = useAppStore.getState();
        if (store.splitMode !== 'off') {
          if (!store.splitSlots.some(slot => slot.sessionId === session.id)) {
            store.placeSessionInSplitSlot(session.id);
          } else {
            store.setActiveSession(session.id);
          }
        } else {
          store.setActiveSession(session.id);
        }
      }}
      onAuxClick={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          onClose(session.id);
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onOpenContextMenu(e.clientX, e.clientY, session.id);
      }}
    >
      {session.sessionType === 'editor' ? (
        <FileText className="tab-file-icon" aria-hidden="true" />
      ) : (() => {
        const light = getIndicatorLight(activity);
        return (
          <span
            className={`terminal-tab-dot${getIndicatorClassName(light)}`}
            style={{ background: getIndicatorColor(light, session.tabColor) }}
            title={getIndicatorTitle(light, activity?.provider) || undefined}
            onClick={(e) => {
              // 错误指示灯点击清除，其它状态（含 attention）交由标签点击聚焦该终端
              if (light !== 'failed') return;
              e.stopPropagation();
              useAppStore.getState().clearClaudeFailure(session.id);
            }}
          />
        );
      })()}
      {session.isDirty && <span className="tab-dirty-dot" />}
      {isRenaming ? (
        <input
          ref={renameInputRef}
          className="tab-bar-rename-input"
          value={renameValue}
          onChange={(e) => onRenameChange(e.target.value)}
          onBlur={() => onCommitRename(session.id)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              onCommitRename(session.id);
            } else if (e.key === 'Escape') {
              onCancelRename();
            }
          }}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <>
          {session.sessionType !== 'editor' && (() => {
            const params = session.extraParams ?? '';
            const modelRef = parseCodexRef(params) ?? parseClaudeRef(params);
            const launchInfo = getTaskLaunchInfo(params, profileStartupCommands, session.extraParamMode);
            const detectedProvider = taskSummary?.provider ?? taskProvider ?? launchInfo?.provider;
            const antigravityModel = detectedProvider === 'antigravity'
              ? (taskSummary?.model ?? (launchInfo?.provider === 'antigravity' ? launchInfo.model : undefined))
              : undefined;
            return (
              <>
                {detectedProvider === 'antigravity' && (
                  <AgentIcon provider="antigravity" className="terminal-tab-agent-icon" />
                )}
                {modelRef ? (
                  <span className="terminal-tab-model-chip" title="供应商模型">{modelRef.modelId}</span>
                ) : antigravityModel ? (
                  <span className="terminal-tab-model-chip" title="Antigravity 模型">{antigravityModel}</span>
                ) : null}
              </>
            );
          })()}
          <span className="terminal-tab-name" title={tabTitle} style={session.tabColor ? { color: session.tabColor } : undefined}>{tabTitle}</span>
          {/* Docker 端所有会话都来自网页端，Web 标签没有区分度，故隐藏 */}
          {session.owner === 'web' && !isDockerClient() && <span className="terminal-owner-badge">Web</span>}
          {session.owner !== 'web' && takeover && (
            <span className="terminal-takeover-badge" title="当前终端正在被 Web 端接管">接管中</span>
          )}
        </>
      )}
      <button
        className="terminal-tab-close"
        onClick={(e) => {
          e.stopPropagation();
          onClose(session.id);
        }}
        title="关闭"
        aria-label={`关闭 ${session.profileName}`}
      ><X aria-hidden="true" /></button>
    </div>
  );
});

export const TerminalTabBar: FC = () => {
  const sessions = useAppStore(s => s.sessions);
  const activeSessionId = useAppStore(s => s.activeSessionId);
  const renameSession = useAppStore(s => s.renameSession);
  const {
    confirmDialog,
    setConfirmDialog,
    draftCloseDialog,
    setDraftCloseDialog,
    handleCloseTerminal,
    handleDraftSaveAs,
    handleDraftDiscard,
    closeSessionsWithBackend,
  } = useSessionCloseActions();
  const gitHistoryTab = useAppStore(s => s.gitHistoryTab);
  const openGitHistoryTab = useAppStore(s => s.openGitHistoryTab);
  const closeGitHistoryTab = useAppStore(s => s.closeGitHistoryTab);
  const gitChangesTab = useAppStore(s => s.gitChangesTab);
  const openGitChangesTab = useAppStore(s => s.openGitChangesTab);
  const closeGitChangesTab = useAppStore(s => s.closeGitChangesTab);
  const claudeReplayTab = useAppStore(s => s.claudeReplayTab);
  const claudeReplayTabs = useAppStore(s => s.claudeReplayTabs);
  const openClaudeReplayTab = useAppStore(s => s.openClaudeReplayTab);
  const closeClaudeReplayTab = useAppStore(s => s.closeClaudeReplayTab);
  const activeSpecialTab = useAppStore(s => s.activeSpecialTab);
  const scheduledTasksTabOpen = useAppStore(s => s.scheduledTasksTabOpen);
  const openScheduledTasksPage = useAppStore(s => s.openScheduledTasksPage);
  const closeScheduledTasksPage = useAppStore(s => s.closeScheduledTasksPage);
  const agentTabs = useAppStore(s => s.agentTabs);
  const activeAgentTabKey = useAppStore(s => s.activeAgentTabKey);
  const closeAgentTab = useAppStore(s => s.closeAgentTab);
  const setActiveAgentTab = useAppStore(s => s.setActiveAgentTab);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; sessionId: string } | null>(null);
  // 原生会话标签的右键菜单（与终端标签共用 .context-menu 样式）。
  const [agentTabMenu, setAgentTabMenu] = useState<{ x: number; y: number; key: string } | null>(null);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  // 打开重命名时的初始值：未改动就不落库，避免把摘要原样固化成名称
  const renameBaselineRef = useRef('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  const closeBatch = useCallback((targets: TerminalSession[], title: string, scopeLabel: string) => {
    if (targets.length === 0) return;
    const activities = useAppStore.getState().terminalActivities;
    const workingCount = targets.filter(
      s => s.sessionType !== 'editor' && !s.starting && isTerminalWorking(activities[s.id]),
    ).length;
    const dirtyCount = targets.filter(s => s.isDirty).length;
    const performClose = () => {
      cleanupDraftFiles(targets);
      void closeSessionsWithBackend(targets);
    };
    if (workingCount > 0 || dirtyCount > 0) {
      const warnings: string[] = [];
      if (workingCount > 0) warnings.push(`${workingCount} 个终端正在执行任务`);
      if (dirtyCount > 0) warnings.push(`${dirtyCount} 个编辑器有未保存修改`);
      setConfirmDialog({
        title,
        message: `${scopeLabel} ${targets.length} 个选项卡中有 ${warnings.join('、')}，确定要关闭吗？`,
        onConfirm: () => {
          setConfirmDialog(null);
          performClose();
        },
      });
      return;
    }
    performClose();
  }, [closeSessionsWithBackend, setConfirmDialog]);

  const closeOthers = useCallback((sessionId: string) => {
    closeBatch(sessions.filter(session => session.id !== sessionId), '关闭其他', '其他');
  }, [closeBatch, sessions]);

  const closeLeft = useCallback((sessionId: string) => {
    const idx = sessions.findIndex(s => s.id === sessionId);
    closeBatch(idx <= 0 ? [] : sessions.slice(0, idx), '关闭左侧', '左侧');
  }, [closeBatch, sessions]);

  const closeRight = useCallback((sessionId: string) => {
    const idx = sessions.findIndex(s => s.id === sessionId);
    closeBatch(idx < 0 ? [] : sessions.slice(idx + 1), '关闭右侧', '右侧');
  }, [closeBatch, sessions]);

  useEffect(() => {
    if (!contextMenu) return;
    const handler = () => setContextMenu(null);
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [contextMenu]);

  // F2 快速重命名标签
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'F2') return;
      const store = useAppStore.getState();
      const region = store.lastClickRegion;
      if (region && region !== 'tab') return;
      if (!activeSessionId) return;
      const session = store.sessions.find(s => s.id === activeSessionId);
      if (session) {
        // 编辑所见即所得：输入框初始值取标签当前显示的标题（含摘要）
        const displayed = terminalTabTitle(session.profileName, useTaskSummaryStore.getState().summaries[session.id], session.manualTitle);
        setRenameValue(displayed);
        renameBaselineRef.current = displayed;
        setRenamingSessionId(activeSessionId);
        setTimeout(() => renameInputRef.current?.select(), 0);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [activeSessionId]);

  // F2 重命名时自动聚焦输入框
  useEffect(() => {
    if (renamingSessionId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingSessionId]);

  const handleOpenContextMenu = useCallback((x: number, y: number, sessionId: string) => {
    setContextMenu({ x, y, sessionId });
  }, []);

  const handleCommitRename = useCallback((sessionId: string) => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== renameBaselineRef.current) {
      renameSession(sessionId, trimmed);
    }
    setRenamingSessionId(null);
  }, [renameSession, renameValue]);

  const handleCancelRename = useCallback(() => {
    setRenamingSessionId(null);
  }, []);

  const sessionIdx = (id: string) => sessions.findIndex(s => s.id === id);

  return (
    <div
      className="terminal-tab-bar"
      onMouseDown={() => useAppStore.getState().setLastClickRegion('tab')}
    >
      {sessions.map((session) => (
        <TerminalSessionTabItem
          key={session.id}
          session={session}
          isActive={activeSpecialTab === null && activeSessionId === session.id}
          isRenaming={renamingSessionId === session.id}
          renameValue={renamingSessionId === session.id ? renameValue : ''}
          renameInputRef={renameInputRef}
          onRenameChange={setRenameValue}
          onCommitRename={handleCommitRename}
          onCancelRename={handleCancelRename}
          onClose={handleCloseTerminal}
          onOpenContextMenu={handleOpenContextMenu}
        />
      ))}
      {agentTabs.map(tab => (
        <div
          key={tab.key}
          className={`terminal-tab ${activeSpecialTab === 'agent-chat' && activeAgentTabKey === tab.key ? 'active' : ''}`}
          onClick={() => setActiveAgentTab(tab.key)}
          onContextMenu={tab.shape === 'native' ? (e) => {
            e.preventDefault();
            // 原生会话标签的右键菜单（含「以此配置新建终端」）；接力标签的菜单在终端上。
            setAgentTabMenu({ x: e.clientX, y: e.clientY, key: tab.key });
          } : undefined}
          onAuxClick={(e) => {
            if (e.button === 1) {
              e.preventDefault();
              closeAgentTab(tab.key);
            }
          }}
          onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
          title={tab.shape === 'native'
            ? `${tab.provider === 'codex' ? 'Codex' : 'Claude Code'} · ${tab.title}`
            : `终端接力 · ${tab.title}`}
        >
          {tab.shape === 'native' && (() => {
            // 原生会话的呼吸灯由会话状态驱动（与终端 hook 指示灯同一套样式/动画）。
            const light = getNativeAgentLight(tab.status);
            return (
              <span
                className={`terminal-tab-dot${getIndicatorClassName(light)}`}
                style={{ background: getIndicatorColor(light) }}
                title={getIndicatorTitle(light, tab.provider) || undefined}
                onClick={(e) => {
                  // 错误长红点击清除（本地确认）；等待确认不拦截，点击顺带打开聊天页处理。
                  if (light !== 'failed') return;
                  e.stopPropagation();
                  useAppStore.getState().updateAgentTab(tab.key, { status: 'idle' });
                }}
              />
            );
          })()}
          {tab.shape === 'native'
            ? <AgentIcon provider={tab.provider} className="terminal-tab-history-icon" />
            : <SquareTerminal className="terminal-tab-history-icon" aria-hidden="true" />}
          {/* 原生会话已有 Agent Logo，无需再显示 CLAUDE / CODEX 名称角标 */}
          {tab.shape !== 'native' && <span className="terminal-tab-agent-badge">AGENT</span>}
          <span className="terminal-tab-name">{tab.title}</span>
          <button className="terminal-tab-close" onClick={event => { event.stopPropagation(); closeAgentTab(tab.key); }}
            title="关闭" aria-label={`关闭 ${tab.title}`}><X aria-hidden="true" /></button>
        </div>
      ))}
      {scheduledTasksTabOpen && (
        <div
          className={`terminal-tab ${activeSpecialTab === 'scheduled-tasks' ? 'active' : ''}`}
          onClick={openScheduledTasksPage}
          onAuxClick={(e) => {
            if (e.button === 1) {
              e.preventDefault();
              closeScheduledTasksPage();
            }
          }}
          onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
          title="定时任务 · 按计划启动项目环境或执行 Agent 任务"
        >
          <CalendarClock className="terminal-tab-history-icon" aria-hidden="true" />
          <span className="terminal-tab-name">定时任务</span>
          <button
            className="terminal-tab-close"
            onClick={(e) => {
              e.stopPropagation();
              closeScheduledTasksPage();
            }}
            title="关闭"
            aria-label="关闭定时任务"
          ><X aria-hidden="true" /></button>
        </div>
      )}
      {gitChangesTab && (
        <div
          className={`terminal-tab ${activeSpecialTab === 'git-changes' ? 'active' : ''}`}
          onClick={() => openGitChangesTab(gitChangesTab)}
          onAuxClick={(e) => {
            if (e.button === 1) {
              e.preventDefault();
              closeGitChangesTab();
            }
          }}
          onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
          title={`${gitChangesTab.repoRoot} - 未提交变更`}
        >
          <FileDiff className="terminal-tab-history-icon" aria-hidden="true" />
          <span className="terminal-tab-name">未提交变更</span>
          <button
            className="terminal-tab-close"
            onClick={(e) => {
              e.stopPropagation();
              closeGitChangesTab();
            }}
            title="关闭"
            aria-label="关闭未提交变更"
          ><X aria-hidden="true" /></button>
        </div>
      )}
      {gitHistoryTab && (
        <div
          className={`terminal-tab ${activeSpecialTab === 'git-history' ? 'active' : ''}`}
          onClick={() => openGitHistoryTab(gitHistoryTab)}
          onAuxClick={(e) => {
            if (e.button === 1) {
              e.preventDefault();
              closeGitHistoryTab();
            }
          }}
          onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
          title={`${gitHistoryTab.repoRoot} - Git 历史记录`}
        >
          <GitBranch className="terminal-tab-history-icon" aria-hidden="true" />
          <span className="terminal-tab-name">Git 历史记录</span>
          <button
            className="terminal-tab-close"
            onClick={(e) => {
              e.stopPropagation();
              closeGitHistoryTab();
            }}
            title="关闭"
            aria-label="关闭 Git 历史记录"
          ><X aria-hidden="true" /></button>
        </div>
      )}
      {claudeReplayTabs.map(tab => (
        <div key={sessionReplayTabKey(tab)} className={`terminal-tab ${activeSpecialTab === 'claude-replay' && claudeReplayTab && sessionReplayTabKey(claudeReplayTab) === sessionReplayTabKey(tab) ? 'active' : ''}`}
          onClick={() => openClaudeReplayTab(tab)}
          onAuxClick={(e) => {
            if (e.button === 1) {
              e.preventDefault();
              closeClaudeReplayTab(tab.sessionId, tab.provider);
            }
          }}
          onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
          title={`${tab.provider === 'codex' ? 'Codex' : tab.provider === 'antigravity' ? 'Antigravity CLI' : 'Claude Code'} · ${tab.title}`}>
          <History className="terminal-tab-history-icon" aria-hidden="true" />
          <span className="terminal-tab-name">{tab.title}</span>
          <button className="terminal-tab-close" onClick={event => { event.stopPropagation(); closeClaudeReplayTab(tab.sessionId, tab.provider); }}
            title="关闭" aria-label={`关闭 ${tab.title}`}><X aria-hidden="true" /></button>
        </div>
      ))}
      {contextMenu && (
        <>
          <div className="context-menu-overlay" onClick={() => setContextMenu(null)} />
          <div className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
            <div className="context-menu-item" onClick={() => {
              const session = sessions.find(s => s.id === contextMenu.sessionId);
              if (session) {
                // 编辑所见即所得：输入框初始值取标签当前显示的标题（含摘要）
                const displayed = terminalTabTitle(session.profileName, useTaskSummaryStore.getState().summaries[session.id], session.manualTitle);
                setRenameValue(displayed);
                renameBaselineRef.current = displayed;
                setRenamingSessionId(session.id);
                setTimeout(() => renameInputRef.current?.select(), 0);
              }
              setContextMenu(null);
            }}>重命名</div>
            <div
              className={`context-menu-item ${sessionIdx(contextMenu.sessionId) <= 0 ? 'disabled' : ''}`}
              onClick={() => {
                if (sessionIdx(contextMenu.sessionId) > 0) {
                  closeLeft(contextMenu.sessionId);
                }
                setContextMenu(null);
              }}
            >关闭左侧</div>
            <div
              className={`context-menu-item ${sessionIdx(contextMenu.sessionId) >= sessions.length - 1 ? 'disabled' : ''}`}
              onClick={() => {
                if (sessionIdx(contextMenu.sessionId) < sessions.length - 1) {
                  closeRight(contextMenu.sessionId);
                }
                setContextMenu(null);
              }}
            >关闭右侧</div>
            <div
              className={`context-menu-item ${sessions.length <= 1 ? 'disabled' : ''}`}
              onClick={() => {
                if (sessions.length > 1) {
                  closeOthers(contextMenu.sessionId);
                }
                setContextMenu(null);
              }}
            >关闭其他</div>
            <div className="context-menu-item" onClick={() => {
              setContextMenu(null);
              const s = getAppSettings();
              saveAppSettings({ ...s, enableTabNavigation: true });
              saveEnableTabNavigation(true).catch(console.error);
              window.dispatchEvent(new CustomEvent('tab-navigation-changed'));
            }}>切换为纵向会话标签</div>
            <div className="context-menu-separator" />
            <div className="context-menu-item danger" onClick={() => {
              handleCloseTerminal(contextMenu.sessionId);
              setContextMenu(null);
            }}>关闭</div>
          </div>
        </>
      )}
      {agentTabMenu && (() => {
        const tab = agentTabs.find(item => item.key === agentTabMenu.key && item.shape === 'native');
        if (!tab || tab.shape !== 'native') return null;
        return (
          <AgentTabContextMenu
            x={agentTabMenu.x}
            y={agentTabMenu.y}
            tab={tab}
            onClose={() => setAgentTabMenu(null)}
          />
        );
      })()}
      {confirmDialog && (
        <ConfirmDialog
          title={confirmDialog.title}
          message={confirmDialog.message}
          onClose={() => setConfirmDialog(null)}
          onConfirm={confirmDialog.onConfirm}
        />
      )}
      {draftCloseDialog && (
        <Dialog
          title="草稿有未保存的内容"
          role="alertdialog"
          className="tb-confirm-dialog"
          onClose={() => setDraftCloseDialog(null)}
          footer={(
            <>
              <button className="btn-secondary" onClick={() => setDraftCloseDialog(null)}>取消</button>
              <button className="btn-danger" onClick={handleDraftDiscard}>不保存</button>
              <button className="btn-primary" onClick={handleDraftSaveAs}>另存为...</button>
            </>
          )}
        >
          <div className="tb-confirm-message">是否保存此草稿？</div>
        </Dialog>
      )}
    </div>
  );
};
