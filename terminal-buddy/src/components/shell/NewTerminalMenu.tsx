import { FC } from 'react';
import { saveEnableTabNavigation } from '../../services/tauri';
import { getAppSettings, saveAppSettings } from '../../utils/settings';
import { TreeView, type TreeItem } from '../file-explorer/TreeView';
import type { Profile } from '../../types';

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
  onStartTerminal: (profile: Profile, extraParams?: string, presetName?: string, tabName?: string, presetTag?: string, presetTagColor?: string | null) => void;
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
  const handleSelect = (item: TreeItem) => {
    if (item.data) {
      const d = item.data as Record<string, unknown>;
      if ('group' in d) onStartTerminal(item.data as Profile);
      else if (d.terminalType) onStartBlankTerminal(d.terminalType as 'powershell' | 'pwsh' | 'cmd');
      onClose();
    }
  };

  return (
    <>
      <div className="context-menu-overlay" onClick={onClose} />
      <div className="context-menu" ref={menuRef} style={{ left: x, top: y }}>
        <div className="context-menu-item" onClick={() => { onStartBlankTerminal('powershell'); onClose(); }}>
          PowerShell
        </div>
        <div className="context-menu-item" onClick={() => { onStartBlankTerminal('cmd'); onClose(); }}>
          CMD
        </div>
        <div className="context-menu-item" onClick={() => { onStartTextEditor(); onClose(); }}>
          文本编辑器
        </div>
        <div className="context-menu-item has-submenu">
          <span>新建配置终端</span>
          <span className="submenu-arrow">›</span>
          <div
            className="context-submenu"
            ref={submenuRef}
            style={{ maxHeight: `${Math.max(200, window.innerHeight - y - 16)}px` }}
          >
            <TreeView
              items={submenuTree}
              expandedIds={expandedGroups}
              onToggle={onToggleGroup}
              selectedId={highlightedIndex >= 0 ? visibleSubmenuItems[highlightedIndex]?.id : undefined}
              onSelect={handleSelect}
              className="submenu-tree"
              indent={12}
            />
          </div>
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
