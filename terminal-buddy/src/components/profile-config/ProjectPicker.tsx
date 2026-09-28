import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { Project } from '../../types';

interface ProjectPickerProps {
  projects: Project[];
  value: string;
  onChange: (name: string) => void;
}

export function ProjectPicker({ projects, value, onChange }: ProjectPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const results = projects.filter(project =>
    `${project.name} ${project.path}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())
  );

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', closeOutside);
    return () => document.removeEventListener('mousedown', closeOutside);
  }, [open]);

  const choose = (name: string) => {
    onChange(name);
    setSearch('');
    setOpen(false);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        setSearch('');
        setActiveIndex(0);
        setOpen(true);
      } else if (results.length) {
        setActiveIndex(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length);
      }
    } else if (event.key === 'Enter' && open) {
      event.preventDefault();
      if (results[activeIndex]) choose(results[activeIndex].name);
    }
  };

  return (
    <div className="project-picker" ref={rootRef} onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }}>
      <input
        role="combobox"
        aria-label="搜索并选择项目"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && results[activeIndex] ? `${listId}-${activeIndex}` : undefined}
        value={open ? search : value}
        placeholder={open ? '搜索项目名称或路径' : '选择项目'}
        onFocus={() => { setSearch(''); setActiveIndex(0); setOpen(true); }}
        onChange={event => { setSearch(event.target.value); setActiveIndex(0); setOpen(true); }}
        onKeyDown={handleKeyDown}
      />
      {open && (
        <div id={listId} className="project-picker-list" role="listbox" aria-label="项目列表">
          {results.length ? results.map((project, index) => (
            <button
              key={project.name}
              id={`${listId}-${index}`}
              type="button"
              role="option"
              aria-selected={project.name === value}
              className={`project-picker-option ${index === activeIndex ? 'active' : ''}`}
              onMouseEnter={() => setActiveIndex(index)}
              onMouseDown={event => event.preventDefault()}
              onClick={() => choose(project.name)}
            >
              <span>{project.name}</span>
              <small title={project.path}>{project.path}</small>
            </button>
          )) : <div className="project-picker-empty">没有匹配的项目</div>}
        </div>
      )}
    </div>
  );
}
