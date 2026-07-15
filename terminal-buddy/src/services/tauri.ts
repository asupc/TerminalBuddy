import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { Profile, CustomTheme, Workspace, RemoteFileEntry, ServerStats } from '../types';

// Profile Commands
export async function getAllProfiles(): Promise<Profile[]> {
  return invoke('get_all_profiles');
}

export async function getProfile(id: string): Promise<Profile> {
  return invoke('get_profile', { id });
}

export async function createProfile(
  name: string,
  group: string,
  terminalType: 'powershell' | 'cmd' | 'ssh' | 'docker' | 'k8s' | 'editor' | 'mstsc'
): Promise<Profile> {
  return invoke('create_profile', { name, group, terminalType });
}

export async function updateProfile(profile: Profile): Promise<void> {
  return invoke('update_profile', { profile });
}

export async function deleteProfile(id: string): Promise<void> {
  return invoke('delete_profile', { id });
}

export async function updateProfileLastUsed(id: string): Promise<void> {
  return invoke('update_profile_last_used', { id });
}

export async function exportAllProfiles(path: string): Promise<void> {
  return invoke('export_all_profiles', { path });
}

export async function importAllProfiles(path: string): Promise<Profile[]> {
  return invoke('import_all_profiles', { path });
}

// Terminal Commands
export async function startTerminal(profileId: string, extraStartupParams?: string, initialRows?: number, initialCols?: number): Promise<string> {
  return invoke('start_terminal', { profileId, extraStartupParams: extraStartupParams || null, initialRows: initialRows || 0, initialCols: initialCols || 0 });
}

export async function startMstsc(profileId: string): Promise<void> {
  return invoke('start_mstsc', { profileId });
}

export async function getClaudeSessionForCwd(cwd: string): Promise<string | null> {
  return invoke('get_claude_session_for_cwd', { cwd });
}

export async function getClaudeSessionForTerminal(terminalId: string): Promise<string | null> {
  return invoke('get_claude_session_for_terminal', { terminalId });
}

export async function getClaudeSessionsForTerminals(terminalIds: string[]): Promise<Record<string, string>> {
  return invoke('get_claude_sessions_for_terminals', { terminalIds });
}

export async function getTerminalProcessId(terminalId: string): Promise<number | null> {
  return invoke('get_terminal_process_id', { terminalId });
}

export async function showClaudeCodeNotification(
  terminalId: string,
  terminalName: string,
  notificationKind: 'confirmation' | 'question' | 'completed'
): Promise<void> {
  return invoke('show_claude_code_notification', { terminalId, terminalName, notificationKind });
}

export async function onClaudeNotificationActivated(callback: (terminalId: string) => void): Promise<UnlistenFn> {
  return listen<string>('claude-notification-activated', event => callback(event.payload));
}

export interface BotChannelConfig {
  id: string;
  name: string;
  platform: 'feishu' | 'dingtalk' | 'qq' | 'bridge';
  enabled: boolean;
  targetId: string;
  receiveIdType: string;
  webhookUrl: string;
  appId: string;
  secret: string;
  callbackToken: string;
  allowedUserIds: string[];
  hasSecret: boolean;
  hasCallbackToken: boolean;
}

export interface BotSettings {
  enabled: boolean;
  sendDecisionNotifications: boolean;
  sendCompletionNotifications: boolean;
  decisionTtlMinutes: number;
  appendEnter: boolean;
  channels: BotChannelConfig[];
}

export interface BotDeliveryReport {
  channelId: string;
  channelName: string;
  success: boolean;
  messageId?: string;
  error?: string;
}

export interface BotNotificationRequest {
  eventId: string;
  decisionId?: string;
  terminalId: string;
  terminalName: string;
  kind: 'confirmation' | 'question' | 'completed';
  title: string;
  summary: string;
  decisionTitle?: string;
  decisionQuestion?: string;
  decisionOptions?: BotDecisionOption[];
  decisionMultiSelect?: boolean;
  decisionSubmitMoveCount?: number;
  customOptionDownCount?: number;
}

export interface BotLongConnectionStatus {
  channelId: string;
  state: 'connecting' | 'connected' | 'disconnected' | 'error';
  error?: string;
}

