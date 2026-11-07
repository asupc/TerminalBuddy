import { useAppStore, relayAgentTabKey } from '../../stores/appStore';
import { effectiveProfilePath } from '../../utils/projectPath';
import { openTerminalInDir } from '../../utils/openTerminalInDir';
import { withoutResumeArgs } from '../../utils/commandParams';
import { FC, useEffect, useState } from 'react';
import { openInExplorer, terminalAgentList, type TerminalAgentSession } from '../../services/tauri';
import type { ExtraParamMode, Profile, TerminalSession } from '../../types';
import { supportsSystemExplorerOpen } from '../../services/platform';

interface TabContextMenuProps {
  x: number;
  y: number;
  sessionId: string;
  sessions: TerminalSession[];
  profiles: Profile[];
  onStartTerminal: (profile: Profile, extraParams?: string, presetName?: string, tabName?: string, presetTag?: string, presetTagColor?: string | null, extraParamMode?: ExtraParamMode) => void;
  onClose: () => void;
  onRename: (session: TerminalSession | undefined) => void;
  onCloseSession: (sessionId: string) => void;
  onCloseOthers: (sessionId: string) => void;
}

/** 选项卡右键菜单：重命名 / 以此配置新建 / 复制配置名 / 打开目录 / 关闭。 */
export const TabContextMenu: FC<TabContextMenuProps> = ({
  x,
  y,
  sessionId,
  sessions,
  profiles,
  onStartTerminal,
  onClose,
  onRename,
  onCloseSession,
  onCloseOthers,
}) => {
  const session = sessions.find(s => s.id === sessionId);

  // 该终端里是否有可接力的 Agent 会话：有则提供聊天标签入口。
  const [agentSession, setAgentSession] = useState<TerminalAgentSession | null>(null);
  useEffect(() => {
    let disposed = false;
    terminalAgentList()
      .then(list => { if (!disposed) setAgentSession(list.find(item => item.terminalId === sessionId) ?? null); })
      .catch(() => {});
    return () => { disposed = true; };
  }, [sessionId]);

  const profile = session && session.sessionType !== 'editor'
    ? profiles.find(p => p.id === session.profileId)
    : undefined;
  // 项目空白终端会话：无 profileId 但挂靠项目分组。桌面端默认 PowerShell，
  // Docker/远程网页端默认 Bash，因此不能只认 powershell，否则 Docker 版本的
  // 项目会话右键菜单会缺少「以此配置新建终端」。
  const isProjectSession = !!session && session.sessionType !== 'editor'
    && !session.profileId && !!session.groupName
    && (session.terminalType === 'powershell' || session.terminalType === 'pwsh'
      || session.terminalType === 'cmd' || session.terminalType === 'bash'
      || session.terminalType === 'sh' || session.terminalType === 'zsh');

  return (
    <div className="context-menu" style={{ left: x, top: y }}>
      <div className="context-menu-item" onClick={() => { onRename(session); onClose(); }}>
        重命名
      </div>
      {agentSession && (
        <div className="context-menu-item" onClick={() => {
          const key = relayAgentTabKey(sessionId);
          const store = useAppStore.getState();
          store.openAgentTab({
            key,
            shape: 'relay',
            terminalId: sessionId,
            title: agentSession.title || agentSession.profileName || session?.profileName || 'Agent 会话',
            provider: agentSession.provider === 'codex' ? 'codex' : 'claude',
            openedAt: Date.now(),
          });
          store.setActiveAgentTab(key);
          onClose();
        }}>查看 Agent 对话</div>
      )}
      {session && session.sessionType !== 'editor' && (profile || isProjectSession) && (
        <div className="context-menu-item" onClick={() => {
          if (profile) {
            onStartTerminal(
              profile,
              // 从历史恢复的会话 extraParams 含 --resume，新建终端必须剥除，避免续接旧会话。
              withoutResumeArgs(session.extraParams),
              session.extraParamTag,
              session.profileName,
              session.extraParamTag,
              session.extraParamTagColor,
              session.extraParamMode,
            );
          } else {
            const state = useAppStore.getState();
            // 兼容尚未记录启动快照的旧项目会话，优先使用会话保存的命令和目录。
            const project = state.projects.find(item => item.name === session.groupName);
            const preset = session.extraParamTag
              ? state.extraParamPresets.find(item => item.name === session.extraParamTag)
              : undefined;
            const path = session.startupPath ?? (project?.path || state.sessionDirectories[sessionId]);
            const command = withoutResumeArgs(session.extraParams) ?? preset?.params;
            void openTerminalInDir(path, {
              command,
              name: session.profileName,
              groupName: session.groupName,
              presetTag: session.extraParamTag,
              presetTagColor: session.extraParamTagColor,
            }).catch(error => useAppStore.getState().showToast('启动终端失败：' + String(error), 'error'));
          }
          onClose();
        }}>以此配置新建终端</div>
      )}
      {session && session.sessionType !== 'editor' && (
        <div className="context-menu-item" onClick={() => {
          navigator.clipboard.writeText(session.profileName).catch(() => {});
          onClose();
        }}>复制配置名</div>
      )}
      {(() => {
        if (!session || session.sessionType === 'editor') return null;
        // 无 profile 的会话（项目右键/文件与 Git 面板打开的空白终端）回退到会话记录目录
        const terminalType = profile?.terminalType || session.terminalType;
        const isLocal = terminalType === 'powershell' || terminalType === 'pwsh' || terminalType === 'cmd';
        const state = useAppStore.getState();
        const path = (profile && effectiveProfilePath(profile, state.projects))
          || state.sessionDirectories[sessionId];
        if (!isLocal || !path) return null;
        return (
          <>
            {supportsSystemExplorerOpen() && (
              <div className="context-menu-item" onClick={async () => {
                onClose();
                try { await openInExplorer(path); }
                catch (err) { console.error(err); }
              }}>打开目录</div>
            )}
            <div className="context-menu-item" onClick={() => {
              navigator.clipboard.writeText(path).catch(() => {});
              onClose();
            }}>复制启动路径</div>
          </>
        );
      })()}
      <div className="context-menu-item danger" onClick={() => { onCloseSession(sessionId); onClose(); }}>
        关闭
      </div>
      {session?.sessionType === 'editor' && (
        <div className="context-menu-item" onClick={() => { onCloseOthers(sessionId); onClose(); }}>
          关闭其它
        </div>
      )}
    </div>
  );
};
