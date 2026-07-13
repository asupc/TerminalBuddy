import { getCurrentWindow } from '@tauri-apps/api/window';
import { useAppStore } from '../stores/appStore';
import { getAppSettings } from '../utils/settings';
import { onClaudeNotificationActivated, showClaudeCodeNotification as showNativeNotification } from './tauri';

const DETECTION_DELAY_MS = 300;
const DETECTION_BUFFER_SIZE = 12_000;
const NOTIFICATION_COOLDOWN_MS = 5_000;
const SPINNER_ACTIVITY_GRACE_MS = 1_200;

type DetectorState = {
  text: string;
  claudeSeen: boolean;
  promptActive: boolean;
  taskRunning: boolean;
  taskStartedAt: number;
  taskHadBusyMarker: boolean;
  taskPromptWasHidden: boolean;
  lastSpinnerAt: number;
  lastNotifiedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
};

const detectorStates = new Map<string, DetectorState>();
const pendingNotifications = new Map<string, ReturnType<typeof setTimeout>>();

type NotificationKind = 'confirmation' | 'question' | 'completed';

function createDetectorState(): DetectorState {
  return {
    text: '',
    claudeSeen: false,
    promptActive: false,
    taskRunning: false,
    taskStartedAt: 0,
    taskHadBusyMarker: false,
    taskPromptWasHidden: false,
    lastSpinnerAt: 0,
    lastNotifiedAt: 0,
    timer: null,
  };
}

const CLAUDE_MARKERS = [
  /Claude Code/i,
  /claude\.ai\/code/i,
  /esc to interrupt/i,
  /shift\+tab to cycle/i,
  /bypass permissions/i,
  /Claude needs your permission/i,
];

const CONFIRMATION_MARKERS = [
  /Do you want to [^\n?]{1,160}\?/i,
  /Would you like to (?:proceed|continue|allow|run|execute)/i,
  /Allow (?:this|Claude|tool|command|access|once)/i,
  /Claude needs your permission/i,
  /Permission required/i,
  /Yes,? and don['’]t ask again/i,
  /No,? and tell Claude/i,
  /(?:^|\s)[❯>]\s*1\.\s*Yes(?:\s|$)/im,
];

const QUESTION_MARKERS = [
  /Enter to select[\s\S]{0,160}(?:navigate|Esc to cancel)/i,
  /Type something[\s\S]{0,160}(?:Enter to select|Esc to cancel)/i,
];

// Claude Code 的 spinner 使用 Braille 动画帧；只要帧仍在变化，就不能把输入提示符当作任务完成。
const SPINNER_FRAME_MARKER = /[⠁⠂⠄⠈⠉⠋⠐⠘⠙⠠⠤⠦⠨⠰⠴⠸⠹⠼⡀⡄⡆⡇⡉⡋⡌⡏⡐⡠⡤⡦⡧⡨⡩⡬⡰⡴⡸⡹⡼⢀⢄⢆⢇⢈⢉⢌⢏⢐⢠⢤⢦⢧⢨⢩⢬⢰⢴⢸⢹⢼⣀⣄⣆⣇⣈⣉⣌⣏⣐⣠⣤⣦⣧⣨⣩⣬⣰⣴⣸⣹⣼⣾⣿✢]/u;

function stripTerminalControls(value: string): string {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, ' ')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ' ')
    .replace(/\x1b[@-_]/g, ' ')
    .replace(/\r/g, '\n')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ');
}

function isKnownClaudeTerminal(terminalId: string, state: DetectorState): boolean {
  if (state.claudeSeen) return true;

  const store = useAppStore.getState();
  const session = store.sessions.find(item => item.id === terminalId);
  if (!session) return false;
  const profile = store.profiles.find(item => item.id === session.profileId);
  const commands = profile?.startupCommands ?? [];
  return Boolean(
    session.claudeSessionId ||
    store.claudeSessionIds[terminalId] ||
    session.extraParams?.toLowerCase().includes('claude') ||
    commands.some(command => /(?:^|[\s;&|])claude(?:\s|$)/i.test(command))
  );
}

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

function notificationKey(terminalId: string, kind: NotificationKind): string {
  return `${terminalId}:${kind === 'completed' ? 'completed' : 'decision'}`;
}

async function showClaudeNotification(terminalId: string, kind: NotificationKind): Promise<void> {
  const settings = getAppSettings();
  const isCompletion = kind === 'completed';
  if (isCompletion ? !settings.claudeCompletionNotifications : !settings.claudeDecisionNotifications) return;

  const store = useAppStore.getState();
  const session = store.sessions.find(item => item.id === terminalId);
  if (!session) return;

  // 仅当应用处于前台时，激活终端才算正在被用户查看；分屏同样以 activeSessionId 判断激活窗格。
  const appWindow = getCurrentWindow();
  const windowFocused = await appWindow.isFocused().catch(() => false);
  if (windowFocused && store.activeSessionId === terminalId) return;

  await showNativeNotification(terminalId, session.profileName, kind)
    .catch(error => console.error('发送 Claude Code 通知失败:', error));
}

function scheduleClaudeNotification(terminalId: string, kind: NotificationKind): void {
  const settings = getAppSettings();
  const delaySeconds = kind === 'completed'
    ? settings.claudeCompletionNotificationDelaySeconds
    : settings.claudeDecisionNotificationDelaySeconds;
  const key = notificationKey(terminalId, kind);
  const existing = pendingNotifications.get(key);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    pendingNotifications.delete(key);
    void showClaudeNotification(terminalId, kind);
  }, Math.max(0, delaySeconds) * 1_000);
  pendingNotifications.set(key, timer);
}