export interface BotDecisionOption {
  label: string;
  description?: string;
  moveCount: number;
  recommended: boolean;
  selected?: boolean;
}

export interface ClaudeHookOption {
  label: string;
  description?: string;
}

export interface ClaudeHookQuestion {
  question: string;
  header: string;
  options: ClaudeHookOption[];
  multiSelect: boolean;
}

export interface ClaudeHookDecisionEvent {
  decisionId: string;
  terminalId: string;
  questions: ClaudeHookQuestion[];
  expiresAt: number;
}

export async function answerClaudeHookDecision(decisionId: string, answers: Record<string, string>): Promise<void> {
  return invoke('answer_claude_hook_decision', { decisionId, answers });
}

export async function continueClaudeHookInTerminal(decisionId: string): Promise<void> {
  return invoke('continue_claude_hook_in_terminal', { decisionId });
}

export async function sendClaudeHookDecisionNotification(decisionId: string): Promise<void> {
  return invoke('send_claude_hook_decision_notification', { decisionId });
}

export async function onClaudeHookDecision(callback: (payload: ClaudeHookDecisionEvent) => void): Promise<UnlistenFn> {
  return listen('claude-hook-decision', event => callback(event.payload as ClaudeHookDecisionEvent));
}

export async function onClaudeHookDecisionExpired(callback: (decisionId: string) => void): Promise<UnlistenFn> {
  return listen('claude-hook-decision-expired', event => {
    const payload = event.payload as { decisionId: string };
    callback(payload.decisionId);
  });
}

export async function onClaudeHookDecisionResolved(callback: (decisionId: string) => void): Promise<UnlistenFn> {
  return listen('claude-hook-decision-resolved', event => {
    const payload = event.payload as { decisionId: string };
    callback(payload.decisionId);
  });
}

export async function onClaudeHookCompleted(callback: (payload: { terminalId: string; sessionId: string }) => void): Promise<UnlistenFn> {
  return listen('claude-hook-completed', event => callback(event.payload as { terminalId: string; sessionId: string }));
}

export interface ScanBeginResult {
  platform: 'feishu' | 'dingtalk';
  qrUrl: string;
  handle: string;
  interval: number;
  expireIn: number;
}

export interface ScanCredentials {
  appId: string;
  appSecret: string;
  targetId?: string;
}

export interface ScanPollResult {
  status: 'waiting' | 'success' | 'expired' | 'failed';
  credentials?: ScanCredentials;
  error?: string;
}

export async function getBotSettings(): Promise<BotSettings> {
  return invoke('get_bot_settings');
}

export async function getBotLongConnectionStatus(): Promise<BotLongConnectionStatus[]> {
  return invoke('get_bot_long_connection_status');
}

export async function getBotCallbackBaseUrl(): Promise<string> {
  return invoke('get_bot_callback_base_url');
}

export async function saveBotSettings(settings: BotSettings): Promise<BotSettings> {
  const saved = await invoke<BotSettings>('save_bot_settings', { settings });
  window.dispatchEvent(new CustomEvent('bot-settings-changed', { detail: saved }));
  return saved;
}

export async function sendBotNotification(request: BotNotificationRequest): Promise<BotDeliveryReport[]> {
  return invoke('send_bot_notification', { request });
}

export async function testBotChannel(channelId: string): Promise<BotDeliveryReport> {
  return invoke('test_bot_channel', { channelId });
}

export async function testBotDecisionChannel(channelId: string): Promise<BotDeliveryReport> {
  return invoke('test_bot_decision_channel', { channelId });
}

export async function botScanBegin(platform: 'feishu' | 'dingtalk'): Promise<ScanBeginResult> {
  return invoke('bot_scan_begin', { platform });
}

export async function botScanPoll(begin: ScanBeginResult): Promise<ScanPollResult> {
  return invoke('bot_scan_poll', { begin });
}

export async function cancelBotDecision(decisionId: string): Promise<void> {
  return invoke('cancel_bot_decision', { decisionId });
}

export async function onClaudeBotReplyForwarded(callback: (payload: { terminalId: string; decisionId: string }) => void): Promise<UnlistenFn> {
  return listen('claude-bot-reply-forwarded', event => callback(event.payload as { terminalId: string; decisionId: string }));
}

