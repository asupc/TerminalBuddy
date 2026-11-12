import { useMemo } from 'react';
import { useAppStore } from '../stores/appStore';
import { effectiveProfilePath, projectForDirectory } from '../utils/projectPath';

/** The project root associated with the selected workspace tab. */
export function useActiveTabProjectDirectory(): string | undefined {
  const activeSpecialTab = useAppStore(state => state.activeSpecialTab);
  const gitHistoryTab = useAppStore(state => state.gitHistoryTab);
  const claudeReplayTab = useAppStore(state => state.claudeReplayTab);
  const activeAgentTabKey = useAppStore(state => state.activeAgentTabKey);
  const agentTabs = useAppStore(state => state.agentTabs);
  const activeSessionId = useAppStore(state => state.activeSessionId);
  const sessions = useAppStore(state => state.sessions);
  const profiles = useAppStore(state => state.profiles);
  const projects = useAppStore(state => state.projects);
  const sessionDirectories = useAppStore(state => state.sessionDirectories);

  return useMemo(() => {
    const activeAgentTab = activeSpecialTab === 'agent-chat'
      ? agentTabs.find(tab => tab.key === activeAgentTabKey)
      : undefined;
    // 终端接力的目录跟随原终端会话；原生会话直接用创建时绑定的项目路径。
    const agentDirectory = activeAgentTab
      ? activeAgentTab.shape === 'native'
        ? activeAgentTab.projectPath
        : (sessionDirectories[activeAgentTab.terminalId]
          || sessions.find(item => item.id === activeAgentTab.terminalId)?.startupPath)
      : undefined;
    const directory = activeSpecialTab === 'git-history'
      ? gitHistoryTab?.repoRoot
      : activeSpecialTab === 'claude-replay'
        ? claudeReplayTab?.projectDir
        : activeSpecialTab === 'agent-chat'
          ? agentDirectory
          : undefined;
    if (activeSpecialTab) {
      return directory ? projectForDirectory(projects, directory)?.path ?? directory : undefined;
    }

    const session = sessions.find(item => item.id === activeSessionId);
    if (!session) return undefined;
    if (session.sessionType === 'editor') {
      return projectForDirectory(projects, session.profileId)?.path;
    }

    const profile = profiles.find(item => item.id === session.profileId);
    const assignedProject = profile && projects.find(item => item.name === profile.group);
    if (assignedProject?.path.trim()) return assignedProject.path;
    const path = sessionDirectories[session.id] || (profile && effectiveProfilePath(profile, projects));
    return path ? projectForDirectory(projects, path)?.path ?? path : undefined;
  }, [activeSpecialTab, gitHistoryTab, claudeReplayTab, activeAgentTabKey, agentTabs, activeSessionId, sessions, profiles, projects, sessionDirectories]);
}
