import { FC, ReactNode } from 'react';
import './TreeView.css';

export interface TreeItem {
  id: string;
  label: string;
  icon?: ReactNode;
  color?: string;
  isGroup?: boolean;
  children?: TreeItem[];
  data?: unknown;
}

interface TreeViewProps {
  items: TreeItem[];
  expandedIds: Set<string>;
  onToggle: (id: string) => void;
  selectedId?: string | null;
  onSelect?: (item: TreeItem) => void;
  onDoubleClick?: (item: TreeItem) => void;
  onContextMenu?: (e: React.MouseEvent, item: TreeItem) => void;
  renderEnd?: (item: TreeItem) => ReactNode;
  searchQuery?: string;
  indent?: number;
  className?: string;
  itemClassName?: string;
  renamingId?: string | null;
  renameValue?: string;
  onRenameValueChange?: (value: string) => void;
  onRenameSubmit?: (id: string) => void;
  onRenameCancel?: () => void;
  onGroupRename?: (id: string) => void;
  renamingProfileId?: string | null;
  renamingProfileValue?: string;
  onRenamingProfileChange?: (value: string) => void;
  onRenamingProfileSubmit?: () => void;
  onRenamingProfileCancel?: () => void;
  itemDraggable?: boolean;
  onItemDragStart?: (e: React.DragEvent, item: TreeItem) => void;
  onItemDragEnd?: (e: React.DragEvent, item: TreeItem) => void;
}

