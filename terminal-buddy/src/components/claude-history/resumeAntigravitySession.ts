import { startBlankTerminal, startTerminal, updateProfileLastUsed } from '../../services/tauri';
import { launchTerminalSession } from '../../services/sessionRestore';
import { clientTerminalOwner, defaultShellType } from '../../services/platform';
import { effectiveProfilePath, normalizeProjectPath, projectForDirectory } from '../../utils/projectPath';
import { isModelRefLocalType } from '../../utils/claudeLaunch';
import {
  ANTIGRAVITY_ACCOUNT_REF_PREFIX,
  antigravityAccountIdFromCommand,
  buildAntigravityLaunchCommand,
  buildAntigravityResumeCommand,
  isAntigravityCommand,
  resumedAntigravitySessionId,
} from '../../utils/antigravityLaunch';
import { currentAntigravityCommand } from '../../utils/agentCommands';
import { PRESET_THEMES, type Profile } from '../../types';
import { useAppStore } from '../../stores/appStore';
import { focusTerminalById, type ResumableClaudeSession } from './resumeClaudeSession';

export function pickAntigravityProfile(profiles: Profile[], projectDir: string): Profile | undefined {
  const dir = normalizeProjectPath(projectDir);
  if (!dir) return undefined;
  const projects = useAppStore.getState().projects;
  const project = projectForDirectory(projects, projectDir);
  const candidates = profiles.filter(profile => {
    if (!isModelRefLocalType(profile.terminalType)) return false;
    if (!profile.startupCommands.some(command => isAntigravityCommand(command))) return false;
    const base = normalizeProjectPath(effectiveProfilePath(profile, projects));
    return project ? profile.group === project.name : Boolean(base && (base === dir || dir.startsWith(`${base}/`)));
  });
  const score = (profile: Profile) => {
    const base = normalizeProjectPath(effectiveProfilePath(profile, projects));
    return base && (base === dir || dir.startsWith(`${base}/`)) ? base.length : -1;
  };
  return candidates.sort((a, b) => score(b) - score(a))[0];
}

export interface AntigravityResumeOptions {
  /** 显式指定恢复账号：string 为 TerminalBuddy 管理的账号 ID，null 为系统默认登录；未传则按历史来源目录自动判断。 */
  accountId?: string | null;
}

function stripAntigravityAccountRef(command: string): string {
  const trimmed = command.trimStart();
  if (!trimmed.startsWith(ANTIGRAVITY_ACCOUNT_REF_PREFIX)) return command;
  const rest = trimmed.slice(ANTIGRAVITY_ACCOUNT_REF_PREFIX.length);
  const spaceIdx = rest.search(/\s/);
  return spaceIdx >= 0 ? rest.slice(spaceIdx).trimStart() : '';
}

export async function resumeAntigravitySession(
  session: ResumableClaudeSession,
  options?: AntigravityResumeOptions,
): Promise<void> {
  const store = useAppStore.getState();
  const explicitAccount = options !== undefined && 'accountId' in options;
  if (!explicitAccount) {
    const live = store.sessions.find(item =>
      item.extraParamMode === 'independent' && resumedAntigravitySessionId(item.extraParams) === session.sessionId);
    if (live) {
      focusTerminalById(live.id);
      return;
    }
  }
  if (!session.projectDir) throw new Error('该会话缺少工作目录，无法恢复');
  const profile = pickAntigravityProfile(store.profiles, session.projectDir);
  const project = projectForDirectory(store.projects, session.projectDir);
  const accountFromFile = session.filePath?.match(/[\\/]antigravity-profiles[\\/]([A-Za-z0-9_-]+)[\\/]/i)?.[1] ?? null;
  const rawBaseCommand = profile?.startupCommands.find(cmd => isAntigravityCommand(cmd)) ?? currentAntigravityCommand();
  const baseCommand = explicitAccount
    ? buildAntigravityLaunchCommand(stripAntigravityAccountRef(rawBaseCommand), options?.accountId ?? null)
    : (accountFromFile && !antigravityAccountIdFromCommand(rawBaseCommand)
      ? buildAntigravityLaunchCommand(rawBaseCommand, accountFromFile)
      : rawBaseCommand);
  const command = buildAntigravityResumeCommand(
    session.sessionId,
    baseCommand,
  );
  const name = session.title || 'Antigravity 会话';
  const terminalType = profile?.terminalType ?? defaultShellType();
  const theme = PRESET_THEMES.find(item => item.id === profile?.colorTheme) ?? PRESET_THEMES[0];
  await launchTerminalSession({
    addSession: store.addSession,
    resolveStartingSession: store.resolveStartingSession,
    errorLogPrefix: '恢复 Antigravity 会话失败:',
    makeSession: startingId => ({
      id: startingId,
      profileId: profile?.id ?? '',
      profileName: name,
      terminalType,
      colorTheme: { background: theme.background, foreground: theme.foreground },
      tabColor: profile?.tabColor ?? null,
      groupId: 'default',
      groupName: project?.name,
      owner: clientTerminalOwner(),
      startupPath: session.projectDir,
      extraParams: command,
      extraParamMode: 'independent',
      starting: true,
    }),
    start: (rows, cols) => profile
      ? startTerminal(profile.id, command, rows, cols, name, session.projectDir, 'independent')
      : startBlankTerminal(defaultShellType(), rows, cols, session.projectDir, name, command, project?.name),
    onStarted: terminalId => {
      const current = useAppStore.getState();
      current.setSessionDirectory(terminalId, session.projectDir);
      if (profile) void updateProfileLastUsed(profile.id).catch(console.error);
    },
  });
}
