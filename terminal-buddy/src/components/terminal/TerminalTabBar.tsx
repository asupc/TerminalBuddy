import { terminalTabTitle, useTaskSummaryStore } from '../../stores/taskSummaryStore';
import { FC, useState, useEffect, useCallback, useRef } from 'react';
import { FileText, GitBranch, History, SquareTerminal, X } from 'lucide-react';
import { isTerminalWorking, useAppStore, sessionReplayTabKey, relayAgentTabKey } from '../../stores/appStore';
import { closeTerminal as closeTerminalCmd, saveEnableTabNavigation, terminalAgentList, type TerminalAgentSession } from '../../services/tauri';
import { getAppSettings, saveAppSettings } from '../../utils/settings';
import { getIndicatorLight, getIndicatorColor, getIndicatorTitle, getIndicatorClassName } from '../../utils/claudeIndicator';
import { AgentIcon } from '../agent-chat/AgentIcon';import { parseClaudeRef } from '../../utils/claudeLaunch';
import { parseCodexRef } from '../../utils/codexLaunch';
import { isDockerClient } from '../../services/platform';
import { ConfirmDialog } from '../shared/Dialog';
import './TerminalTabBar.css';

export const TerminalTabBar: FC = () => {
  const sessions = useAppStore(s => s.sessions);
  const taskSummaries = useTaskSummaryStore(s => s.summaries);
  const activeSessionId = useAppStore(s => s.activeSessionId);
  const removeSession = useAppStore(s => s.removeSession);
  const removeSessions = useAppStore(s => s.removeSessions);

  const renameSession = useAppStore(s => s.renameSession);
  const terminalActivities = useAppStore(s => s.terminalActivities);
  const terminalWebTakeovers = useAppStore(s => s.terminalWebTakeovers);
  const settingsVersion = useAppStore(s => s.settingsVersion);
  const gitHistoryTab = useAppStore(s => s.gitHistoryTab);
  const openGitHistoryTab = useAppStore(s => s.openGitHistoryTab);
  const closeGitHistoryTab = useAppStore(s => s.closeGitHistoryTab);
  const claudeReplayTab = useAppStore(s => s.claudeReplayTab);
  const claudeReplayTabs = useAppStore(s => s.claudeReplayTabs);
  const openClaudeReplayTab = useAppStore(s => s.openClaudeReplayTab);
  const closeClaudeReplayTab = useAppStore(s => s.closeClaudeReplayTab);
  const activeSpecialTab = useAppStore(s => s.activeSpecialTab);
  const agentTabs = useAppStore(s => s.agentTabs);
  const activeAgentTabKey = useAppStore(s => s.activeAgentTabKey);
  const closeAgentTab = useAppStore(s => s.closeAgentTab);
  const setActiveAgentTab = useAppStore(s => s.setActiveAgentTab);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; sessionId: string } | null>(null);
  // 终端里可接力的 Agent 会话（右键打开菜单时刷新）。
  const [agentSessions, setAgentSessions] = useState<Record<string, TerminalAgentSession>>({});
  const openAgentChat = (terminalId: string) => {
    const info = agentSessions[terminalId];
    if (!info) return;
    const store = useAppStore.getState();
    const key = relayAgentTabKey(terminalId);
    store.openAgentTab({
      key,
      shape: 'relay',
      terminalId,
      title: info.title || info.profileName || 'Agent 会话',
      provider: info.provider === 'codex' ? 'codex' : 'claude',
      openedAt: Date.now(),
    });
    store.setActiveAgentTab(key);
  };
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  // 打开重命名时的初始值：未改动就不落库，避免把摘要原样固化成名称
  const [renameBaseline, setRenameBaseline] = useState('');
  const [confirmDialog, setConfirmDialog] = useState<{ title: string; message: string; onConfirm: () => void } | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const tabBarRef = useRef<HTMLDivElement>(null);
  const visibleSessions = sessions;

  const handleCloseTerminal = useCallback(async (sessionId: string) => {
    const session = sessions.find(s => s.id === sessionId);
    if (session?.sessionType === 'editor') {
      if (session.isDirty) {
        setConfirmDialog({
          title: '未保存的更改',
          message: `文件「${session.profileName}」有未保存的更改，确定要关闭吗？`,
          onConfirm: () => {
            setConfirmDialog(null);
            removeSession(sessionId);
          },
        });
        return;
      }
      removeSession(sessionId);
    } else if (session?.starting) {
      removeSession(sessionId);
    } else if (session) {
      // 活跃终端（正在执行任务）关闭前弹窗确认
      if (isTerminalWorking(terminalActivities[sessionId])) {
        setConfirmDialog({
          title: '终端正在执行任务',
          message: `终端「${session.profileName}」正在执行任务，确定要关闭吗？`,
          onConfirm: () => {
            setConfirmDialog(null);
            removeSession(sessionId);
            void closeTerminalCmd(sessionId).catch(err => console.error(err));
          },
        });
        return;
      }
      removeSession(sessionId);
      void closeTerminalCmd(sessionId).catch(err => console.error(err));
    }
  }, [sessions, removeSession, terminalActivities]);

  const closeOthers = useCallback((sessionId: string) => {
    const sessionsToClose = sessions.filter(session => session.id !== sessionId);
    const workingCount = sessionsToClose.filter(
      s => s.sessionType !== 'editor' && !s.starting && isTerminalWorking(terminalActivities[s.id])
    ).length;
    const performClose = () => {
      removeSessions(sessionsToClose.map(session => session.id));
      void Promise.all(
        sessionsToClose
          .filter(session => session.sessionType !== 'editor' && !session.starting)
          .map(session => closeTerminalCmd(session.id).catch(() => {}))
      );
    };
    if (workingCount > 0) {
      setConfirmDialog({
        title: '关闭其他',
        message: `其他 ${sessionsToClose.length} 个选项卡中有 ${workingCount} 个终端正在执行任务，确定要关闭吗？`,
        onConfirm: () => {
          setConfirmDialog(null);
          performClose();
        },
      });
      return;
    }
    performClose();
  }, [sessions, removeSessions, terminalActivities]);

  const closeLeft = useCallback((sessionId: string) => {
    const idx = sessions.findIndex(s => s.id === sessionId);
    const sessionsToClose = idx < 0 ? [] : sessions.slice(0, idx);
    if (sessionsToClose.length === 0) return;
    const workingCount = sessionsToClose.filter(
      s => s.sessionType !== 'editor' && !s.starting && isTerminalWorking(terminalActivities[s.id])
    ).length;
    const performClose = () => {
      removeSessions(sessionsToClose.map(session => session.id));
      void Promise.all(
        sessionsToClose
          .filter(session => session.sessionType !== 'editor' && !session.starting)
          .map(session => closeTerminalCmd(session.id).catch(() => {}))
      );
    };
    if (workingCount > 0) {
      setConfirmDialog({
        title: '关闭左侧',
        message: `左侧 ${sessionsToClose.length} 个选项卡中有 ${workingCount} 个终端正在执行任务，确定要关闭吗？`,
        onConfirm: () => {
          setConfirmDialog(null);
          performClose();
        },
      });
      return;
    }
    performClose();
  }, [sessions, removeSessions, terminalActivities]);

  const closeRight = useCallback((sessionId: string) => {
    const idx = sessions.findIndex(s => s.id === sessionId);
    const sessionsToClose = idx < 0 ? [] : sessions.slice(idx + 1);
    if (sessionsToClose.length === 0) return;
    const workingCount = sessionsToClose.filter(
      s => s.sessionType !== 'editor' && !s.starting && isTerminalWorking(terminalActivities[s.id])
    ).length;
    const performClose = () => {
      removeSessions(sessionsToClose.map(session => session.id));
      void Promise.all(
        sessionsToClose
          .filter(session => session.sessionType !== 'editor' && !session.starting)
          .map(session => closeTerminalCmd(session.id).catch(() => {}))
      );
    };
    if (workingCount > 0) {
      setConfirmDialog({
        title: '关闭右侧',
        message: `右侧 ${sessionsToClose.length} 个选项卡中有 ${workingCount} 个终端正在执行任务，确定要关闭吗？`,
        onConfirm: () => {
          setConfirmDialog(null);
          performClose();
        },
      });
      return;
    }
    performClose();
  }, [sessions, removeSessions, terminalActivities]);

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
      const region = useAppStore.getState().lastClickRegion;
      if (region && region !== 'tab') return;
      if (!activeSessionId) return;
      const session = sessions.find(s => s.id === activeSessionId);
      if (session) {
        // 编辑所见即所得：输入框初始值取标签当前显示的标题（含摘要）
        const displayed = terminalTabTitle(session.profileName, useTaskSummaryStore.getState().summaries[session.id], session.manualTitle);
        setRenameValue(displayed);
        setRenameBaseline(displayed);
        setRenamingSessionId(activeSessionId);
        setTimeout(() => renameInputRef.current?.select(), 0);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [activeSessionId, sessions]);

  // 跟踪上次点击区域
  useEffect(() => {
    const el = tabBarRef.current;
    if (!el) return;
    const handler = () => {
      useAppStore.getState().setLastClickRegion('tab');
    };
    el.addEventListener('mousedown', handler);
    return () => el.removeEventListener('mousedown', handler);
  }, []);

  // F2 重命名时自动聚焦输入框
  useEffect(() => {
    if (renamingSessionId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingSessionId]);

  const sessionIdx = (id: string) => sessions.findIndex(s => s.id === id);

  return (
    <div className="terminal-tab-bar" key={settingsVersion} ref={tabBarRef}>
      {visibleSessions.map((session) => (
        <div
          key={session.id}
          className={`terminal-tab ${activeSpecialTab === null && activeSessionId === session.id ? 'active' : ''}`}
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
              handleCloseTerminal(session.id);
            }
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            setContextMenu({ x: e.clientX, y: e.clientY, sessionId: session.id });
            void terminalAgentList()
              .then(list => setAgentSessions(Object.fromEntries(list.map(item => [item.terminalId, item]))))
              .catch(() => {});
          }}
        >
          {session.sessionType === 'editor' ? (
            <FileText className="tab-file-icon" aria-hidden="true" />
          ) : (() => {
            const light = getIndicatorLight(terminalActivities[session.id]);
            return (
              <span
                className={`terminal-tab-dot${getIndicatorClassName(light)}`}
                style={{ background: getIndicatorColor(light, session.tabColor) }}
                title={getIndicatorTitle(light, terminalActivities[session.id]?.provider) || undefined}
                onClick={(e) => {
                  if (light !== 'failed' && light !== 'attention') return;
                  e.stopPropagation();
                  if (light === 'failed') useAppStore.getState().clearClaudeFailure(session.id);
                }}
              />
            );
          })()}
          {session.isDirty && <span className="tab-dirty-dot" />}
          {renamingSessionId === session.id ? (
            <input
              ref={renameInputRef}
              className="tab-bar-rename-input"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onBlur={() => {
                const trimmed = renameValue.trim();
                if (trimmed && trimmed !== renameBaseline) {
                  renameSession(session.id, trimmed);
                }
                setRenamingSessionId(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const trimmed = renameValue.trim();
                  if (trimmed && trimmed !== renameBaseline) {
                    renameSession(session.id, trimmed);
                  }
                  setRenamingSessionId(null);
                } else if (e.key === 'Escape') {
                  setRenamingSessionId(null);
                }
              }}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <>
              {session.extraParamTag && session.sessionType !== 'editor' && (
                <span
                  className="terminal-tab-tag-chip"
                  style={session.extraParamTagColor ? { backgroundColor: session.extraParamTagColor } : undefined}
                  title="启动参数预设"
                >
                  {session.extraParamTag}
                </span>
              )}
              {session.sessionType !== 'editor' && (() => {
                const params = session.extraParams ?? '';
                const modelRef = parseCodexRef(params) ?? parseClaudeRef(params);
                return modelRef ? (
                  <span className="terminal-tab-model-chip" title="供应商模型">{modelRef.modelId}</span>
                ) : null;
              })()}
              <span className="terminal-tab-name" title={terminalTabTitle(session.profileName, taskSummaries[session.id], session.manualTitle)} style={session.tabColor ? { color: session.tabColor } : undefined}>{terminalTabTitle(session.profileName, taskSummaries[session.id], session.manualTitle)}</span>
              {/* Docker 端所有会话都来自网页端，Web 标签没有区分度，故隐藏 */}
              {session.owner === 'web' && !isDockerClient() && <span className="terminal-owner-badge">Web</span>}
              {session.owner !== 'web' && terminalWebTakeovers[session.id] && (
                <span className="terminal-takeover-badge" title="当前终端正在被 Web 端接管">接管中</span>
              )}
            </>
          )}
          <button
            className="terminal-tab-close"
            onClick={(e) => {
              e.stopPropagation();
              handleCloseTerminal(session.id);
            }}
            title="关闭"
            aria-label={`关闭 ${session.profileName}`}
          ><X aria-hidden="true" /></button>
        </div>
      ))}
      {agentTabs.map(tab => (
        <div
          key={tab.key}
          className={`terminal-tab ${activeSpecialTab === 'agent-chat' && activeAgentTabKey === tab.key ? 'active' : ''}`}
          onClick={() => setActiveAgentTab(tab.key)}
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
          {tab.shape === 'native'
            ? <AgentIcon provider={tab.provider} className="terminal-tab-history-icon" />
            : <SquareTerminal className="terminal-tab-history-icon" aria-hidden="true" />}
          <span className="terminal-tab-agent-badge">
            {tab.shape === 'native' ? (tab.provider === 'codex' ? 'CODEX' : 'CLAUDE') : 'AGENT'}
          </span>
          <span className="terminal-tab-name">{tab.title}</span>
          <button className="terminal-tab-close" onClick={event => { event.stopPropagation(); closeAgentTab(tab.key); }}
            title="关闭" aria-label={`关闭 ${tab.title}`}><X aria-hidden="true" /></button>
        </div>
      ))}
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
          title={`${tab.provider === 'codex' ? 'Codex' : 'Claude Code'} · ${tab.title}`}>
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
                const displayed = terminalTabTitle(session.profileName, taskSummaries[session.id], session.manualTitle);
                setRenameValue(displayed);
                setRenameBaseline(displayed);
                setRenamingSessionId(session.id);
                setTimeout(() => renameInputRef.current?.select(), 0);
              }
              setContextMenu(null);
            }}>重命名</div>
            {agentSessions[contextMenu.sessionId] && (
              <div className="context-menu-item" onClick={() => {
                openAgentChat(contextMenu.sessionId);
                setContextMenu(null);
              }}>查看 Agent 对话</div>
            )}
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
      {confirmDialog && (
        <ConfirmDialog
          title={confirmDialog.title}
          message={confirmDialog.message}
          onClose={() => setConfirmDialog(null)}
          onConfirm={confirmDialog.onConfirm}
        />
      )}
    </div>
  );
};
