import { getCurrentWindow } from '@tauri-apps/api/window';
import { useAppStore } from '../stores/appStore';
import { getAppSettings } from '../utils/settings';
import {
  getBotSettings,
  getPendingClaudeHookDecisions,
  onClaudeHookDecision,
  onClaudeHookDecisionExpired,
  onClaudeHookDecisionResolved,
  onClaudeHookTerminalEvent,
  onClaudeNotificationActivated,
  sendBotNotification,
  sendClaudeHookDecisionNotification,
  showClaudeCodeNotification as showNativeNotification,
  type ClaudeHookDecisionEvent,
  type ClaudeHookTerminalEvent,
} from './tauri';

type NotificationGuard = () => boolean;

interface PendingNotification {
  timer: ReturnType<typeof setTimeout>;
  token: number;
}

interface CompletionNotificationDetails {
  eventId: string;
  terminalId: string;
  phase: 'completed' | 'failed';
  taskTitle?: string;
  summary?: string;
}

const pendingCompletionNotifications = new Map<string, PendingNotification>();
const pendingAttentionNotifications = new Map<
  string,
  PendingNotification & { terminalId: string }
>();
const claudeActivityExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
let notificationToken = 0;
let activeNotificationRuntimeToken = 0;
const CLAUDE_RUNNING_STALE_MS = 30 * 60 * 1_000;

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

async function appIsInForeground(): Promise<boolean> {
  const appWindow = getCurrentWindow();
  const [focused, minimized, visible] = await Promise.all([
    appWindow.isFocused().catch(() => false),
    appWindow.isMinimized().catch(() => true),
    appWindow.isVisible().catch(() => false),
  ]);
  return focused && visible && !minimized;
}

function terminalIsBeingViewed(terminalId: string, appInForeground: boolean): boolean {
  if (!appInForeground) return false;
  const store = useAppStore.getState();
  if (store.activeSpecialTab !== null) return false;
  return store.activeSessionId === terminalId
    || (store.splitMode !== 'off' && store.splitSlots.some(slot => slot.sessionId === terminalId));
}

function terminalName(terminalId: string): string | null {
  return useAppStore.getState().sessions.find(item => item.id === terminalId)?.profileName ?? null;
}

async function showStructuredDecisionNotification(decision: ClaudeHookDecisionEvent, isCurrent: NotificationGuard): Promise<void> {
  const name = terminalName(decision.terminalId);
  if (!name) return;
  const appInForeground = await appIsInForeground();
  if (!isCurrent()) return;
  const nativePromise = getAppSettings().claudeDecisionNotifications && !appInForeground
    ? showNativeNotification(decision.terminalId, name, 'question')
        .catch(error => console.error('发送 Claude Code 决策通知失败:', error))
    : Promise.resolve();
  const botPromise = sendClaudeHookDecisionNotification(decision.decisionId)
    .catch(error => console.error('发送 Claude Code 机器人决策通知失败:', error));
  await Promise.all([nativePromise, botPromise]);
}

async function showAttentionNotification(event: ClaudeHookTerminalEvent, isCurrent: NotificationGuard): Promise<void> {
  const settings = getAppSettings();
  const nativeEnabled = settings.claudeDecisionNotifications;
  if (!nativeEnabled) return;

  const name = terminalName(event.terminalId);
  if (!name) return;
  const appInForeground = await appIsInForeground();
  if (!isCurrent()) return;
  const isPermission = event.notificationType === 'permission_prompt';
  if (!appInForeground) {
    await showNativeNotification(event.terminalId, name, isPermission ? 'confirmation' : 'question')
      .catch(error => console.error('发送 Claude Code 待处理通知失败:', error));
  }
}

async function showCompletionNotification(
  details: CompletionNotificationDetails,
  isCurrent: NotificationGuard,
): Promise<void> {
  const { terminalId, phase } = details;
  const settings = getAppSettings();
  const nativeEnabled = settings.claudeCompletionNotifications;
  const botSettings = await getBotSettings().catch(() => null);
  const botEnabled = Boolean(botSettings?.enabled && botSettings.sendCompletionNotifications);
  if (!nativeEnabled && !botEnabled) return;
  const appInForeground = await appIsInForeground();
  if (!isCurrent()) return;

  const name = terminalName(terminalId);
  if (!name) return;
  const isBeingViewed = terminalIsBeingViewed(terminalId, appInForeground);
  const failed = phase === 'failed';
  const taskTitle = details.taskTitle?.trim();
  const title = taskTitle
    ? `${failed ? '任务失败' : '任务完成'}：${taskTitle}`
    : failed ? 'Claude Code 任务执行失败' : 'Claude Code 任务已完成';
  const summary = details.summary?.trim()
    || (failed ? 'Claude Code 未能完成当前任务。' : 'Claude Code 已完成当前任务。');
  const nativePromise = nativeEnabled && !appInForeground
    ? showNativeNotification(terminalId, name, failed ? 'failed' : 'completed', title, summary)
        .catch(error => console.error('发送 Claude Code 任务结束通知失败:', error))
    : Promise.resolve();
  const botPromise = botEnabled && !isBeingViewed
    ? sendBotNotification({
        eventId: details.eventId,
        terminalId,
        terminalName: name,
        kind: 'completed',
        title,
        summary,
      }).then(reports => {
        reports.filter(report => !report.success).forEach(report => {
          console.error(`机器人通道「${report.channelName}」通知失败:`, report.error);
        });
      }).catch(error => console.error('发送 Claude Code 机器人任务结束通知失败:', error))
    : Promise.resolve();
  await Promise.all([nativePromise, botPromise]);
}