function cancelClaudeNotification(terminalId: string, kind: NotificationKind): void {
  const key = notificationKey(terminalId, kind);
  const pending = pendingNotifications.get(key);
  if (pending) clearTimeout(pending);
  pendingNotifications.delete(key);
}

function evaluatePrompt(terminalId: string, state: DetectorState): void {
  state.timer = null;
  if (!getAppSettings().claudeDecisionNotifications || !isKnownClaudeTerminal(terminalId, state)) return;

  const hasQuestion = QUESTION_MARKERS.some(marker => marker.test(state.text));
  const hasConfirmation = CONFIRMATION_MARKERS.some(marker => marker.test(state.text));
  if ((!hasQuestion && !hasConfirmation) || state.promptActive) return;

  const now = Date.now();
  state.promptActive = true;
  if (now - state.lastNotifiedAt < NOTIFICATION_COOLDOWN_MS) return;
  state.lastNotifiedAt = now;
  scheduleClaudeNotification(terminalId, hasQuestion ? 'question' : 'confirmation');
}

export function handleClaudeTerminalOutput(terminalId: string, output: string): void {
  const settings = getAppSettings();
  if (!output || (!settings.claudeDecisionNotifications && !settings.claudeCompletionNotifications)) return;

  const state = detectorStates.get(terminalId) ?? createDetectorState();
  const cleanOutput = stripTerminalControls(output);
  state.text = (state.text + cleanOutput).slice(-DETECTION_BUFFER_SIZE);
  state.claudeSeen ||= CLAUDE_MARKERS.some(marker => marker.test(state.text));
  if (SPINNER_FRAME_MARKER.test(output)) {
    state.lastSpinnerAt = Date.now();
    // 延迟通知期间 spinner 又开始刷新，说明之前的“完成”判断不成立。
    if (!state.taskRunning && isKnownClaudeTerminal(terminalId, state)) {
      state.taskRunning = true;
      cancelClaudeNotification(terminalId, 'completed');
    }
  }
  state.taskHadBusyMarker ||= /esc to interrupt/i.test(state.text);
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => evaluatePrompt(terminalId, state), DETECTION_DELAY_MS);
  detectorStates.set(terminalId, state);
}

export function markClaudeTerminalInteraction(terminalId: string, taskSubmitted: boolean): void {
  if (!taskSubmitted) return;
  cancelClaudeNotification(terminalId, 'question');
  // 用户已经开始下一次交互，上一任务尚在延迟队列中的完成通知不应再弹出。
  cancelClaudeNotification(terminalId, 'completed');
  const state = detectorStates.get(terminalId) ?? createDetectorState();
  // 手动输入 claude 启动 CLI 时尚未进入 Claude 会话，不能把启动过程当成一项任务。
  if (!isKnownClaudeTerminal(terminalId, state)) {
    detectorStates.set(terminalId, state);
    return;
  }
  state.text = '';
  state.promptActive = false;
  state.taskRunning = true;
  state.taskStartedAt = Date.now();
  state.taskHadBusyMarker = false;
  state.taskPromptWasHidden = false;
  state.lastSpinnerAt = 0;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  detectorStates.set(terminalId, state);
}

export function markClaudeTaskPromptHidden(terminalId: string): void {
  const state = detectorStates.get(terminalId);
  if (state?.taskRunning) state.taskPromptWasHidden = true;
}

export function handleClaudeTaskCompleted(terminalId: string, hasBusySubagent: boolean): boolean {
  const state = detectorStates.get(terminalId);
  if (!state || !state.taskRunning || state.promptActive || !isKnownClaudeTerminal(terminalId, state)) {
    return false;
  }

  // 极短时间内可能仍是提交按键前的旧输入框，等待忙碌标记或首次重绘后再确认。
  if (!state.taskHadBusyMarker && Date.now() - state.taskStartedAt < 1_000) return false;
  const hasBusyEvidence = state.taskHadBusyMarker ||
    state.taskPromptWasHidden ||
    state.lastSpinnerAt >= state.taskStartedAt;
  // 仅按下空 Enter 或菜单重绘时提示符可能始终存在，不能据此报告任务完成。
  if (!hasBusyEvidence) return false;
  if (hasBusySubagent || Date.now() - state.lastSpinnerAt < SPINNER_ACTIVITY_GRACE_MS) return false;

  state.taskRunning = false;
  state.taskHadBusyMarker = false;
  state.taskPromptWasHidden = false;
  state.text = '';
  scheduleClaudeNotification(terminalId, 'completed');
  return true;
}

export function hasRunningClaudeTask(terminalId: string): boolean {
  return detectorStates.get(terminalId)?.taskRunning ?? false;
}

export function disposeClaudeTerminalNotification(terminalId: string): void {
  const state = detectorStates.get(terminalId);
  if (state?.timer) clearTimeout(state.timer);
  detectorStates.delete(terminalId);
  for (const kind of ['question', 'completed'] as const) {
    cancelClaudeNotification(terminalId, kind);
  }
}

export async function initializeClaudeNotificationActions(): Promise<() => void> {
  return onClaudeNotificationActivated(terminalId => void focusTerminal(terminalId));
}
