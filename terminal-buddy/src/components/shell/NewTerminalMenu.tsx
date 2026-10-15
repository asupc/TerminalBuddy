import { FC, useState } from 'react';
import { defaultShellType, serverUsesWindowsPaths } from '../../services/platform';
import { saveEnableTabNavigation } from '../../services/tauri';
import { useAppStore } from '../../stores/appStore';
import { getAppSettings, saveAppSettings } from '../../utils/settings';
import { TreeView, type TreeItem } from '../file-explorer/TreeView';
import type { ExtraParamMode, Profile, Project } from '../../types';
import { matchingStartupPresets } from '../../utils/startupPresets';
import { openProjectTerminal } from '../../utils/openTerminalInDir';

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
  const [submenuLeft, setSubmenuLeft] = useState(x);
  const projects = useAppStore(state => state.projects);
  const [hoveredTarget, setHoveredTarget] = useState<{ target: Profile | Project; x: number; y: number } | null>(null);
  const matchingPresets = (target: Profile | Project) => matchingStartupPresets(presets,
    'startupCommands' in target ? target.startupCommands : [target.startupCommand || '']);

  const projectForItem = (item: TreeItem) => item.isGroup && item.id !== '__pinned__'
    ? projects.find(project => project.name === item.id && project.path && project.startupCommand?.trim())
    : undefined;

  const handleSelect = (item: TreeItem) => {
    if (item.data) {
      const d = item.data as Record<string, unknown>;
      if ('group' in d) onStartTerminal(item.data as Profile);
      else if (d.terminalType) onStartBlankTerminal(d.terminalType as 'powershell' | 'pwsh' | 'cmd' | 'bash' | 'sh' | 'zsh');
      onClose();
    }
  };

  const handleTargetHover = (event: React.MouseEvent) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('.tree-item');
    const marker = row?.querySelector<HTMLElement>('[data-profile-id], [data-project-name]');
    const target = marker?.dataset.projectName
      ? projects.find(project => project.name === marker.dataset.projectName)
      : marker && visibleSubmenuItems.find(item => item.id === marker.dataset.profileId)?.data as Profile | undefined;
    if (!target || ('startupCommands' in target && matchingPresets(target).length === 0)) {
      setHoveredTarget(null);
      return;
    }
    const rowBounds = row!.getBoundingClientRect();
    const menuBounds = submenuRef.current?.getBoundingClientRect();
    const menuWidth = 190;
    const x = menuBounds && menuBounds.right + menuWidth <= window.innerWidth - 8
      ? menuBounds.right : Math.max(8, (menuBounds?.left ?? rowBounds.left) - menuWidth);
    const y = Math.max(8, Math.min(rowBounds.top, window.innerHeight - 80));
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
          if (!(event.target as HTMLElement).closest('.has-submenu')) setHoveredTarget(null);
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
          className={`context-menu-item has-submenu${hoveredTarget ? ' submenu-active' : ''}`}
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
              onScroll={() => setHoveredTarget(null)}
            >
              <TreeView
                items={submenuTree}
                expandedIds={expandedGroups}
                onToggle={onToggleGroup}
                selectedId={highlightedIndex >= 0 ? visibleSubmenuItems[highlightedIndex]?.id : undefined}
                onSelect={handleSelect}
                onContextMenu={(event, item) => {
                  if (!projectForItem(item)) return;
                  event.preventDefault();
                  event.stopPropagation();
                  handleTargetHover(event);
                }}
                renderEnd={item => {
                  const project = projectForItem(item);
                  if (project) return (
                    <span data-project-name={project.name} className="submenu-profile-end"><span className="submenu-arrow">›</span></span>
                  );
                  return item.data && 'group' in (item.data as object) ? (
                    <span data-profile-id={(item.data as Profile).id} className="submenu-profile-end">
                      {matchingPresets(item.data as Profile).length > 0 && <span className="submenu-arrow">›</span>}
                    </span>
                  ) : null;
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
              {!('startupCommands' in hoveredTarget.target) && (
                <div className="context-menu-item" onClick={event => {
                  event.stopPropagation();
                  if (!('startupCommands' in hoveredTarget.target)) void openProjectTerminal(hoveredTarget.target);
                  onClose();
                }}>启动项目</div>
              )}
              {matchingPresets(hoveredTarget.target).map(preset => (
                <div key={preset.id} className="context-menu-item" onClick={event => {
                  event.stopPropagation();
                  if ('startupCommands' in hoveredTarget.target) {
                    onStartTerminal(hoveredTarget.target, preset.params, preset.name, undefined, preset.name, preset.tagColor, preset.mode);
                  } else {
                    void openProjectTerminal(hoveredTarget.target, preset);
                  }
                  onClose();
                }}>
                  <span className="new-terminal-preset-dot" style={{ backgroundColor: preset.tagColor || 'var(--accent)' }} />
                  <span className="new-terminal-preset-name">{preset.name}</span>
                </div>
              ))}
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
