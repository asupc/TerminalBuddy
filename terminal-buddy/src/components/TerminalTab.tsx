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
  onCloseOthers: () => void;
  onCloseLeft: () => void;
  onCloseRight: () => void;
  onCloseAll: () => void;
  onRename: (name: string) => void;
  onChangeColor: (color: string) => void;
}

export const TerminalTab: FC<TerminalTabProps> = ({
  name,
  isActive,
  color,
  onClick,
  onClose,
  onCloseOthers,
  onCloseLeft,
  onCloseRight,
  onCloseAll,
  onRename,
  onChangeColor,
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
        style={isActive && color ? { borderBottomColor: color } : undefined}
        onClick={onClick}
        onContextMenu={handleContextMenu}
        onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onClose(); } }}
        onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
      >
        <span className="tab-color-indicator" style={color ? { backgroundColor: color } : undefined} />
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
            <div className="context-menu-item" onClick={() => { setShowContextMenu(false); setShowColorPicker(false); onCloseOthers(); }}>
              关闭其他
            </div>
            <div className="context-menu-item" onClick={() => { setShowContextMenu(false); setShowColorPicker(false); onCloseLeft(); }}>
              关闭左侧
            </div>
            <div className="context-menu-item" onClick={() => { setShowContextMenu(false); setShowColorPicker(false); onCloseRight(); }}>
              关闭右侧
            </div>
            <div className="context-menu-item" onClick={() => { setShowContextMenu(false); setShowColorPicker(false); onCloseAll(); }}>
              关闭全部
            </div>
          </div>
        </>
      )}
    </>
  );
};