export async function startBlankTerminal(terminalType: 'powershell' | 'cmd' | 'ssh' | 'docker' | 'k8s' | 'editor' | 'mstsc', initialRows?: number, initialCols?: number, startupPath?: string): Promise<string> {
  return invoke('start_blank_terminal', { terminalType, initialRows: initialRows || 0, initialCols: initialCols || 0, startupPath: startupPath || null });
}

export async function writeToTerminal(id: string, data: string): Promise<void> {
  return invoke('write_to_terminal', { id, data });
}

export async function resizeTerminal(
  id: string,
  rows: number,
  cols: number
): Promise<void> {
  return invoke('resize_terminal', { id, rows, cols });
}

export async function closeTerminal(id: string): Promise<void> {
  return invoke('close_terminal', { id });
}

export async function drainTerminalOutput(id: string): Promise<string> {
  return invoke('drain_terminal_output', { id });
}

// Events
export async function onTerminalOutput(
  terminalId: string,
  callback: (output: string) => void
): Promise<UnlistenFn> {
  return listen(`terminal_output_${terminalId}`, (event) => {
    callback(event.payload as string);
  });
}

// File System Commands
export interface FileNode {
  name: string;
  path: string;
  is_directory: boolean;
  size: number;
  lastModified: number;
}

export async function listDirectory(path: string, exclusions?: string[]): Promise<FileNode[]> {
  return invoke('list_directory', { path, exclusions: exclusions ?? null });
}

export async function openPath(path: string): Promise<void> {
  return invoke('open_path', { path });
}

export async function openInExplorer(path: string): Promise<void> {
  return invoke('open_in_explorer', { path });
}

export async function deletePath(path: string): Promise<void> {
  return invoke('delete_path', { path });
}

export async function renamePath(path: string, newName: string): Promise<void> {
  return invoke('rename_path', { path, newName });
}

export const readFileContent = (path: string) => invoke<string>('read_file_content', { path });
export const writeFileContent = (path: string, content: string) => invoke<boolean>('write_file_content', { path, content });
export const getFileSize = (path: string) => invoke<number>('get_file_size', { path });
export const getFileMeta = (path: string) => invoke<{ lastModified: number; size: number }>('get_file_meta', { path });

// Git Commands
export interface GitRepositoryStatus {
  repoRoot: string;
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  changedCount: number;
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  hasRemote: boolean;
}

export interface GitBranch {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
  upstream: string | null;
}

export type GitHistoryRefKind = 'head' | 'local' | 'remote' | 'tag' | 'base';

export interface GitHistoryRef {
  name: string;
  fullName: string;
  revision: string;
  kind: GitHistoryRefKind;
  isCurrent: boolean;
  isUpstream: boolean;
  isBase: boolean;
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  parents: string[];
  refs: GitHistoryRef[];
  author: string;
  date: string;
  subject: string;
}

export interface GitHistoryResult {
  commits: GitCommit[];
  refs: GitHistoryRef[];
  currentRef: GitHistoryRef | null;
  upstreamRef: GitHistoryRef | null;
  baseRef: GitHistoryRef | null;
  mergeBase: string | null;
  ahead: number;
  behind: number;
}

export interface GitPullResult {
  command: string;
  output: string;
  oldHead: string | null;
  newHead: string | null;
  updatedCommits: GitCommit[];
}

export interface GitPushOptions {
  path: string;
  remote: string;
  localBranch: string;
  remoteBranch: string;
  setUpstream: boolean;
  followTags: boolean;
  forceWithLease: boolean;
  operationId?: string | null;
}

export interface GitPushResult {
  command: string;
  output: string;
  remote: string;
  localBranch: string;
  remoteBranch: string;
  outgoingCommits: GitCommit[];
}

export interface GitPushPreview {
  command: string;
  remote: string;
  localBranch: string;
  remoteBranch: string;
  targetRef: string;
  targetExists: boolean;
  commits: GitCommit[];
  warning: string | null;
}

export interface GitPushOutputEvent {
  operationId: string;
  chunk: string;
}

