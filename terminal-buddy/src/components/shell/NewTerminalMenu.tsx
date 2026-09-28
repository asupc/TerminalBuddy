import { FC, useState } from 'react';
import { saveEnableTabNavigation } from '../../services/tauri';
import { useAppStore } from '../../stores/appStore';
import { getAppSettings, saveAppSettings } from '../../utils/settings';
import { TreeView, type TreeItem } from '../file-explorer/TreeView';
import type { ExtraParamMode, Profile } from '../../types';

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
  onStartBlankTerminal: (terminalType: 'powershell' | 'pwsh' | 'cmd') => void;
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
  const [hoveredProfile, setHoveredProfile] = useState<{ profile: Profile; x: number; y: number } | null>(null);
  const matchingPresets = (profile: Profile) => presets.filter(preset =>
    preset.enabled && (!preset.commandMatch || profile.startupCommands.some(command =>
      command.toLowerCase().includes(preset.commandMatch!.toLowerCase()))));

  const handleSelect = (item: TreeItem) => {
    if (item.data) {
      const d = item.data as Record<string, unknown>;
      if ('group' in d) onStartTerminal(item.data as Profile);
      else if (d.terminalType) onStartBlankTerminal(d.terminalType as 'powershell' | 'pwsh' | 'cmd');
      onClose();
    }
  };

  const handleProfileHover = (event: React.MouseEvent<HTMLDivElement>) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('.tree-item');
    const marker = row?.querySelector<HTMLElement>('[data-profile-id]');
    const profile = marker && visibleSubmenuItems.find(item => item.id === marker.dataset.profileId)?.data as Profile | undefined;
    if (!profile || matchingPresets(profile).length === 0) {
      setHoveredProfile(null);
      return;
    }
    const rowBounds = row!.getBoundingClientRect();
    const menuBounds = submenuRef.current?.getBoundingClientRect();
    const menuWidth = 190;
    const x = menuBounds && menuBounds.right + menuWidth <= window.innerWidth - 8
      ? menuBounds.right : Math.max(8, (menuBounds?.left ?? rowBounds.left) - menuWidth);
    const y = Math.max(8, Math.min(rowBounds.top, window.innerHeight - 80));
    setHoveredProfile(current => current?.profile.id === profile.id && current.x === x && current.y === y
      ? current : { profile, x, y });
  };

  return (
    <>
      <div className="context-menu-overlay" onClick={onClose} />
      <div
        className="context-menu"
        ref={menuRef}
        style={{ left: x, top: y }}
        onMouseOver={event => {
          if (!(event.target as HTMLElement).closest('.has-submenu')) setHoveredProfile(null);
        }}
      >
        <div className="context-menu-item" onClick={() => { onStartBlankTerminal('powershell'); onClose(); }}>
          PowerShell
        </div>
        <div className="context-menu-item" onClick={() => { onStartBlankTerminal('cmd'); onClose(); }}>
          CMD
        </div>
        <div className="context-menu-item" onClick={() => { onStartTextEditor(); onClose(); }}>
          文本编辑器
        </div>
        <div className={`context-menu-item has-submenu${hoveredProfile ? ' submenu-active' : ''}`}>
          <span>新建配置终端</span>
          <span className="submenu-arrow">›</span>
          <div
            className="context-submenu new-terminal-profile-menu"
            ref={submenuRef}
          >
            <div
              className="new-terminal-profile-scroll"
              style={{ maxHeight: `${Math.max(80, Math.min(window.innerHeight * 0.7, window.innerHeight - y - 120))}px` }}
              onMouseOver={handleProfileHover}
              onScroll={() => setHoveredProfile(null)}
            >
              <TreeView
                items={submenuTree}
                expandedIds={expandedGroups}
                onToggle={onToggleGroup}
                selectedId={highlightedIndex >= 0 ? visibleSubmenuItems[highlightedIndex]?.id : undefined}
                onSelect={handleSelect}
                renderEnd={item => item.data && 'group' in (item.data as object) ? (
                  <span data-profile-id={(item.data as Profile).id} className="submenu-profile-end">
                    {matchingPresets(item.data as Profile).length > 0 && <span className="submenu-arrow">›</span>}
                  </span>
                ) : null}
                className="submenu-tree"
                indent={12}
              />
            </div>
          </div>
          {hoveredProfile && (
            <div
              className="new-terminal-preset-menu"
              style={{ left: hoveredProfile.x, top: hoveredProfile.y, maxHeight: `calc(100vh - ${hoveredProfile.y + 8}px)` }}
              onMouseLeave={() => setHoveredProfile(null)}
            >
              {matchingPresets(hoveredProfile.profile).map(preset => (
                <div key={preset.id} className="context-menu-item" onClick={event => {
                  event.stopPropagation();
                  onStartTerminal(hoveredProfile.profile, preset.params, preset.name, undefined, preset.name, preset.tagColor, preset.mode);
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
        }}>切换为横向选项卡</div>
      </div>
    </>
  );
};