function scheduleAttention(
  key: string,
  terminalId: string,
  callback: (isCurrent: NotificationGuard) => Promise<void>,
): void {
  cancelAttention(key);
  const token = ++notificationToken;
  const delayMs = Math.max(0, getAppSettings().claudeDecisionNotificationDelaySeconds) * 1_000;
  const timer = setTimeout(() => {
    const isCurrent = () => pendingAttentionNotifications.get(key)?.token === token;
    void callback(isCurrent).finally(() => {
      if (isCurrent()) pendingAttentionNotifications.delete(key);
    });
  }, delayMs);
  pendingAttentionNotifications.set(key, { terminalId, timer, token });
}

function scheduleStructuredDecision(decision: ClaudeHookDecisionEvent): void {
  scheduleAttention(decision.decisionId, decision.terminalId, isCurrent => showStructuredDecisionNotification(decision, isCurrent));
}

function scheduleCompletion(details: CompletionNotificationDetails): void {
  cancelPendingClaudeCompletion(details.terminalId);
  const token = ++notificationToken;
  const delayMs = Math.max(0, getAppSettings().claudeCompletionNotificationDelaySeconds) * 1_000;
  const timer = setTimeout(() => {
    const isCurrent = () => pendingCompletionNotifications.get(details.terminalId)?.token === token;
    void showCompletionNotification(details, isCurrent).finally(() => {
      if (isCurrent()) pendingCompletionNotifications.delete(details.terminalId);
    });
  }, delayMs);
  pendingCompletionNotifications.set(details.terminalId, { timer, token });
}

function cancelAttention(key: string): void {
  const pending = pendingAttentionNotifications.get(key);
  if (pending) clearTimeout(pending.timer);
  pendingAttentionNotifications.delete(key);
}

function cancelAttentionForTerminal(terminalId: string): void {
  for (const [key, pending] of pendingAttentionNotifications) {
    if (pending.terminalId !== terminalId) continue;
    clearTimeout(pending.timer);
    pendingAttentionNotifications.delete(key);
  }
}

function cancelClaudeActivityExpiry(terminalId: string): void {
  const timer = claudeActivityExpiryTimers.get(terminalId);
  if (timer) clearTimeout(timer);
  claudeActivityExpiryTimers.delete(terminalId);
}

function scheduleClaudeActivityExpiry(terminalId: string, expectedUpdatedAt: number): void {
  cancelClaudeActivityExpiry(terminalId);
  const timer = setTimeout(() => {
    if (claudeActivityExpiryTimers.get(terminalId) !== timer) return;
    claudeActivityExpiryTimers.delete(terminalId);
    useAppStore.getState().expireClaudeHookActivity(terminalId, expectedUpdatedAt);
  }, CLAUDE_RUNNING_STALE_MS);
  claudeActivityExpiryTimers.set(terminalId, timer);
}

export function cancelPendingClaudeCompletion(terminalId: string): void {
  const pending = pendingCompletionNotifications.get(terminalId);
  if (pending) clearTimeout(pending.timer);
  pendingCompletionNotifications.delete(terminalId);
}

export function cancelPendingClaudeNotifications(terminalId: string): void {
  cancelPendingClaudeCompletion(terminalId);
  cancelAttentionForTerminal(terminalId);
  cancelClaudeActivityExpiry(terminalId);
}

export function handleClaudeTerminalInputActivity(terminalId: string): void {
  cancelPendingClaudeNotifications(terminalId);
  const store = useAppStore.getState();
  store.handleTerminalInputActivity(terminalId);
  const current = useAppStore.getState().terminalActivities[terminalId];
  if (current?.runtimeKind === 'claude' && current.phase === 'running') {
    scheduleClaudeActivityExpiry(terminalId, current.updatedAt);
  }
}

