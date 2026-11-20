import { FC, useEffect, useRef, useState } from 'react';
import { defaultShellType, serverUsesWindowsPaths } from '../../services/platform';
import { saveEnableTabNavigation } from '../../services/tauri';
import { useAppStore } from '../../stores/appStore';
import { getAppSettings, saveAppSettings } from '../../utils/settings';
import { TreeView, type TreeItem } from '../file-explorer/TreeView';
import { ProjectLaunchMenuItems } from '../shared/ProjectLaunchMenuItems';
import type { ExtraParamMode, Profile, Project } from '../../types';

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
  onStartTerminal: (profile: Profile, extraParams?: string, tabName?: string, extraParamMode?: ExtraParamMode) => void;
  onStartBlankTerminal: (terminalType: 'powershell' | 'pwsh' | 'cmd' | 'bash' | 'sh' | 'zsh') => void;
  onStartTextEditor: () => void;
  onCloseAllTabs: () => void;
  onClose: () => void;
}

interface HoverMenuPos {
  left: number;
  top?: number | 'auto';
  bottom?: number | 'auto';
  maxHeight: number;
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
  const projects = useAppStore(state => state.projects);
  // 子菜单紧贴「新建配置终端」行右侧展开（右侧放不下时翻到左侧），顶部与该行对齐。
  const [submenuPos, setSubmenuPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  const [hoveredProject, setHoveredProject] = useState<{ project: Project; pos: HoverMenuPos } | null>(null);
  const hoverTimerRef = useRef<number | null>(null);

  // 三级浮动菜单延迟展开：鼠标只是扫过配置行时不要立刻弹层，
  // 也避免鼠标从行移向浮层途中经过其它行导致面板来回跳动。
  const scheduleHover = (apply: () => void) => {
    if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = window.setTimeout(() => {
      hoverTimerRef.current = null;
      apply();
    }, 150);
  };

  // 只有指针真正离开「新建配置终端」行及其子菜单/浮层时才收起，避免鼠标
  // 经过子菜单内边距等空白区域时三级面板被提前清空。
  const clearHoverMenus = () => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    setHoveredProject(null);
  };

  useEffect(() => () => {
    if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current);
  }, []);

  const handleSelect = (item: TreeItem) => {
    if (item.data) {
      const d = item.data as Record<string, unknown>;
      if ('group' in d) onStartTerminal(item.data as Profile);
      else if (d.terminalType) onStartBlankTerminal(d.terminalType as 'powershell' | 'pwsh' | 'cmd' | 'bash' | 'sh' | 'zsh');
      onClose();
    }
  };

  /** 「新建配置终端」子菜单的锚点：顶部与所在行对齐，右侧空间不足时翻到左侧。 */
  const handleSubmenuAnchor = (event: React.MouseEvent<HTMLDivElement>) => {
    const rowBounds = event.currentTarget.getBoundingClientRect();
    // .context-submenu 的 max-width 为 320，按上限估算是否需要水平翻转。
    const width = 322;
    const left = rowBounds.right + width <= window.innerWidth - 8
      ? rowBounds.right
      : Math.max(8, rowBounds.left - width);
    const top = Math.min(rowBounds.top, Math.max(8, window.innerHeight - 200));
    const maxHeight = Math.max(120, window.innerHeight - top - 12);
    setSubmenuPos(current => current && current.left === left && current.top === top && current.maxHeight === maxHeight
      ? current
      : { left, top, maxHeight });
  };

  /** 悬停行浮动菜单的落点：紧贴子菜单外侧；下方空间不足时向上展开，避免被裁成一条。 */
  const hoverMenuPos = (rowBounds: DOMRect, menuWidth: number): HoverMenuPos => {
    const submenuBounds = submenuRef.current?.getBoundingClientRect();
    const anchorBounds = menuRef.current?.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rowBounds.top - 8;
    const spaceAbove = Math.max(8, rowBounds.bottom - 8);
    // 一般向下与行顶对齐展开；下方放不下且上方更宽裕时向上展开，底边对齐行底。
    const openUpward = spaceBelow < 240 && spaceAbove > spaceBelow;
    const pos: HoverMenuPos = openUpward
      ? { left: rowBounds.right, top: 'auto', bottom: Math.max(8, window.innerHeight - rowBounds.bottom), maxHeight: spaceAbove }
      : { left: rowBounds.right, top: rowBounds.top, bottom: 'auto', maxHeight: Math.max(80, spaceBelow) };
    if (!submenuBounds) return pos;
    // 浮层朝子菜单的外侧展开：子菜单在父菜单右侧时浮层也向右，避免盖住上级菜单。
    const submenuOnRight = !anchorBounds || submenuBounds.left >= anchorBounds.right - 1;
    const rightX = submenuBounds.right;
    const leftX = Math.max(8, submenuBounds.left - menuWidth);
    const fitsRight = rightX + menuWidth <= window.innerWidth - 8;
    const fitsLeft = submenuBounds.left - menuWidth >= 8;
    pos.left = submenuOnRight ? (fitsRight ? rightX : leftX) : (fitsLeft ? leftX : rightX);
    return pos;
  };

  const sameMenuPos = (a: HoverMenuPos | undefined, b: HoverMenuPos): boolean => !!a
    && a.left === b.left && a.top === b.top && a.bottom === b.bottom && a.maxHeight === b.maxHeight;

  const handleTargetHover = (event: React.MouseEvent) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('.tree-item');
    // 行间空白 / 子菜单内边距：保持已有浮动菜单，让鼠标能顺利移到面板上。
    if (!row) return;
    const marker = row.querySelector<HTMLElement>('[data-profile-id], [data-project-id]');
    if (!marker) {
      // 普通不可展开行：收起当前浮层。
      clearHoverMenus();
      return;
    }
    const rowBounds = row.getBoundingClientRect();
    // 项目分组行：展开与「项目与命令」右键同步的启动菜单（命令行 / Agent 模型）。
    const projectId = marker.dataset.projectId;
    if (projectId) {
      const project = projects.find(p => p.name === projectId && p.path);
      if (!project) {
        clearHoverMenus();
        return;
      }
      const pos = hoverMenuPos(rowBounds, 340);
      scheduleHover(() => setHoveredProject(current => current?.project.name === project.name && sameMenuPos(current.pos, pos)
        ? current : { project, pos }));
      return;
    }
    clearHoverMenus();
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
          className={`context-menu-item has-submenu${hoveredProject ? ' submenu-active' : ''}`}
          onMouseEnter={handleSubmenuAnchor}
          onMouseLeave={event => {
            if (event.relatedTarget instanceof Element && event.relatedTarget.closest('.claude-model-submenu')) {
              return;
            }
            clearHoverMenus();
          }}
        >
          <span>新建配置终端</span>
          <span className="submenu-arrow">›</span>
          <div
            className="context-submenu new-terminal-profile-menu"
            ref={submenuRef}
            style={submenuPos ? { left: submenuPos.left, top: submenuPos.top } : undefined}
          >
            <div
              className="new-terminal-profile-scroll"
              style={submenuPos ? { maxHeight: submenuPos.maxHeight } : undefined}
              onMouseOver={handleTargetHover}
              onScroll={clearHoverMenus}
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
                  return null;
                }}
                className="submenu-tree"
                indent={12}
              />
            </div>
          </div>
          {hoveredProject && (
            <div
              className="new-terminal-project-menu"
              style={{ left: hoveredProject.pos.left, top: hoveredProject.pos.top, bottom: hoveredProject.pos.bottom, maxHeight: hoveredProject.pos.maxHeight }}
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
