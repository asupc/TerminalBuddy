import React, { useState, useRef, useEffect, useMemo } from 'react';
import { extractGroupPaths } from '../utils/groupTree';
import type { Profile } from '../types';
import './GroupCascader.css';

interface GroupCascaderProps {
  value: string;
  onChange: (value: string) => void;
  profiles: Profile[];
}

interface CascaderLevel {
  parentPath: string;
  options: string[];
}

export const GroupCascader: React.FC<GroupCascaderProps> = ({ value, onChange, profiles }) => {
  const [open, setOpen] = useState(false);
  const [levels, setLevels] = useState<CascaderLevel[]>([]);
  const [selectedSegments, setSelectedSegments] = useState<string[]>([]);
  const [newGroupName, setNewGroupName] = useState('');
  const [addingAtLevel, setAddingAtLevel] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const groupPaths = useMemo(() => extractGroupPaths(profiles, p => p.group || '默认'), [profiles]);

  const levelMap = useMemo(() => {
    const map = new Map<string, string[]>();
    map.set('', []);
    for (const path of groupPaths) {
      const segments = path.split('/');
      const parentPath = segments.length > 1 ? segments.slice(0, -1).join('/') : '';
      if (!map.has(parentPath)) map.set(parentPath, []);
      const names = map.get(parentPath)!;
      const name = segments[segments.length - 1];
      if (!names.includes(name)) names.push(name);
    }
    for (const names of map.values()) {
      names.sort((a, b) => a.localeCompare(b, 'zh'));
    }
    return map;
  }, [groupPaths]);

  useEffect(() => {
    if (open) {
      const segs = value && value !== '默认' ? value.split('/') : [];
      const newLevels: CascaderLevel[] = [{ parentPath: '', options: levelMap.get('') || [] }];
      const newSelected: string[] = [];
      for (const seg of segs) {
        newSelected.push(seg);
        const childPath = newSelected.join('/');
        const children = levelMap.get(childPath);
        if (children && children.length > 0) {
          newLevels.push({ parentPath: childPath, options: children });
        }
      }
      setLevels(newLevels);
      setSelectedSegments(segs);
      setAddingAtLevel(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleSelectLevel = (levelIndex: number, name: string) => {
    const newSelected = selectedSegments.slice(0, levelIndex);
    newSelected.push(name);
    setSelectedSegments(newSelected);
    const path = newSelected.join('/');
    onChange(path);
    const children = levelMap.get(path);
    if (children && children.length > 0) {
      const newLevels = levels.slice(0, levelIndex + 1);
      newLevels.push({ parentPath: path, options: children });
      setLevels(newLevels);
    } else {
      setLevels(levels.slice(0, levelIndex + 1));
    }
    setAddingAtLevel(null);
  };

  const handleBreadcrumb = (index: number) => {
    const newSelected = selectedSegments.slice(0, index);
    setSelectedSegments(newSelected);
    onChange(newSelected.join('/') || '默认');
    setLevels(levels.slice(0, index + 1));
    setAddingAtLevel(null);
  };

  const handleAddGroup = (levelIndex: number) => {
    if (!newGroupName.trim()) return;
    handleSelectLevel(levelIndex, newGroupName.trim());
    setNewGroupName('');
    setAddingAtLevel(null);
  };

  const displayValue = value || '默认';

  return (
    <div className="group-cascader" ref={ref}>
      <div className="group-cascader-input" onClick={() => setOpen(!open)}>
        <span>{displayValue}</span>
        <span className="group-cascader-arrow">{open ? '▲' : '▼'}</span>
      </div>

      {open && (
        <div className="group-cascader-panel">
          <div className="group-cascader-breadcrumb">
            <span className={selectedSegments.length === 0 ? 'active' : ''} onClick={() => handleBreadcrumb(0)}>
              根
            </span>
            {selectedSegments.map((seg, i) => (
              <React.Fragment key={i}>
                <span className="separator">/</span>
                <span className={i === selectedSegments.length - 1 ? 'active' : ''} onClick={() => handleBreadcrumb(i + 1)}>
                  {seg}
                </span>
              </React.Fragment>
            ))}
          </div>

          <div className="group-cascader-columns">
            {levels.map((level, li) => (
              <div key={li} className="group-cascader-column">
                {level.options.map(name => {
                  const segs = selectedSegments.slice(0, li);
                  segs.push(name);
                  const path = segs.join('/');
                  const hasChildren = (levelMap.get(path)?.length || 0) > 0;
                  const isSelected = selectedSegments[li] === name;
                  return (
                    <div
                      key={name}
                      className={`group-cascader-option ${isSelected ? 'selected' : ''}`}
                      onClick={() => handleSelectLevel(li, name)}
                    >
                      <span>{name}</span>
                      {hasChildren && <span className="group-cascader-expand">›</span>}
                    </div>
                  );
                })}
                {addingAtLevel === li ? (
                  <div className="group-cascader-new-input">
                    <input
                      autoFocus
                      value={newGroupName}
                      onChange={e => setNewGroupName(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') handleAddGroup(li);
                        if (e.key === 'Escape') setAddingAtLevel(null);
                      }}
                      onBlur={() => { if (!newGroupName.trim()) setAddingAtLevel(null); }}
                      placeholder="分组名称"
                    />
                  </div>
                ) : (
                  <div
                    className="group-cascader-option new"
                    onClick={() => { setAddingAtLevel(li); setNewGroupName(''); }}
                  >
                    + 新建分组
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="group-cascader-footer">
            <button onClick={() => setOpen(false)}>确定</button>
          </div>
        </div>
      )}
    </div>
  );
};
