import { getCurrentWindow } from '@tauri-apps/api/window';
import { useAppStore } from '../stores/appStore';
import { getAppSettings } from '../utils/settings';
import {
  getBotSettings,
  onClaudeHookCompleted,
  onClaudeHookDecision,
  onClaudeHookDecisionExpired,
  onClaudeHookDecisionResolved,
  onClaudeNotificationActivated,
  sendBotNotification,
  sendClaudeHookDecisionNotification,
  showClaudeCodeNotification as showNativeNotification,
} from './tauri';

const pendingCompletionNotifications = new Map<string, ReturnType<typeof setTimeout>>();
const pendingDecisionNotifications = new Map<string, ReturnType<typeof setTimeout>>();
let botPreferences = {
  enabled: false,
  sendCompletionNotifications: false,
};

async function focusTerminal(terminalId: string): Promise<void> {
  const store = useAppStore.getState();
  if (!store.sessions.some(session => session.id === terminalId)) return;

  if (store.splitMode !== 'off' && !store.splitSlots.some(slot => slot.sessionId === terminalId)) {
    store.placeSessionInSplitSlot(terminalId);
  } else {
    store.setActiveSession(terminalId);
  }

  const appWindow = getCurrentWindow();
  await appWindow.unminimize().catch(() => {});
  await appWindow.show().catch(() => {});
  await appWindow.setFocus().catch(() => {});
}

async function terminalIsBeingViewed(terminalId: string): Promise<boolean> {
  const focused = await getCurrentWindow().isFocused().catch(() => false);
  return focused && useAppStore.getState().activeSessionId === terminalId;
}

async function showDecisionNotifications(terminalId: string, decisionId: string): Promise<void> {
  const isBeingViewed = await terminalIsBeingViewed(terminalId);
  const nativeEnabled = getAppSettings().claudeDecisionNotifications;
  const session = useAppStore.getState().sessions.find(item => item.id === terminalId);
  if (!session) return;
  const nativePromise = nativeEnabled && !isBeingViewed
    ? showNativeNotification(terminalId, session.profileName, 'question')
        .catch(error => console.error('发送 Claude Code 决策通知失败:', error))
    : Promise.resolve();
  const botPromise = sendClaudeHookDecisionNotification(decisionId)
    .catch(error => console.error('发送 Claude Code 机器人决策通知失败:', error));
  await Promise.all([nativePromise, botPromise]);
}

function scheduleDecisionNotification(terminalId: string, decisionId: string): void {
  const existing = pendingDecisionNotifications.get(decisionId);
  if (existing) clearTimeout(existing);
  const delayMs = Math.max(0, getAppSettings().claudeDecisionNotificationDelaySeconds) * 1_000;
  const timer = setTimeout(() => {
    pendingDecisionNotifications.delete(decisionId);
    void showDecisionNotifications(terminalId, decisionId);
  }, delayMs);
  pendingDecisionNotifications.set(decisionId, timer);
}

function cancelDecisionNotification(decisionId: string): void {
  const pending = pendingDecisionNotifications.get(decisionId);
  if (pending) clearTimeout(pending);
  pendingDecisionNotifications.delete(decisionId);
}

async function showCompletionNotification(terminalId: string): Promise<void> {
  const settings = getAppSettings();
  const nativeEnabled = settings.claudeCompletionNotifications;
  const botEnabled = botPreferences.enabled && botPreferences.sendCompletionNotifications;
  if ((!nativeEnabled && !botEnabled) || await terminalIsBeingViewed(terminalId)) return;

  const session = useAppStore.getState().sessions.find(item => item.id === terminalId);
  if (!session) return;
  const nativePromise = nativeEnabled
    ? showNativeNotification(terminalId, session.profileName, 'completed')
        .catch(error => console.error('发送 Claude Code 完成通知失败:', error))
    : Promise.resolve();
  const botPromise = botEnabled
    ? sendBotNotification({
        eventId: crypto.randomUUID(),
        terminalId,
        terminalName: session.profileName,
        kind: 'completed',
        title: 'Claude Code 任务已完成',
        summary: 'Claude Code 已完成当前任务。',
      }).then(reports => {
        reports.filter(report => !report.success).forEach(report => {
          console.error(`机器人通道「${report.channelName}」通知失败:`, report.error);
        });
      }).catch(error => console.error('发送 Claude Code 机器人通知失败:', error))
    : Promise.resolve();
  await Promise.all([nativePromise, botPromise]);
}

function scheduleCompletionNotification(terminalId: string): void {
  cancelPendingClaudeCompletion(terminalId);
  const delayMs = Math.max(0, getAppSettings().claudeCompletionNotificationDelaySeconds) * 1_000;
  const timer = setTimeout(() => {
    pendingCompletionNotifications.delete(terminalId);
    void showCompletionNotification(terminalId);
  }, delayMs);
  pendingCompletionNotifications.set(terminalId, timer);
}

export function cancelPendingClaudeCompletion(terminalId: string): void {
  const pending = pendingCompletionNotifications.get(terminalId);
  if (pending) clearTimeout(pending);
  pendingCompletionNotifications.delete(terminalId);
}

export async function initializeClaudeNotificationActions(): Promise<() => void> {
  const refreshBotPreferences = async () => {
    const settings = await getBotSettings().catch(() => null);
    if (!settings) return;
    botPreferences = {
      enabled: settings.enabled,
      sendCompletionNotifications: settings.sendCompletionNotifications,
    };
  };
  await refreshBotPreferences();
  const handleBotSettingsChanged = () => { void refreshBotPreferences(); };
  window.addEventListener('bot-settings-changed', handleBotSettingsChanged);

  const [
    unlistenActivated,
    unlistenHookDecision,
    unlistenHookDecisionExpired,
    unlistenHookDecisionResolved,
    unlistenHookCompleted,
  ] = await Promise.all([
    onClaudeNotificationActivated(terminalId => void focusTerminal(terminalId)),
    onClaudeHookDecision(payload => {
      cancelPendingClaudeCompletion(payload.terminalId);
      useAppStore.getState().setSessionWorking(payload.terminalId, false);
      scheduleDecisionNotification(payload.terminalId, payload.decisionId);
    }),
    onClaudeHookDecisionExpired(cancelDecisionNotification),
    onClaudeHookDecisionResolved(cancelDecisionNotification),
    onClaudeHookCompleted(({ terminalId }) => {
      useAppStore.getState().setSessionWorking(terminalId, false);
      scheduleCompletionNotification(terminalId);
    }),
  ]);

  return () => {
    window.removeEventListener('bot-settings-changed', handleBotSettingsChanged);
    unlistenActivated();
    unlistenHookDecision();
    unlistenHookDecisionExpired();
    unlistenHookDecisionResolved();
    unlistenHookCompleted();
    for (const timer of pendingCompletionNotifications.values()) clearTimeout(timer);
    pendingCompletionNotifications.clear();
    for (const timer of pendingDecisionNotifications.values()) clearTimeout(timer);
    pendingDecisionNotifications.clear();
  };
}
