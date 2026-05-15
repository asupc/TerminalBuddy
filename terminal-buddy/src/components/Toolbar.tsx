import { FC, useState, useRef, useEffect } from 'react';
import './Toolbar.css';
import { useAppStore } from '../stores/appStore';
import type { Profile } from '../types';

interface ToolbarProps {
  onNew: () => void;
  onImport: () => void;
  onExport: () => void;
  onSettings: () => void;
  onNewPowershell: () => void;
  onNewCmd: () => void;
  onStartTerminal: (profile: Profile) => void;
}

export const Toolbar: FC<ToolbarProps> = ({
  onNew,
  onImport,
  onExport,
  onSettings,
  onNewPowershell,
  onNewCmd,
  onStartTerminal,
}) => {
  const { profiles } = useAppStore();
  const [showNewMenu, setShowNewMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowNewMenu(false);
      }
    };
    if (showNewMenu) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showNewMenu]);

  return (
    <div className="toolbar">
      <button className="toolbar-btn" onClick={onNew} title="添加配置">
        <span className="toolbar-icon">📋</span>添加配置
      </button>
      <div className="toolbar-dropdown" ref={menuRef}>
        <button className="toolbar-btn toolbar-dropdown-btn" onClick={() => setShowNewMenu(!showNewMenu)}>
          <span className="toolbar-icon">⌨</span>新建 ▼
        </button>
        {showNewMenu && (
          <div className="toolbar-dropdown-content">
            <button className="toolbar-dropdown-item" onClick={() => { setShowNewMenu(false); onNewPowershell(); }}>
              PowerShell
            </button>
            <button className="toolbar-dropdown-item" onClick={() => { setShowNewMenu(false); onNewCmd(); }}>
              CMD
            </button>
            {profiles.length > 0 && <div className="toolbar-dropdown-divider" />}
            {profiles.map((profile) => (
              <button
                key={profile.id}
                className="toolbar-dropdown-item"
                onClick={() => { setShowNewMenu(false); onStartTerminal(profile); }}
              >
                <span className="dropdown-item-name">{profile.name}</span>
                <span className="dropdown-item-group">{profile.group || '默认'}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <button className="toolbar-btn" onClick={onImport} title="导入配置">
        <span className="toolbar-icon">📥</span>导入
      </button>
      <button className="toolbar-btn" onClick={onExport} title="导出配置">
        <span className="toolbar-icon">📤</span>导出
      </button>
      <div className="toolbar-spacer" />
      <button className="toolbar-btn" onClick={onSettings} title="设置">
        <span className="toolbar-icon">⚙</span>设置
      </button>
    </div>
  );
};
