import { FC, useState, useRef, useEffect } from 'react';
import { TAB_COLORS } from '../types';
import './TerminalTab.css';

interface TerminalTabProps {
  id: string;
  name: string;
  isActive: boolean;
  color: string;
  onClick: () => void;
  onClose: () => void;
  onCloseAll: () => void;
  onRename: (name: string) => void;
  onChangeColor: (color: string) => void;
  onMoveToGroup: (groupId: string) => void;
  groups: { id: string; name: string }[];
}

export const TerminalTab: FC<TerminalTabProps> = ({
  name,
  isActive,
  color,
  onClick,
  onClose,
  onCloseAll,
  onRename,
  onChangeColor,
  onMoveToGroup,
  groups,
}) => {
  const [showContextMenu, setShowContextMenu] = useState(false);
  const [contextMenuPos, setContextMenuPos] = useState({ x: 0, y: 0 });
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(name);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const colorPickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isRenaming && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isRenaming]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (colorPickerRef.current && !colorPickerRef.current.contains(e.target as Node)) {
        setShowColorPicker(false);
      }
    };
    if (showColorPicker) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showColorPicker]);

  useEffect(() => {
    if (!showContextMenu) return;
    const handleClick = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('.context-menu')) return;
      setShowContextMenu(false);
      setShowColorPicker(false);
    };
    const handleKeyDown = () => {
      setShowContextMenu(false);
      setShowColorPicker(false);
    };
    const handleScroll = () => {
      setShowContextMenu(false);
      setShowColorPicker(false);
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('wheel', handleScroll);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('wheel', handleScroll);
    };
  }, [showContextMenu]);

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setShowContextMenu(true);
    setContextMenuPos({ x: e.clientX, y: e.clientY });
  };

  const handleRename = () => {
    setShowContextMenu(false);
    setIsRenaming(true);
    setRenameValue(name);
  };

  const finishRename = () => {
    if (renameValue.trim() && renameValue !== name) {
      onRename(renameValue.trim());
    }
    setIsRenaming(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      finishRename();
    } else if (e.key === 'Escape') {
      setIsRenaming(false);
    }
  };

  const handleColorChange = (newColor: string | null) => {
    onChangeColor(newColor || '');
    setShowColorPicker(false);
    setShowContextMenu(false);
  };

  // tabColor is used as text color; empty/'' means theme default
  const tabTextColor = color || undefined;

  return (
    <>
      <div
        className={`terminal-tab ${isActive ? 'active' : ''}`}
        style={isActive && color ? { borderBottomColor: color, borderLeftColor: color } : undefined}
        onClick={onClick}
        onContextMenu={handleContextMenu}
        onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onClose(); } }}
        onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
      >
        <span className="tab-color-indicator" style={{ backgroundColor: color || 'var(--accent)' }} />
        {isRenaming ? (
          <input
            ref={inputRef}
            className="tab-rename-input"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={finishRename}
            onKeyDown={handleKeyDown}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="tab-name" style={tabTextColor ? { color: tabTextColor } : undefined}>{name}</span>
        )}
        <span className="tab-close" onClick={(e) => { e.stopPropagation(); onClose(); }}>
          ×
        </span>
      </div>

      {showContextMenu && (
        <>
          <div
            className="context-menu-overlay"
            onClick={() => { setShowContextMenu(false); setShowColorPicker(false); }}
          />
          <div
            className="context-menu"
            style={{ left: contextMenuPos.x, top: contextMenuPos.y }}
          >
            <div className="context-menu-item" onClick={handleRename}>
              重命名
            </div>
            <div className="context-menu-item color-menu-item" onClick={() => setShowColorPicker(true)}>
              <span>更改颜色</span>
              <span className="color-menu-arrow">▶</span>
              {showColorPicker && (
                <div ref={colorPickerRef} className="color-picker-submenu">
                  <div
                    className={`color-picker-item ${!color ? 'selected' : ''}`}
                    onClick={(e) => { e.stopPropagation(); handleColorChange(null); }}
                  >
                    <span className="color-dot color-dot-theme" />
                    <span>跟随主题</span>
                  </div>
                  {TAB_COLORS.filter(Boolean).map((c) => c && (
                    <div
                      key={c.id}
                      className={`color-picker-item ${color === c.color ? 'selected' : ''}`}
                      onClick={(e) => { e.stopPropagation(); handleColorChange(c.color); }}
                    >
                      <span className="color-dot" style={{ backgroundColor: c.color }} />
                      <span style={{ color: c.color }}>{c.name}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="context-menu-item danger" onClick={() => { setShowContextMenu(false); setShowColorPicker(false); onClose(); }}>
              关闭
            </div>
            <div className="context-menu-separator" />
            <div className="context-menu-item has-submenu">
              <span>移动到组</span>
              <span className="color-menu-arrow">▶</span>
              <div className="context-submenu">
                {groups.map((g) => (
                  <div
                    key={g.id}
                    className="context-menu-item"
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowContextMenu(false);
                      setShowColorPicker(false);
                      onMoveToGroup(g.id);
                    }}
                  >
                    {g.name}
                  </div>
                ))}
              </div>
            </div>
            <div className="context-menu-separator" />
            <div className="context-menu-item" onClick={() => { setShowContextMenu(false); setShowColorPicker(false); onCloseAll(); }}>
              关闭全部
            </div>
          </div>
        </>
      )}
    </>
  );
};
