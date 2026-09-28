import { useMemo } from 'react';
import { useAppStore } from '../stores/appStore';
import { effectiveProfilePath, projectForDirectory } from '../utils/projectPath';

/** The project root associated with the selected workspace tab. */
export function useActiveTabProjectDirectory(): string | undefined {
  const activeSpecialTab = useAppStore(state => state.activeSpecialTab);
  const gitHistoryTab = useAppStore(state => state.gitHistoryTab);
  const claudeReplayTab = useAppStore(state => state.claudeReplayTab);
  const activeSessionId = useAppStore(state => state.activeSessionId);
  const sessions = useAppStore(state => state.sessions);
  const profiles = useAppStore(state => state.profiles);
  const projects = useAppStore(state => state.projects);
  const sessionDirectories = useAppStore(state => state.sessionDirectories);

  return useMemo(() => {
    const directory = activeSpecialTab === 'git-history'
      ? gitHistoryTab?.repoRoot
      : activeSpecialTab === 'claude-replay'
        ? claudeReplayTab?.projectDir
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
  }, [activeSpecialTab, gitHistoryTab, claudeReplayTab, activeSessionId, sessions, profiles, projects, sessionDirectories]);
}
