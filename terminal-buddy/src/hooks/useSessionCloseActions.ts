import { useCallback, useEffect, useState } from 'react';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { closeTerminal as closeTerminalCmd, readFileContent, writeFileContent } from '../services/tauri';
import { isTerminalWorking, useAppStore } from '../stores/appStore';
import type { TerminalSession } from '../types';

export interface SessionConfirmDialogState {
  title: string;
  message: string;
  onConfirm: () => void;
}

export interface DraftCloseDialogState {
  sessionId: string;
  filePath: string;
}

export function isDraftEditorPath(profileId: string): boolean {
  return profileId.includes('\\drafts\\draft_') || profileId.includes('/drafts/draft_');
}

export function cleanupDraftFiles(targets: TerminalSession[]): void {
  const store = useAppStore.getState();
  for (const session of targets) {
    if (session.sessionType === 'editor' && isDraftEditorPath(session.profileId)) {
      void store.removeDraftFile(session.profileId);
    }
  }
}

/**
 * 会话关闭、分组批量关闭与草稿保存确认逻辑。
 * 与 TabNav 保持完全一致的关闭前确认与后端 PTY 清理语义。
 */
export function useSessionCloseActions() {
  const sessions = useAppStore(s => s.sessions);
  const agentTabs = useAppStore(s => s.agentTabs);
  const terminalActivities = useAppStore(s => s.terminalActivities);
  const removeSession = useAppStore(s => s.removeSession);
  const removeSessions = useAppStore(s => s.removeSessions);
  const closeAgentTab = useAppStore(s => s.closeAgentTab);

  const [confirmDialog, setConfirmDialog] = useState<SessionConfirmDialogState | null>(null);
  const [draftCloseDialog, setDraftCloseDialog] = useState<DraftCloseDialogState | null>(null);

  useEffect(() => {
    if (sessions.length === 0) {
      setConfirmDialog(null);
      setDraftCloseDialog(null);
    }
  }, [sessions.length]);

  const closeSessionsWithBackend = useCallback(async (targets: TerminalSession[]) => {
    const terminalIds = targets
      .filter(session => session.sessionType !== 'editor' && !session.starting)
      .map(session => session.id);
    cleanupDraftFiles(targets);
    removeSessions(targets.map(session => session.id));
    void Promise.all(terminalIds.map(id => closeTerminalCmd(id).catch(err => console.error(err))));
  }, [removeSessions]);

  const handleCloseTerminal = useCallback(async (sessionId: string) => {
    const session = sessions.find(s => s.id === sessionId);
    if (session?.sessionType === 'editor') {
      if (isDraftEditorPath(session.profileId)) {
        try {
          const content = await readFileContent(session.profileId);
          if (content) {
            setDraftCloseDialog({ sessionId, filePath: session.profileId });
            return;
          }
        } catch {}
        await useAppStore.getState().removeDraftFile(session.profileId);
        removeSession(sessionId);
        return;
      }
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
  }, [sessions, terminalActivities, removeSession]);

  const handleDraftSaveAs = useCallback(async () => {
    if (!draftCloseDialog) return;
    const session = sessions.find(s => s.id === draftCloseDialog.sessionId);
    if (!session) {
      setDraftCloseDialog(null);
      return;
    }
    try {
      const content = await readFileContent(draftCloseDialog.filePath);
      const savedPath = await saveDialog({
        defaultPath: session.profileName + '.txt',
        filters: [{ name: '文本文件', extensions: ['txt'] }, { name: '所有文件', extensions: ['*'] }],
      });
      if (savedPath) {
        await writeFileContent(savedPath, content);
        await useAppStore.getState().removeDraftFile(draftCloseDialog.filePath);
        removeSession(draftCloseDialog.sessionId);
        setDraftCloseDialog(null);
      }
    } catch (err) {
      console.error('Save as failed:', err);
      setDraftCloseDialog(null);
    }
  }, [draftCloseDialog, sessions, removeSession]);

  const handleDraftDiscard = useCallback(async () => {
    if (!draftCloseDialog) return;
    await useAppStore.getState().removeDraftFile(draftCloseDialog.filePath);
    removeSession(draftCloseDialog.sessionId);
    setDraftCloseDialog(null);
  }, [draftCloseDialog, removeSession]);

  const handleCloseGroup = useCallback((groupName: string, groupSessions: TerminalSession[], groupAgentKeys: string[] = []) => {
    const total = groupSessions.length + groupAgentKeys.length;
    if (total === 0) return;
    const workingCount = groupSessions.filter(
      s => s.sessionType !== 'editor' && !s.starting && isTerminalWorking(terminalActivities[s.id]),
    ).length;
    setConfirmDialog({
      title: '确认关闭分组',
      message: workingCount > 0
        ? `分组「${groupName}」中有 ${workingCount} 个终端正在执行任务，确定要关闭全部 ${total} 个标签吗？`
        : `确定要关闭分组「${groupName}」中的所有 ${total} 个标签吗？`,
      onConfirm: async () => {
        setConfirmDialog(null);
        for (const key of groupAgentKeys) closeAgentTab(key);
        await closeSessionsWithBackend(groupSessions);
      },
    });
  }, [terminalActivities, closeAgentTab, closeSessionsWithBackend]);

  const handleCloseAllTabs = useCallback((onAfterClose?: () => void) => {
    const nativeTabs = agentTabs.filter(tab => tab.shape === 'native');
    const total = sessions.length + nativeTabs.length;
    if (total === 0) return;
    const hasDirty = sessions.some(s => s.sessionType === 'editor' && s.isDirty);
    const workingCount = sessions.filter(
      s => s.sessionType !== 'editor' && !s.starting && isTerminalWorking(terminalActivities[s.id]),
    ).length;
    let message: string;
    if (workingCount > 0 && hasDirty) {
      message = `有未保存的文件更改，且 ${workingCount} 个终端正在执行任务，确定关闭所有 ${total} 个选项卡吗？`;
    } else if (workingCount > 0) {
      message = `有 ${workingCount} 个终端正在执行任务，确定关闭所有 ${total} 个选项卡吗？`;
    } else if (hasDirty) {
      message = `有未保存的文件更改，确定关闭所有 ${total} 个选项卡吗？`;
    } else {
      message = `确定关闭所有 ${total} 个选项卡吗？`;
    }
    setConfirmDialog({
      title: '确认关闭所有选项卡',
      message,
      onConfirm: async () => {
        setConfirmDialog(null);
        for (const tab of nativeTabs) closeAgentTab(tab.key);
        await closeSessionsWithBackend(sessions);
        onAfterClose?.();
      },
    });
  }, [sessions, agentTabs, terminalActivities, closeAgentTab, closeSessionsWithBackend]);

  return {
    confirmDialog,
    setConfirmDialog,
    draftCloseDialog,
    setDraftCloseDialog,
    handleCloseTerminal,
    handleDraftSaveAs,
    handleDraftDiscard,
    handleCloseGroup,
    handleCloseAllTabs,
    closeSessionsWithBackend,
  };
}
