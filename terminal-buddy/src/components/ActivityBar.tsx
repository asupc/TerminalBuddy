import type { FC } from 'react';
import { Files, ListTree, Server, Settings } from 'lucide-react';
import './ActivityBar.css';

export type SidebarPanel = 'config' | 'files' | 'tabs';

interface ActivityBarProps {
  activePanel: SidebarPanel | null;
  tabNavigationEnabled: boolean;
  onSelectPanel: (panel: SidebarPanel) => void;
  onSettings: () => void;
}

const NAV_ITEMS = [
  { id: 'config', label: '配置', icon: Server },
  { id: 'files', label: '文件', icon: Files },
  { id: 'tabs', label: '选项卡', icon: ListTree },
] as const;

export const ActivityBar: FC<ActivityBarProps> = ({
  activePanel,
  tabNavigationEnabled,
  onSelectPanel,
  onSettings,
}) => (
  <aside className="activity-bar" aria-label="主侧边栏">
    <nav className="activity-bar-nav" aria-label="导航面板">
      {NAV_ITEMS.map(item => {
        const Icon = item.icon;
        const isDisabled = item.id === 'tabs' && !tabNavigationEnabled;
        const isActive = activePanel === item.id && !isDisabled;
        return (
          <button
            key={item.id}
            className={`activity-bar-button${isActive ? ' active' : ''}`}
            type="button"
            onClick={() => onSelectPanel(item.id)}
            disabled={isDisabled}
            title={isDisabled ? '选项卡导航已在设置中关闭' : item.label}
            aria-label={item.label}
            aria-pressed={isActive}
          >
            <Icon size={20} strokeWidth={1.7} aria-hidden="true" />
          </button>
        );
      })}
    </nav>

    <button
      className="activity-bar-button activity-bar-settings"
      type="button"
      onClick={onSettings}
      title="设置"
      aria-label="设置"
    >
      <Settings size={20} strokeWidth={1.7} aria-hidden="true" />
    </button>
  </aside>
);
