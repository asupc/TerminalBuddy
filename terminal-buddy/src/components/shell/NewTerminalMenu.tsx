import { FC, useState } from 'react';
import { defaultShellType, serverUsesWindowsPaths } from '../../services/platform';
import { saveEnableTabNavigation } from '../../services/tauri';
import { useAppStore } from '../../stores/appStore';
import { getAppSettings, saveAppSettings } from '../../utils/settings';
import { TreeView, type TreeItem } from '../file-explorer/TreeView';
import { ProjectLaunchMenuItems } from '../shared/ProjectLaunchMenuItems';
import type { ExtraParamMode, Profile, Project } from '../../types';
import { matchingStartupPresets } from '../../utils/startupPresets';

interface NewTerminalMenuProps {
  x: number;
  y: number;
  submenuTree: TreeItem[];
  expandedGroups: Set<string>;
  onToggleGroup: (id: string) => void;
  highlightedIndex: number;
  visibleSubmenuItems: TreeItem[];
  menuRef: React.RefObject<HTMLDivElement | null>;
  submenuRef: React.RefObject<HTMLDivElement | null>;
  onStartTerminal: (profile: Profile, extraParams?: string, presetName?: string, tabName?: string, presetTag?: string, presetTagColor?: string | null, extraParamMode?: ExtraParamMode) => void;
  onStartBlankTerminal: (terminalType: 'powershell' | 'pwsh' | 'cmd' | 'bash' | 'sh' | 'zsh') => void;
  onStartTextEditor: () => void;
  onCloseAllTabs: () => void;
  onClose: () => void;
}