const TreeNode: FC<{
  item: TreeItem;
  depth: number;
  expandedIds: Set<string>;
  onToggle: (id: string) => void;
  selectedId?: string | null;
  onSelect?: (item: TreeItem) => void;
  onDoubleClick?: (item: TreeItem) => void;
  onContextMenu?: (e: React.MouseEvent, item: TreeItem) => void;
  renderEnd?: (item: TreeItem) => ReactNode;
  indent: number;
  itemClassName?: string;
  renamingId?: string | null;
  renameValue?: string;
  onRenameValueChange?: (value: string) => void;
  onRenameSubmit?: (id: string) => void;
  onRenameCancel?: () => void;
  onGroupRename?: (id: string) => void;
  renamingProfileId?: string | null;
  renamingProfileValue?: string;
  onRenamingProfileChange?: (value: string) => void;
  onRenamingProfileSubmit?: () => void;
  onRenamingProfileCancel?: () => void;
  itemDraggable?: boolean;
  onItemDragStart?: (e: React.DragEvent, item: TreeItem) => void;
  onItemDragEnd?: (e: React.DragEvent, item: TreeItem) => void;
}> = ({ item, depth, expandedIds, onToggle, selectedId, onSelect, onDoubleClick, onContextMenu, renderEnd, indent, itemClassName, renamingId, renameValue, onRenameValueChange, onRenameSubmit, onRenameCancel, onGroupRename, renamingProfileId, renamingProfileValue, onRenamingProfileChange, onRenamingProfileSubmit, onRenamingProfileCancel, itemDraggable, onItemDragStart, onItemDragEnd }) => {
  const isExpanded = expandedIds.has(item.id);
  const isSelected = selectedId === item.id;
  const hasChildren = item.children && item.children.length > 0;
  const isGroup = item.isGroup || hasChildren;
  const isRenamingProfile = renamingProfileId === item.id;

  return (
    <div className="tree-node">
      <div
        className={`tree-item${isGroup ? ' tree-item-group' : ''}${isSelected ? ' selected' : ''}${itemClassName ? ` ${itemClassName}` : ''}`}
        style={{ paddingLeft: `${depth * indent + 8}px` }}
        onClick={() => {
          onSelect?.(item);
          if (isGroup) onToggle(item.id);
        }}
        onDoubleClick={() => {
          if (renamingId === item.id || renamingProfileId === item.id) return;
          onDoubleClick?.(item);
        }}
        onContextMenu={(e) => onContextMenu?.(e, item)}
        draggable={itemDraggable && !!item.data && !isGroup}
        onDragStart={itemDraggable && onItemDragStart ? (e) => onItemDragStart(e, item) : undefined}
        onDragEnd={itemDraggable && onItemDragEnd ? (e) => onItemDragEnd(e, item) : undefined}
      >
        {isGroup && (
          <span
            className={`tree-arrow${isExpanded ? ' expanded' : ''}`}
            onClick={(e) => { e.stopPropagation(); onToggle(item.id); }}
          >
            ▶
          </span>
        )}
        {item.icon && <span className="tree-icon">{item.icon}</span>}
        {renamingId === item.id ? (
          <input
            className="tree-rename-input"
            value={renameValue ?? item.label}
            onChange={(e) => onRenameValueChange?.(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') onRenameSubmit?.(item.id);
              if (e.key === 'Escape') onRenameCancel?.();
            }}
            onBlur={() => onRenameSubmit?.(item.id)}
            onClick={(e) => e.stopPropagation()}
            autoFocus
          />
        ) : isRenamingProfile ? (
          <input
            className="tree-rename-input"
            value={renamingProfileValue ?? item.label}
            onChange={(e) => onRenamingProfileChange?.(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') onRenamingProfileSubmit?.();
              if (e.key === 'Escape') onRenamingProfileCancel?.();
            }}
            onBlur={() => onRenamingProfileSubmit?.()}
            onClick={(e) => e.stopPropagation()}
            autoFocus
          />
        ) : (
          <span className="tree-name" style={item.color ? { color: item.color } : undefined}>
            {item.label}
          </span>
        )}
        {renderEnd?.(item)}
      </div>
      {isExpanded && hasChildren && (
        <div className="tree-children">
          {item.children!.map((child) => (
            <TreeNode
              key={child.id}
              item={child}
              depth={depth + 1}
              expandedIds={expandedIds}
              onToggle={onToggle}
              selectedId={selectedId}
              onSelect={onSelect}
              onDoubleClick={onDoubleClick}
              onContextMenu={onContextMenu}
              renderEnd={renderEnd}
              indent={indent}
              itemClassName={itemClassName}
              renamingId={renamingId}
              renameValue={renameValue}
              onRenameValueChange={onRenameValueChange}
              onRenameSubmit={onRenameSubmit}
              onRenameCancel={onRenameCancel}
              onGroupRename={onGroupRename}
              renamingProfileId={renamingProfileId}
              renamingProfileValue={renamingProfileValue}
              onRenamingProfileChange={onRenamingProfileChange}
              onRenamingProfileSubmit={onRenamingProfileSubmit}
              onRenamingProfileCancel={onRenamingProfileCancel}
              itemDraggable={itemDraggable}
              onItemDragStart={onItemDragStart}
              onItemDragEnd={onItemDragEnd}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export const TreeView: FC<TreeViewProps> = ({
  items,
  expandedIds,
  onToggle,
  selectedId,
  onSelect,
  onDoubleClick,
  onContextMenu,
  renderEnd,
  indent = 14,
  className,
  itemClassName,
  renamingId,
  renameValue,
  onRenameValueChange,
  onRenameSubmit,
  onRenameCancel,
  onGroupRename,
  renamingProfileId,
  renamingProfileValue,
  onRenamingProfileChange,
  onRenamingProfileSubmit,
  onRenamingProfileCancel,
  itemDraggable,
  onItemDragStart,
  onItemDragEnd,
}) => {
  return (
    <div className={className} tabIndex={0} onKeyDown={(e) => {
      if (e.key === 'F2' && selectedId) {
        const selectedItem = findItemById(items, selectedId);
        if (selectedItem && (selectedItem.isGroup || (selectedItem.children && selectedItem.children.length > 0))) {
          e.preventDefault();
          onGroupRename?.(selectedId);
        }
      }
    }}>
      {items.map((item) => (
        <TreeNode
          key={item.id}
          item={item}
          depth={0}
          expandedIds={expandedIds}
          onToggle={onToggle}
          selectedId={selectedId}
          onSelect={onSelect}
          onDoubleClick={onDoubleClick}
          onContextMenu={onContextMenu}
          renderEnd={renderEnd}
          indent={indent}
          itemClassName={itemClassName}
          renamingId={renamingId}
          renameValue={renameValue}
          onRenameValueChange={onRenameValueChange}
          onRenameSubmit={onRenameSubmit}
          onRenameCancel={onRenameCancel}
          onGroupRename={onGroupRename}
          renamingProfileId={renamingProfileId}
          renamingProfileValue={renamingProfileValue}
          onRenamingProfileChange={onRenamingProfileChange}
          onRenamingProfileSubmit={onRenamingProfileSubmit}
          onRenamingProfileCancel={onRenamingProfileCancel}
          itemDraggable={itemDraggable}
          onItemDragStart={onItemDragStart}
          onItemDragEnd={onItemDragEnd}
        />
      ))}
    </div>
  );
};

function findItemById(items: TreeItem[], id: string): TreeItem | null {
  for (const item of items) {
    if (item.id === id) return item;
    if (item.children) {
      const found = findItemById(item.children, id);
      if (found) return found;
    }
  }
  return null;
}
