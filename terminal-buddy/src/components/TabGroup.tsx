import { FC, useState, useRef } from 'react';
import type { TabGroup as TabGroupType } from '../types';
import './TabGroup.css';

interface TabGroupProps {
  group: TabGroupType;
  onToggleCollapse: () => void;
  onRename: (name: string) => void;
  onContextMenu: (e: React.MouseEvent, groupId: string) => void;
}

export const TabGroupHeader: FC<TabGroupProps> = ({
  group,
  onToggleCollapse,
  onRename,
  onContextMenu,
}) => {
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(group.name);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDoubleClick = () => {
    if (group.id === 'default') return;
    setRenameValue(group.name);
    setIsRenaming(true);
    setTimeout(() => inputRef.current?.select(), 0);
  };

  const finishRename = () => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== group.name) {
      onRename(trimmed);
    }
    setIsRenaming(false);
  };

  return (
    <div
      className="tab-group-header"
      onClick={onToggleCollapse}
      onDoubleClick={handleDoubleClick}
      onContextMenu={(e) => onContextMenu(e, group.id)}
    >
      <span className={`tab-group-collapse ${group.collapsed ? 'collapsed' : ''}`}>
        ▼
      </span>
      {group.color && (
        <span className="tab-group-color" style={{ backgroundColor: group.color }} />
      )}
      {isRenaming ? (
        <input
          ref={inputRef}
          className="tab-group-rename-input"
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={finishRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') finishRename();
            else if (e.key === 'Escape') setIsRenaming(false);
          }}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span className="tab-group-name">{group.name}</span>
      )}
    </div>
  );
};
