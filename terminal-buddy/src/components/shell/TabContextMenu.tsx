import { FC } from 'react';
import { openInExplorer } from '../../services/tauri';
import type { ExtraParamMode, Profile, TerminalSession } from '../../types';

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

  const profile = session && session.sessionType !== 'editor'
    ? profiles.find(p => p.id === session.profileId)
    : undefined;

  return (
    <div className="context-menu" style={{ left: x, top: y }}>
      <div className="context-menu-item" onClick={() => { onRename(session); onClose(); }}>
        重命名
      </div>
      {session && session.sessionType !== 'editor' && profile && (
        <div className="context-menu-item" onClick={() => {
          onStartTerminal(
            profile,
            session.extraParams,
            session.extraParamTag,
            session.profileName,
            session.extraParamTag,
            session.extraParamTagColor,
            session.extraParamMode,
          );
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
        if (!profile) return null;
        const isLocal = profile.terminalType === 'powershell' || profile.terminalType === 'pwsh' || profile.terminalType === 'cmd';
        const hasPath = !!profile.startupPath && profile.startupPath.trim() !== '';
        if (!isLocal || !hasPath) return null;
        return (
          <>
            <div className="context-menu-item" onClick={async () => {
              onClose();
              try { await openInExplorer(profile.startupPath!); }
              catch (err) { console.error(err); }
            }}>打开目录</div>
            <div className="context-menu-item" onClick={() => {
              navigator.clipboard.writeText(profile.startupPath!).catch(() => {});
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