export interface GitChangedFile {
  path: string;
  extension: string;
  status: string;
  additions: number;
  deletions: number;
  staged: boolean;
  untracked: boolean;
}

export interface GitHistoryFile {
  path: string;
  oldPath: string | null;
  extension: string;
  status: string;
  statusCode: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface GitHistoryFileDiff {
  path: string;
  oldPath: string | null;
  status: string;
  statusCode: string;
  oldRevision: string;
  newRevision: string;
  oldContent: string;
  newContent: string;
  binary: boolean;
}

export const getGitRepositoryStatus = (path: string) =>
  invoke<GitRepositoryStatus | null>('get_git_repository_status', { path });
export const gitListBranches = (path: string) =>
  invoke<GitBranch[]>('git_list_branches', { path });
export const gitCheckoutBranch = (path: string, branch: string) =>
  invoke<string>('git_checkout_branch', { path, branch });
export const gitPull = (path: string) => invoke<GitPullResult>('git_pull', { path });
export const gitPush = (path: string) => invoke<string>('git_push', { path });
export const gitPreviewPush = (options: GitPushOptions) =>
  invoke<GitPushPreview>('git_preview_push', { options });
export const gitPushWithOptions = (options: GitPushOptions) =>
  invoke<GitPushResult>('git_push_with_options', { options });
export const listenGitPushOutput = (
  operationId: string,
  callback: (chunk: string) => void,
) => listen<GitPushOutputEvent>('git_push_output', (event) => {
  if (event.payload.operationId === operationId) {
    callback(event.payload.chunk);
  }
});
export const gitCommitAll = (path: string, message: string) =>
  invoke<string>('git_commit_all', { path, message });
export const gitGetChangedFiles = (path: string) =>
  invoke<GitChangedFile[]>('git_get_changed_files', { path });
export const gitCommitPaths = (path: string, message: string, paths: string[]) =>
  invoke<string>('git_commit_paths', { path, message, paths });
export const gitGetHistory = (path: string, limit?: number, skip?: number) =>
  invoke<GitHistoryResult>('git_get_history', { path, limit: limit ?? null, skip: skip ?? null });
export const gitGetHistoryFiles = (path: string, fromRevision: string | null, toRevision: string) =>
  invoke<GitHistoryFile[]>('git_get_history_files', { path, fromRevision, toRevision });
export const gitGetHistoryFileDiff = (
  path: string,
  fromRevision: string | null,
  toRevision: string,
  filePath: string,
  oldPath: string | null,
  statusCode: string,
  binary: boolean,
) =>
  invoke<GitHistoryFileDiff>('git_get_history_file_diff', {
    path,
    fromRevision,
    toRevision,
    filePath,
    oldPath,
    statusCode,
    binary,
  });

// Theme Commands
export async function getAllThemes(): Promise<CustomTheme[]> {
  return invoke('get_all_themes');
}

export async function createTheme(name: string): Promise<CustomTheme> {
  return invoke('create_theme', { name });
}

export async function updateTheme(theme: CustomTheme): Promise<void> {
  return invoke('update_theme', { theme });
}

export async function deleteTheme(id: string): Promise<void> {
  return invoke('delete_theme', { id });
}

// Workspace Commands
export async function getAllWorkspaces(): Promise<Workspace[]> {
  return invoke('get_all_workspaces');
}

export async function getWorkspace(id: string): Promise<Workspace> {
  return invoke('get_workspace', { id });
}

export async function createWorkspace(name: string): Promise<Workspace> {
  return invoke('create_workspace', { name });
}

export async function updateWorkspace(workspace: Workspace): Promise<void> {
  return invoke('update_workspace', { workspace });
}

export async function deleteWorkspace(id: string): Promise<void> {
  return invoke('delete_workspace', { id });
}

// Settings Commands
export interface VsCodeTerminalSupport {
  available: boolean;
  reason: string;
  nodePath: string | null;
  nodeVersion: string | null;
}

export async function getBackendAppSettings(): Promise<{
  closeBehavior: 'exit' | 'tray';
  launchWindowMode: 'windowed' | 'maximized';
  terminalLoadingMode: 'default' | 'vsCode';
  dataPath: string | null;
  tabSidebarWidth: number;
  configNavWidth: number;
  fileNavWidth: number;
  enableTabNavigation: boolean;
  singleInstance: boolean;
}> {
  return invoke('get_app_settings');
}

export async function saveCloseBehavior(behavior: 'exit' | 'tray'): Promise<void> {
  return invoke('save_close_behavior', { behavior });
}

export async function saveLaunchWindowMode(mode: 'windowed' | 'maximized'): Promise<void> {
  return invoke('save_launch_window_mode', { mode });
}

export async function saveTerminalLoadingMode(mode: 'default' | 'vsCode'): Promise<void> {
  return invoke('save_terminal_loading_mode', { mode });
}

export async function getVsCodeTerminalSupport(): Promise<VsCodeTerminalSupport> {
  return invoke('get_vscode_terminal_support');
}

export async function acknowledgeTerminalOutput(id: string, charCount: number): Promise<void> {
  return invoke('acknowledge_terminal_output', { id, charCount });
}

export async function getTerminalLoadingMode(id: string): Promise<'default' | 'vsCode'> {
  return invoke('get_terminal_loading_mode', { id });
}

export async function getDataPath(): Promise<string> {
  return invoke('get_data_path');
}

export async function setDataPath(newPath: string): Promise<void> {
  return invoke('set_data_path', { newPath });
}

export async function saveTabSidebarWidth(width: number): Promise<void> {
  return invoke('save_tab_sidebar_width', { width });
}

export async function saveConfigNavWidth(width: number): Promise<void> {
  return invoke('save_config_nav_width', { width });
}

export async function saveFileNavWidth(width: number): Promise<void> {
  return invoke('save_file_nav_width', { width });
}

export async function saveEnableTabNavigation(enabled: boolean): Promise<void> {
  return invoke('save_enable_tab_navigation', { enabled });
}

export async function saveSingleInstance(enabled: boolean): Promise<void> {
  return invoke('save_single_instance', { enabled });
}

export async function saveLaunchAtLogin(enabled: boolean): Promise<void> {
  return invoke('save_launch_at_login', { enabled });
}

export async function syncLaunchAtLogin(): Promise<boolean> {
  return invoke('sync_launch_at_login');
}

// Clipboard Commands
export async function readClipboardFilePaths(): Promise<string[]> {
  return invoke('read_clipboard_file_paths');
}

export async function readClipboardImageAsFile(): Promise<string> {
  return invoke('read_clipboard_image_as_file');
}

// Template Commands
export async function getCommandTemplates(): Promise<string> {
  return invoke('get_command_templates');
}

export async function saveCommandTemplates(content: string): Promise<void> {
  return invoke('save_command_templates', { content });
}

export async function initCommandTemplates(defaultContent: string): Promise<boolean> {
  return invoke('init_command_templates', { defaultContent });
}

// System Commands
let _windowsBuildNumber: number | null | undefined = undefined;

export async function getWindowsBuildNumber(): Promise<number | null> {
  if (_windowsBuildNumber !== undefined) return _windowsBuildNumber;
  try {
    _windowsBuildNumber = await invoke<number>('get_windows_build_number');
  } catch {
    _windowsBuildNumber = null;
  }
  return _windowsBuildNumber;
}

// Window Commands (bypass ACL bug)
export async function windowMinimize(): Promise<void> {
  return invoke('window_minimize');
}

export async function windowToggleMaximize(): Promise<void> {
  return invoke('window_toggle_maximize');
}

export async function windowClose(): Promise<void> {
  return invoke('window_close');
}

export async function windowExitApp(): Promise<void> {
  return invoke('window_exit_app');
}

// Full Data Import/Export
export async function exportAllData(filePath: string): Promise<void> {
  return invoke('export_all_data', { filePath });
}

export async function importAllData(filePath: string): Promise<void> {
  return invoke('import_all_data', { filePath });
}

// Web API Commands
export async function saveWebApiSettings(
  enabled: boolean,
  port: number,
  username: string,
  password: string,
  shareSessions: boolean
): Promise<void> {
  return invoke('save_web_api_settings', { enabled, port, username, password, shareSessions });
}

export async function getWebApiStatus(): Promise<{
  enabled: boolean;
  port: number;
  username: string;
  hasPassword: boolean;
}> {
  return invoke('get_web_api_status');
}

export async function restartWebServer(): Promise<string> {
  return invoke('restart_web_server');
}

export async function getWebServerAddress(): Promise<string> {
  return invoke('get_web_server_address');
}

export async function getWebQuickAccessUrl(): Promise<string> {
  return invoke('get_web_quick_access_url');
}

// Client Data Commands
export async function readClientData(key: string): Promise<string | null> {
  return invoke<string | null>('read_client_data', { key });
}

export async function writeClientData(key: string, content: string): Promise<void> {
  return invoke('write_client_data', { key, content });
}

// SSH Settings Commands
export async function getDownloadsDirectory(): Promise<string> {
  return invoke('get_downloads_directory');
}

export async function saveSshDownloadDir(dir: string): Promise<void> {
  return invoke('save_ssh_download_dir', { dir });
}

export async function saveServerMonitorInterval(interval: number): Promise<void> {
  return invoke('save_server_monitor_interval', { interval });
}

export async function saveWebApiShareSessions(enabled: boolean): Promise<void> {
  return invoke('save_web_api_share_sessions', { enabled });
}

// ============ SSH Remote File Commands ============

export async function connectSshSession(terminalId: string, profileId: string): Promise<void> {
  return invoke('connect_ssh_session', { terminalId, profileId });
}

export async function getSshHomeDir(terminalId: string): Promise<string> {
  return invoke('get_ssh_home_dir', { terminalId });
}

export async function getSshTempDirectory(): Promise<string> {
  return invoke('get_ssh_temp_directory');
}

export async function ensureDir(path: string): Promise<void> {
  return invoke('ensure_dir', { path });
}

export async function remoteListDir(terminalId: string, path: string): Promise<RemoteFileEntry[]> {
  return invoke('remote_list_dir', { terminalId, path });
}

export async function remoteCreateDir(terminalId: string, path: string): Promise<void> {
  return invoke('remote_create_dir', { terminalId, path });
}

export async function remoteCreateFile(terminalId: string, path: string): Promise<void> {
  return invoke('remote_create_file', { terminalId, path });
}

export async function remoteRemove(terminalId: string, path: string, isDir: boolean): Promise<void> {
  return invoke('remote_remove', { terminalId, path, isDir });
}

export async function remoteRename(terminalId: string, from: string, to: string): Promise<void> {
  return invoke('remote_rename', { terminalId, from, to });
}

export async function remoteMove(terminalId: string, from: string, to: string): Promise<void> {
  return invoke('remote_move', { terminalId, from, to });
}

export async function remoteCopy(terminalId: string, from: string, to: string): Promise<void> {
  return invoke('remote_copy', { terminalId, from, to });
}

export async function remoteChmod(terminalId: string, path: string, mode: number): Promise<void> {
  return invoke('remote_chmod', { terminalId, path, mode });
}

export async function remoteUpload(terminalId: string, localPath: string, remotePath: string, transferId: string, profileId: string): Promise<void> {
  return invoke('remote_upload', { terminalId, localPath, remotePath, transferId, profileId });
}

export async function remoteDownload(terminalId: string, remotePath: string, localPath: string, transferId: string, profileId: string): Promise<void> {
  return invoke('remote_download', { terminalId, remotePath, localPath, transferId, profileId });
}

export async function remoteDownloadDir(terminalId: string, remotePath: string, localPath: string, transferId: string, profileId: string): Promise<void> {
  return invoke('remote_download_dir', { terminalId, remotePath, localPath, transferId, profileId });
}

export async function getServerStats(terminalId: string): Promise<ServerStats> {
  return invoke('get_server_stats', { terminalId });
}

export async function onTransferProgress(
  callback: (progress: { transferId: string; terminalId: string; transferred: number; total: number; percent: number; direction: string }) => void
): Promise<UnlistenFn> {
  return listen('remote_transfer_progress', (event) => {
    callback(event.payload as any);
  });
}

export async function onTransferError(
  callback: (error: { transferId: string; error: string }) => void
): Promise<UnlistenFn> {
  return listen('remote_transfer_error', (event) => {
    callback(event.payload as any);
  });
}
