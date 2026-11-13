import { FC, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useAppStore } from '../../stores/appStore';
import { openInExplorer } from '../../services/tauri';
import { supportsSystemExplorerOpen } from '../../services/platform';
import { fitContextMenuToViewport } from '../../utils/contextMenu';
import { ProjectLaunchMenuItems } from './ProjectLaunchMenuItems';

interface ProjectContextMenuProps {
  x: number;
  y: number;
  /** 分组名（已登记项目名或旧式配置分组名）。 */
  groupName: string;
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
  // 删除项目只在该分组不再承载任何配置时提供（与旧面板行为一致）。
  const hasProfiles = profiles.some(p => p.group === groupName);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const { width: menuWidth, height: menuHeight } = menu.getBoundingClientRect();
    const next = fitContextMenuToViewport(x, y, menuWidth, menuHeight);
    setPos(prev => (prev.x === next.x && prev.y === next.y ? prev : next));
  }, [x, y, projects, profiles]);

  useEffect(() => {
    const close = () => onClose();
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    document.addEventListener('wheel', close);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
      document.removeEventListener('wheel', close);
      window.removeEventListener('resize', close);
    };
  }, [onClose]);

  return (
    <div ref={menuRef} className="context-menu" style={{ left: pos.x, top: pos.y }} onMouseDown={(e) => e.stopPropagation()}>
      {project && projectPath && (
        <>
          {/* 启动区（命令行 / Agent 模型）与会话标签栏「新建配置终端」悬停菜单共用 */}
          <ProjectLaunchMenuItems project={project} onLaunched={onClose} />
          <div className="context-menu-separator" />
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
