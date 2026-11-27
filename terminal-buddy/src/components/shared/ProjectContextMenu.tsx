import { FC, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useAppStore } from '../../stores/appStore';
import { openInExplorer } from '../../services/tauri';
import { supportsSystemExplorerOpen } from '../../services/platform';
import type { Profile } from '../../types';
import { fitContextMenuToViewport } from '../../utils/contextMenu';
const PROFILE_TYPE_ICONS: Record<string, string> = {
  powershell: 'PS', pwsh: 'PS7', cmd: 'CMD', ssh: 'SSH', docker: 'DK', k8s: 'K8S', mstsc: 'RDP',
};
import { ProjectLaunchMenuItems } from './ProjectLaunchMenuItems';

interface ProjectContextMenuProps {
  x: number;
  y: number;
  /** 分组名（已登记项目名或旧式配置分组名）。 */
  groupName: string;
  onStartTerminal: (profile: Profile) => void;
  onAddProfile: (groupName: string) => void;
  onEditProject: (groupName: string) => void;
  onDeleteProject: (groupName: string) => void;
  onClose: () => void;
}

/**
 * 项目 / 配置分组右键菜单。
 * 「项目与命令」面板与会话标签栏的分组右键共用，保证两处菜单项与启动行为始终同步。
 */
export const ProjectContextMenu: FC<ProjectContextMenuProps> = ({
  x,
  y,
  groupName,
  onStartTerminal,
  onAddProfile,
  onEditProject,
  onDeleteProject,
  onClose,
}) => {
  const projects = useAppStore(s => s.projects);
  const profiles = useAppStore(s => s.profiles);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  const project = projects.find(item => item.name === groupName);
  const projectPath = project?.path;
  const groupProfiles = profiles.filter(p => (p.group || '默认') === groupName);
  // 删除项目只在该分组不再承载任何配置时提供（与旧面板行为一致）。
  const hasProfiles = groupProfiles.length > 0;

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const { width: menuWidth, height: menuHeight } = menu.getBoundingClientRect();
    const next = fitContextMenuToViewport(x, y, menuWidth, menuHeight);
    setPos(prev => (prev.x === next.x && prev.y === next.y ? prev : next));
  }, [x, y, projects, profiles]);

  useEffect(() => {
    const close = () => onClose();
    const closeOnOutside = (event: Event) => {
      if (
        event.target instanceof Element
        && (menuRef.current?.contains(event.target) || event.target.closest('.claude-model-submenu'))
      ) {
        return;
      }
      onClose();
    };
    document.addEventListener('mousedown', closeOnOutside);
    document.addEventListener('keydown', close);
    document.addEventListener('wheel', closeOnOutside);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', closeOnOutside);
      document.removeEventListener('keydown', close);
      document.removeEventListener('wheel', closeOnOutside);
      window.removeEventListener('resize', close);
    };
  }, [onClose]);

  return (
    <div ref={menuRef} className="context-menu" style={{ left: pos.x, top: pos.y }} onMouseDown={(e) => e.stopPropagation()}>
      {project && projectPath && (
        <ProjectLaunchMenuItems project={project} onLaunched={onClose} />
      )}
      {groupProfiles.length > 0 && (
        <>
          {project && projectPath && <div className="context-menu-separator" />}
          <div className="context-menu-section-label">项目配置</div>
          {groupProfiles.map(profile => {
            const typeLabel = PROFILE_TYPE_ICONS[profile.terminalType] || profile.terminalType.toUpperCase();
            return (
              <div
                key={profile.id}
                className="context-menu-item context-menu-profile-item"
                title={profile.startupCommands?.filter(Boolean).join(' && ') || profile.name}
                onClick={() => {
                  useAppStore.getState().setLastClickRegion('tab');
                  onClose();
                  onStartTerminal(profile);
                }}
              >
                <span className="config-nav-icon-type">{typeLabel}</span>
                <span
                  className="context-menu-profile-name"
                  style={profile.tabColor ? { color: profile.tabColor } : undefined}
                >
                  {profile.name}
                </span>
              </div>
            );
          })}
        </>
      )}
      {((project && projectPath) || groupProfiles.length > 0) && (
        <div className="context-menu-separator" />
      )}
      {project && projectPath && (
        <>
          {supportsSystemExplorerOpen() && (
            <div className="context-menu-item" onClick={async () => {
              onClose();
              try { await openInExplorer(projectPath); }
              catch (err) { console.error(err); }
            }}>打开目录</div>
          )}
          <div className="context-menu-item" onClick={() => {
            navigator.clipboard.writeText(projectPath).catch(() => {});
            onClose();
          }}>复制启动路径</div>
        </>
      )}
      <div className="context-menu-item" onClick={() => { onAddProfile(groupName); onClose(); }}>
        添加配置
      </div>
      <div className="context-menu-item" onClick={() => { onEditProject(groupName); onClose(); }}>
        编辑项目
      </div>
      {!hasProfiles && (
        <div className="context-menu-item danger" onClick={() => { onDeleteProject(groupName); onClose(); }}>
          删除项目
        </div>
      )}
    </div>
  );
};
