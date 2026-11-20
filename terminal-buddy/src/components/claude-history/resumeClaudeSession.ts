import { buildClaudeRefCommand, startBlankTerminal, startTerminal, updateProfileLastUsed } from '../../services/tauri';
import { launchTerminalSession } from '../../services/sessionRestore';
import { clientTerminalOwner, defaultShellType } from '../../services/platform';
import { effectiveProfilePath, normalizeProjectPath, projectForDirectory } from '../../utils/projectPath';
import { inheritableClaudeArgs, isClaudeLaunchProfile } from '../../utils/claudeLaunch';
import { currentClaudeCommand } from '../../utils/agentCommands';
import { PRESET_THEMES, type Profile } from '../../types';
import { useAppStore } from '../../stores/appStore';

export interface ResumableClaudeSession {
  sessionId: string;
  title: string;
  projectDir: string;
}

/** 指定模型恢复：引用标记指向的供应商与模型。 */
export interface ClaudeVendorRef {
  providerId: string;
  modelId: string;
}

function normalizeDir(path: string): string {
  return normalizeProjectPath(path).replace(/\//g, '\\');
}

/**
 * 只选启动目录覆盖会话目录的连接（同目录或为其祖先），多个则取层级最深的那个。
 * 不做「任意第一个 claude 连接」的兜底：profile 的环境变量会注入终端，而这些连接的
 * env 是项目专属的（模型网关与凭据各不相同），套到别的项目目录上等于带错凭据。
 */
export function pickClaudeProfile(profiles: Profile[], projectDir: string): Profile | undefined {
  const dir = normalizeDir(projectDir);
  if (!dir) return undefined;
  const projects = useAppStore.getState().projects;
  const project = projectForDirectory(projects, projectDir);
  const candidates = profiles.filter(profile => {
    if (!isClaudeLaunchProfile(profile)) return false;
    if (project) return profile.group === project.name;
    const base = normalizeDir(effectiveProfilePath(profile, projects));
    return Boolean(base && (base === dir || dir.startsWith(`${base}\\`)));
  });
  // Prefer an explicit matching working directory; otherwise a Claude config belonging
  // to this project (never borrow credentials from another project).
  return candidates.sort((a, b) => {
    const score = (profile: Profile) => {
      const base = normalizeDir(effectiveProfilePath(profile, projects));
      return base && (base === dir || dir.startsWith(`${base}\\`)) ? base.length : -1;
    };
    return score(b) - score(a);
  })[0];
}

/** 聚焦已有终端（分屏模式下先落位），总览面板「跳转」与恢复复用。 */
export function focusTerminalById(terminalId: string): void {
  const store = useAppStore.getState();
  if (store.splitMode !== 'off' && !store.splitSlots.some(slot => slot.sessionId === terminalId)) {
    store.placeSessionInSplitSlot(terminalId);
  } else {
    store.setActiveSession(terminalId);
  }
}

/**
 * 恢复历史 Claude 会话：
 * - 该会话已在某个终端运行 → 聚焦原终端，不重复 resume
 * - 否则用「启动命令里跑 claude」的连接开新终端，`--resume <id>`
 *   作为该连接的追加参数
 * - 没有这类连接时退回空白终端，按 Agent 管理的基础命令参数（如
 *   `--dangerously-skip-permissions`）+ `--resume <id>` 执行
 * - 有 `vendorRef` 时走 independent 语义：`[引用] --resume <id>`，
 *   不继承 profile.startup_commands；blank 路必须存快照以便重启恢复
 *
 * 两条路径都不再前端 writeToTerminal：后端把 shell 启动命令延迟 300ms 批量写入，
 * 前端另写一句会抢在 shell 就绪前落到 cmd 基座上，等 claude 接管 TUI 后残余文本
 * （powershell.exe）就落在它的输入框里了。
 */
export async function resumeClaudeSession(
  session: ResumableClaudeSession,
  vendorRef?: ClaudeVendorRef,
): Promise<void> {
  const store = useAppStore.getState();
  const liveId = Object.entries(store.claudeSessionIds)
    .find(([, claudeId]) => claudeId === session.sessionId)?.[0];
  if (liveId && store.sessions.some(item => item.id === liveId)) {
    focusTerminalById(liveId);
    return;
  }

  const name = session.title || 'Claude 会话';
  const profile = pickClaudeProfile(store.profiles, session.projectDir);
  const project = projectForDirectory(store.projects, session.projectDir);
  // 连接自带的 claude 参数优先；连接命令没带参数时回落到 Agent 管理的基础命令。
  const profileArgs = inheritableClaudeArgs(profile?.startupCommands);
  const baseArgs = inheritableClaudeArgs(undefined, currentClaudeCommand());
  const inheritArgs = profileArgs || baseArgs;
  const resumeArg = `--resume ${session.sessionId}`;
  // 空白终端路径没有 profile 可继承启动命令，必须自己带上基础命令参数
  // （如 --dangerously-skip-permissions）；有 profile 时仅在其命令没带参数时补上，避免重复。
  const appendedBaseArgs = profile ? (profileArgs ? '' : baseArgs) : inheritArgs;
  // 快照里存整条含引用的命令（不含 --resume，恢复时临时拼）。
  const snapshotParams = vendorRef
    ? buildClaudeRefCommand(vendorRef.providerId, vendorRef.modelId, inheritArgs)
    : [appendedBaseArgs, resumeArg].filter(Boolean).join(' ');
  // 本次启动实际跑的命令（含 --resume）。
  const launchParams = vendorRef ? `${snapshotParams} ${resumeArg}` : snapshotParams;
  const base = {
    addSession: store.addSession,
    resolveStartingSession: store.resolveStartingSession,
    errorLogPrefix: '恢复 Claude 会话失败:',
  };

  if (profile) {
    const theme = PRESET_THEMES.find(t => t.id === profile.colorTheme) || PRESET_THEMES[0];
    await launchTerminalSession({
      ...base,
      // profileId 决定页签归属：TabNav 的分组回退链取 profile.group
      makeSession: (startingId) => ({
        id: startingId,
        profileId: profile.id,
        profileName: name,
        terminalType: profile.terminalType,
        colorTheme: { background: theme.background, foreground: theme.foreground },
        tabColor: profile.tabColor || null,
        groupId: 'default',
        groupName: project?.name,
        owner: clientTerminalOwner(),
        extraParams: vendorRef ? snapshotParams : launchParams,
        extraParamMode: vendorRef ? 'independent' : 'append',
        starting: true,
      }),
      start: (rows, cols) => startTerminal(
        profile.id,
        launchParams,
        rows,
        cols,
        name,
        session.projectDir || undefined,
        vendorRef ? 'independent' : 'append',
        // 恢复命令通常没有模型引用，让后端补一份只含 hooks 的临时 --settings。
        true,
      ),
      onStarted: (terminalId) => {
        // 记录本次恢复的会话 ID：Docker 容器重启后靠它重新拼出 --resume。
        useAppStore.getState().setClaudeSessionId(terminalId, session.sessionId);
        if (session.projectDir) useAppStore.getState().setSessionDirectory(terminalId, session.projectDir);
        void updateProfileLastUsed(profile.id).catch(error => {
          console.error('更新连接最近使用时间失败:', error);
        });
      },
    });
    return;
  }

  // 无 profile 的恢复落在项目空白终端上：Docker/远程网页端没有 powershell，
  // 基座 Shell 必须按平台取默认值（与 resumeCodexSession 同构）。
  const blankShellType = defaultShellType();
  await launchTerminalSession({
    ...base,
    makeSession: (startingId) => ({
      id: startingId,
      profileId: '',
      profileName: name,
      terminalType: blankShellType,
      colorTheme: { background: '#1E1E1E', foreground: '#CCCCCC' },
      tabColor: null,
      groupId: 'default',
      groupName: project?.name,
      owner: clientTerminalOwner(),
      // 有 vendorRef 的 blank 路必须存快照，否则重启恢复丢失模型。
      ...(vendorRef ? { extraParams: snapshotParams, extraParamMode: 'independent' as const } : {}),
      starting: true,
    }),
    start: (rows, cols) => startBlankTerminal(
      blankShellType,
      rows,
      cols,
      session.projectDir || undefined,
      name,
      vendorRef ? launchParams : `claude ${launchParams}`,
      project?.name,
      // 无供应商引用的恢复命令同样让后端补 hooks 临时 --settings。
      true,
    ),
    onStarted: (terminalId) => {
      // 空白终端路径同样记录会话 ID，保证重启恢复时能续接。
      useAppStore.getState().setClaudeSessionId(terminalId, session.sessionId);
      if (session.projectDir) useAppStore.getState().setSessionDirectory(terminalId, session.projectDir);
    },
  });
}
