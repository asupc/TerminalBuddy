import { getCurrentWindow } from '@tauri-apps/api/window';
import { useAppStore } from '../stores/appStore';
import { getAppSettings } from '../utils/settings';
import { onClaudeNotificationActivated, showClaudeCodeNotification as showNativeNotification } from './tauri';

const DETECTION_DELAY_MS = 300;
const DETECTION_BUFFER_SIZE = 12_000;
const NOTIFICATION_COOLDOWN_MS = 5_000;

type DetectorState = {
  text: string;
  claudeSeen: boolean;
  promptActive: boolean;
  taskRunning: boolean;
  taskStartedAt: number;
  taskHadBusyMarker: boolean;
  lastNotifiedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
};

const detectorStates = new Map<string, DetectorState>();

function createDetectorState(): DetectorState {
  return {
    text: '',
    claudeSeen: false,
    promptActive: false,
    taskRunning: false,
    taskStartedAt: 0,
    taskHadBusyMarker: false,
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

async function showClaudeNotification(terminalId: string, kind: 'confirmation' | 'question' | 'completed'): Promise<void> {
  const settings = getAppSettings();
  if (!settings.claudeCodeNotifications) return;

  const store = useAppStore.getState();
  const session = store.sessions.find(item => item.id === terminalId);
  if (!session) return;

  await showNativeNotification(terminalId, session.profileName, kind)
    .catch(error => console.error('发送 Claude Code 通知失败:', error));
}

function evaluatePrompt(terminalId: string, state: DetectorState): void {
  state.timer = null;
  if (!getAppSettings().claudeCodeNotifications || !isKnownClaudeTerminal(terminalId, state)) return;

  const hasQuestion = QUESTION_MARKERS.some(marker => marker.test(state.text));
  const hasConfirmation = CONFIRMATION_MARKERS.some(marker => marker.test(state.text));
  if ((!hasQuestion && !hasConfirmation) || state.promptActive) return;

  const now = Date.now();
  state.promptActive = true;
  if (now - state.lastNotifiedAt < NOTIFICATION_COOLDOWN_MS) return;
  state.lastNotifiedAt = now;
  void showClaudeNotification(terminalId, hasQuestion ? 'question' : 'confirmation');
}

export function handleClaudeTerminalOutput(terminalId: string, output: string): void {
  if (!output || !getAppSettings().claudeCodeNotifications) return;

  const state = detectorStates.get(terminalId) ?? createDetectorState();
  const cleanOutput = stripTerminalControls(output);
  state.text = (state.text + cleanOutput).slice(-DETECTION_BUFFER_SIZE);
  state.claudeSeen ||= CLAUDE_MARKERS.some(marker => marker.test(state.text));
  state.taskHadBusyMarker ||= /esc to interrupt/i.test(state.text);
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => evaluatePrompt(terminalId, state), DETECTION_DELAY_MS);
  detectorStates.set(terminalId, state);
}

export function markClaudeTerminalInteraction(terminalId: string, taskSubmitted: boolean): void {
  if (!taskSubmitted) return;
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
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  detectorStates.set(terminalId, state);
}

export function handleClaudeTaskCompleted(terminalId: string): boolean {
  const state = detectorStates.get(terminalId);
  if (!state || !state.taskRunning || state.promptActive || !isKnownClaudeTerminal(terminalId, state)) {
    return false;
  }

  // 极短时间内可能仍是提交按键前的旧输入框，等待忙碌标记或首次重绘后再确认。
  if (!state.taskHadBusyMarker && Date.now() - state.taskStartedAt < 1_000) return false;

  state.taskRunning = false;
  state.taskHadBusyMarker = false;
  state.text = '';
  void showClaudeNotification(terminalId, 'completed');
  return true;
}

export function hasRunningClaudeTask(terminalId: string): boolean {
  return detectorStates.get(terminalId)?.taskRunning ?? false;
}

export function disposeClaudeTerminalNotification(terminalId: string): void {
  const state = detectorStates.get(terminalId);
  if (state?.timer) clearTimeout(state.timer);
  detectorStates.delete(terminalId);
}

export async function initializeClaudeNotificationActions(): Promise<() => void> {
  return onClaudeNotificationActivated(terminalId => void focusTerminal(terminalId));
}