function applyTerminalEvent(event: ClaudeHookTerminalEvent): void {
  const store = useAppStore.getState();
  if (event.phase === 'ended') {
    if (!store.endClaudeHookSession(event.terminalId, event.occurredAt)) return;
    if (event.sessionId) store.setClaudeSessionId(event.terminalId, event.sessionId);
    cancelAttentionForTerminal(event.terminalId);
    cancelClaudeActivityExpiry(event.terminalId);
    return;
  }
  if (!store.applyClaudeHookActivity(event.terminalId, event.phase, event.occurredAt)) return;
  if (event.sessionId) store.setClaudeSessionId(event.terminalId, event.sessionId);
  if (event.phase === 'running') {
    cancelPendingClaudeCompletion(event.terminalId);
    cancelAttentionForTerminal(event.terminalId);
    scheduleClaudeActivityExpiry(event.terminalId, event.occurredAt);
  } else if (event.phase === 'attention') {
    cancelClaudeActivityExpiry(event.terminalId);
    cancelPendingClaudeCompletion(event.terminalId);
    if (event.eventName === 'Notification') {
      scheduleAttention(event.eventId, event.terminalId, isCurrent => showAttentionNotification(event, isCurrent));
    }
  } else if (event.phase === 'completed' || event.phase === 'failed') {
    cancelClaudeActivityExpiry(event.terminalId);
    cancelAttentionForTerminal(event.terminalId);
    scheduleCompletion({
      eventId: event.eventId,
      terminalId: event.terminalId,
      phase: event.phase,
      taskTitle: event.taskTitle,
      summary: event.summary,
    });
  }
}

export async function initializeClaudeNotificationActions(): Promise<() => void> {
  const runtimeToken = ++activeNotificationRuntimeToken;
  let disposed = false;
  const isActiveRuntime = () => !disposed && activeNotificationRuntimeToken === runtimeToken;
  const settledDecisionIds = new Set<string>();
  const listenerResults = await Promise.allSettled([
    onClaudeNotificationActivated(terminalId => {
      if (isActiveRuntime()) void focusTerminal(terminalId);
    }),
    onClaudeHookTerminalEvent(event => {
      if (isActiveRuntime()) applyTerminalEvent(event);
    }),
    onClaudeHookDecision(decision => {
      if (!isActiveRuntime()) return;
      const store = useAppStore.getState();
      if (!store.applyClaudeHookActivity(decision.terminalId, 'attention', decision.occurredAt)) return;
      cancelPendingClaudeCompletion(decision.terminalId);
      cancelClaudeActivityExpiry(decision.terminalId);
      scheduleStructuredDecision(decision);
    }),
    onClaudeHookDecisionExpired(payload => {
      if (!isActiveRuntime()) return;
      settledDecisionIds.add(payload.decisionId);
      cancelAttention(payload.decisionId);
    }),
    onClaudeHookDecisionResolved(payload => {
      if (!isActiveRuntime()) return;
      settledDecisionIds.add(payload.decisionId);
      cancelAttention(payload.decisionId);
      const phase = payload.resolution === 'continueInTerminal' ? 'attention' : 'running';
      if (!useAppStore.getState().applyClaudeHookActivity(
        payload.terminalId,
        phase,
        payload.occurredAt,
      )) return;
      if (payload.resolution !== 'continueInTerminal') {
        scheduleClaudeActivityExpiry(payload.terminalId, payload.occurredAt);
      } else {
        cancelClaudeActivityExpiry(payload.terminalId);
      }
    }),
  ]);

  const cleanups: Array<() => void> = [];
  let registrationFailed = false;
  let registrationError: unknown;
  for (const result of listenerResults) {
    if (result.status === 'fulfilled') cleanups.push(result.value);
    else {
      registrationFailed = true;
      if (registrationError === undefined) registrationError = result.reason;
    }
  }
  if (registrationFailed) {
    disposed = true;
    cleanups.forEach(cleanup => cleanup());
    if (activeNotificationRuntimeToken === runtimeToken) activeNotificationRuntimeToken++;
    throw registrationError ?? new Error('初始化 Claude 通知监听失败');
  }
  if (!isActiveRuntime()) {
    disposed = true;
    cleanups.forEach(cleanup => cleanup());
    return () => {};
  }

  void getPendingClaudeHookDecisions()
    .then(decisions => decisions.forEach(decision => {
      if (!isActiveRuntime()) return;
      if (settledDecisionIds.has(decision.decisionId)) return;
      if (!useAppStore.getState().applyClaudeHookActivity(
        decision.terminalId,
        'attention',
        decision.occurredAt,
      )) return;
      scheduleStructuredDecision(decision);
      cancelClaudeActivityExpiry(decision.terminalId);
    }))
    .catch(error => console.error('恢复 Claude Code 待处理决策失败:', error));

  return () => {
    if (disposed) return;
    disposed = true;
    cleanups.forEach(cleanup => cleanup());
    if (activeNotificationRuntimeToken !== runtimeToken) return;
    activeNotificationRuntimeToken++;
    for (const pending of pendingCompletionNotifications.values()) clearTimeout(pending.timer);
    pendingCompletionNotifications.clear();
    for (const pending of pendingAttentionNotifications.values()) clearTimeout(pending.timer);
    pendingAttentionNotifications.clear();
    for (const timer of claudeActivityExpiryTimers.values()) clearTimeout(timer);
    claudeActivityExpiryTimers.clear();
  };
}