/** 侧栏空白处右键的「新建终端」菜单：快捷入口 + 配置树子菜单。 */
export const NewTerminalMenu: FC<NewTerminalMenuProps> = ({
  x,
  y,
  submenuTree,
  expandedGroups,
  onToggleGroup,
  highlightedIndex,
  visibleSubmenuItems,
  menuRef,
  submenuRef,
  onStartTerminal,
  onStartBlankTerminal,
  onStartTextEditor,
  onCloseAllTabs,
  onClose,
}) => {
  const presets = useAppStore(state => state.extraParamPresets);
  const projects = useAppStore(state => state.projects);
  const [submenuLeft, setSubmenuLeft] = useState(x);
  const [hoveredTarget, setHoveredTarget] = useState<{ target: Profile; x: number; y: number } | null>(null);
  const [hoveredProject, setHoveredProject] = useState<{ project: Project; x: number; y: number } | null>(null);
  const matchingPresets = (target: Profile) => matchingStartupPresets(presets, target.startupCommands);

  const handleSelect = (item: TreeItem) => {
    if (item.data) {
      const d = item.data as Record<string, unknown>;
      if ('group' in d) onStartTerminal(item.data as Profile);
      else if (d.terminalType) onStartBlankTerminal(d.terminalType as 'powershell' | 'pwsh' | 'cmd' | 'bash' | 'sh' | 'zsh');
      onClose();
    }
  };

  /** 悬停行右侧浮动菜单的落点：右缘放不下时翻到左侧（宽度按菜单类型估算）。 */
  const hoverMenuPos = (rowBounds: DOMRect, menuWidth: number): { x: number; y: number } => {
    const menuBounds = submenuRef.current?.getBoundingClientRect();
    return {
      x: menuBounds && menuBounds.right + menuWidth <= window.innerWidth - 8
        ? menuBounds.right
        : Math.max(8, (menuBounds?.left ?? rowBounds.left) - menuWidth),
      y: Math.max(8, Math.min(rowBounds.top, window.innerHeight - 80)),
    };
  };

  const handleTargetHover = (event: React.MouseEvent) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('.tree-item');
    const marker = row?.querySelector<HTMLElement>('[data-profile-id], [data-project-id]');
    if (!row || !marker) {
      setHoveredTarget(null);
      setHoveredProject(null);
      return;
    }
    const rowBounds = row.getBoundingClientRect();
    // 项目分组行：展开与「项目与命令」右键同步的启动菜单（命令行 / 预设 / Agent 模型）。
    const projectId = marker.dataset.projectId;
    if (projectId) {
      const project = projects.find(p => p.name === projectId && p.path);
      setHoveredTarget(null);
      if (project) {
        const { x, y } = hoverMenuPos(rowBounds, 250);
        setHoveredProject(current => current?.project.name === project.name && current.x === x && current.y === y
          ? current : { project, x, y });
      } else {
        setHoveredProject(null);
      }
      return;
    }
    setHoveredProject(null);
    const target = visibleSubmenuItems.find(item => item.id === marker.dataset.profileId)?.data as Profile | undefined;
    if (!target || matchingPresets(target).length === 0) {
      setHoveredTarget(null);
      return;
    }
    const { x, y } = hoverMenuPos(rowBounds, 190);
    setHoveredTarget(current => current?.target === target && current.x === x && current.y === y
      ? current : { target, x, y });
  };

  return (
    <>
      <div className="context-menu-overlay" onClick={onClose} />
      <div
        className="context-menu"
        ref={menuRef}
        style={{ left: x, top: y }}
        onMouseOver={event => {
          if (!(event.target as HTMLElement).closest('.has-submenu')) {
            setHoveredTarget(null);
            setHoveredProject(null);
          }
        }}
      >
        <div className="context-menu-item" onClick={() => { onStartBlankTerminal(defaultShellType()); onClose(); }}>
          {serverUsesWindowsPaths() ? 'PowerShell' : 'Bash'}
        </div>
        <div className="context-menu-item" onClick={() => { onStartBlankTerminal(serverUsesWindowsPaths() ? 'cmd' : 'sh'); onClose(); }}>
          {serverUsesWindowsPaths() ? 'CMD' : 'Shell'}
        </div>
        <div className="context-menu-item" onClick={() => { onStartTextEditor(); onClose(); }}>
          文本编辑器
        </div>
        <div
          className={`context-menu-item has-submenu${hoveredTarget || hoveredProject ? ' submenu-active' : ''}`}
          onMouseEnter={event => setSubmenuLeft(event.currentTarget.getBoundingClientRect().right)}
        >
          <span>新建配置终端</span>
          <span className="submenu-arrow">›</span>
          <div
            className="context-submenu new-terminal-profile-menu"
            ref={submenuRef}
            style={{ left: submenuLeft }}
          >
            <div
              className="new-terminal-profile-scroll"
              onMouseOver={handleTargetHover}
              onScroll={() => {
                setHoveredTarget(null);
                setHoveredProject(null);
              }}
            >
              <TreeView
                items={submenuTree}
                expandedIds={expandedGroups}
                onToggle={onToggleGroup}
                selectedId={highlightedIndex >= 0 ? visibleSubmenuItems[highlightedIndex]?.id : undefined}
                onSelect={handleSelect}
                renderEnd={item => {
                  // 项目分组行：标记可展开与项目右键同步的启动菜单（Agent 启动入口）。
                  if (item.isGroup) {
                    const project = projects.find(p => p.name === item.id);
                    return project?.path ? (
                      <span data-project-id={project.name} className="submenu-profile-end">
                        <span className="submenu-arrow">›</span>
                      </span>
                    ) : null;
                  }
                  if (item.data && 'group' in (item.data as object)) {
                    return (
                      <span data-profile-id={(item.data as Profile).id} className="submenu-profile-end">
                        {matchingPresets(item.data as Profile).length > 0 && <span className="submenu-arrow">›</span>}
                      </span>
                    );
                  }
                  return null;
                }}
                className="submenu-tree"
                indent={12}
              />
            </div>
          </div>
          {hoveredTarget && (
            <div
              className="new-terminal-preset-menu"
              style={{ left: hoveredTarget.x, top: hoveredTarget.y, maxHeight: `calc(100vh - ${hoveredTarget.y + 8}px)` }}
              onMouseLeave={() => setHoveredTarget(null)}
            >
              {matchingPresets(hoveredTarget.target).map(preset => (
                <div key={preset.id} className="context-menu-item" onClick={event => {
                  event.stopPropagation();
                  onStartTerminal(hoveredTarget.target, preset.params, preset.name, undefined, preset.name, preset.tagColor, preset.mode);
                  onClose();
                }}>
                  <span className="new-terminal-preset-dot" style={{ backgroundColor: preset.tagColor || 'var(--accent)' }} />
                  <span className="new-terminal-preset-name">{preset.name}</span>
                </div>
              ))}
            </div>
          )}
          {hoveredProject && (
            <div
              className="new-terminal-preset-menu new-terminal-project-menu"
              style={{ left: hoveredProject.x, top: hoveredProject.y, maxHeight: `calc(100vh - ${hoveredProject.y + 8}px)` }}
              onMouseLeave={() => setHoveredProject(null)}
            >
              <ProjectLaunchMenuItems project={hoveredProject.project} onLaunched={onClose} />
            </div>
          )}
        </div>
        <div className="context-menu-separator" />
        <div className="context-menu-item danger" onClick={onCloseAllTabs}>
          关闭所有选项卡
        </div>
        <div className="context-menu-separator" />
        <div className="context-menu-item" onClick={() => {
          onClose();
          const s = getAppSettings();
          saveAppSettings({ ...s, enableTabNavigation: false });
          saveEnableTabNavigation(false).catch(console.error);
          window.dispatchEvent(new CustomEvent('tab-navigation-changed'));
        }}>切换为横向会话标签</div>
      </div>
    </>
  );
};
