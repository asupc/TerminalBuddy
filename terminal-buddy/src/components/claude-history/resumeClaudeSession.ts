import { startBlankTerminal, startTerminal, updateProfileLastUsed } from '../../services/tauri';
import { launchTerminalSession } from '../../services/sessionRestore';
import { isClaudeLaunchProfile } from '../../utils/claudeLaunch';
import { PRESET_THEMES, type Profile } from '../../types';
import { useAppStore } from '../../stores/appStore';

export interface ResumableClaudeSession {
  sessionId: string;
  title: string;
  projectDir: string;
}

/** 追加到恢复命令上的启动参数预设（只取 append 语义，见 HistoryPanel 的过滤）。 */
export interface ResumeLaunchPreset {
  name: string;
  params: string;
  tagColor: string | null;
}

function normalizeDir(path: string): string {
  return path.trim().replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

/**
 * 只选启动目录覆盖会话目录的连接（同目录或为其祖先），多个则取层级最深的那个。
 * 不做「任意第一个 claude 连接」的兜底：profile 的环境变量会注入终端，而这些连接的
 * env 是项目专属的（模型网关与凭据各不相同），套到别的项目目录上等于带错凭据。
 */
export function pickClaudeProfile(profiles: Profile[], projectDir: string): Profile | undefined {
  const dir = normalizeDir(projectDir);
  if (!dir) return undefined;
  const covering = profiles.filter(profile => {
    const base = normalizeDir(profile.startupPath);
    return isClaudeLaunchProfile(profile) && (base === dir || dir.startsWith(`${base}\\`));
  });
  return covering.reduce<Profile | undefined>(
    (best, profile) => (!best
      || normalizeDir(profile.startupPath).length > normalizeDir(best.startupPath).length
      ? profile : best),
    undefined,
  );
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
 * - 否则用「启动命令里跑 claude」的连接开新终端，`--resume <id>`（连同启动参数预设）
 *   作为该连接的追加参数
 * - 没有这类连接时退回空白终端，claude 命令交给后端排进启动命令批次
 *
 * 两条路径都不再前端 writeToTerminal：后端把 shell 启动命令延迟 300ms 批量写入，
 * 前端另写一句会抢在 shell 就绪前落到 cmd 基座上，等 claude 接管 TUI 后残余文本
 * （powershell.exe）就落在它的输入框里了。
 */
export async function resumeClaudeSession(
  session: ResumableClaudeSession,
  preset?: ResumeLaunchPreset,
): Promise<void> {
  const store = useAppStore.getState();
  const liveId = Object.entries(store.claudeSessionIds)
    .find(([, claudeId]) => claudeId === session.sessionId)?.[0];
  if (liveId && store.sessions.some(item => item.id === liveId)) {
    focusTerminalById(liveId);
    return;
  }

  const name = session.title || 'Claude 会话';
  const extraParams = [preset?.params.trim(), `--resume ${session.sessionId}`]
    .filter(Boolean)
    .join(' ');
  const profile = pickClaudeProfile(store.profiles, session.projectDir);
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
        owner: 'pc',
        extraParams,
        extraParamMode: 'append',
        extraParamTag: preset?.name,
        extraParamTagColor: preset?.tagColor ?? null,
        starting: true,
      }),
      start: (rows, cols) => startTerminal(
        profile.id,
        extraParams,
        rows,
        cols,
        name,
        session.projectDir || undefined,
        preset?.name,
        preset?.tagColor ?? null,
        'append',
      ),
      onStarted: (terminalId) => {
        if (session.projectDir) useAppStore.getState().setSessionDirectory(terminalId, session.projectDir);
        void updateProfileLastUsed(profile.id).catch(error => {
          console.error('更新连接最近使用时间失败:', error);
        });
      },
    });
    return;
  }

  await launchTerminalSession({
    ...base,
    makeSession: (startingId) => ({
      id: startingId,
      profileId: '',
      profileName: name,
      terminalType: 'powershell',
      colorTheme: { background: '#1E1E1E', foreground: '#CCCCCC' },
      tabColor: null,
      groupId: 'default',
      owner: 'pc',
      starting: true,
    }),
    start: (rows, cols) => startBlankTerminal(
      'powershell',
      rows,
      cols,
      session.projectDir || undefined,
      name,
      `claude ${extraParams}`,
    ),
    onStarted: (terminalId) => {
      if (session.projectDir) useAppStore.getState().setSessionDirectory(terminalId, session.projectDir);
    },
  });
}
