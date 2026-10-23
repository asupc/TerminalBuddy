import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronDown } from 'lucide-react';
import './ModelCombobox.css';

/** 候选列表的最大高度（px）：只显示部分模型，其余靠搜索或列表内滚动。 */
const LIST_MAX_HEIGHT = 220;
/** 向下/向上弹出的最小可用高度，低于此值优先翻转到空间更大的一侧。 */
const LIST_MIN_HEIGHT = 96;
/** 列表与输入框的间距（与 CSS 中 calc(100% + 4px) 一致），测量可用空间时预留。 */
const LIST_GAP = 4;

interface ModelComboboxProps {
  value: string;
  /** 可搜索的候选模型（拉取的完整列表）；空数组时退化为纯输入。 */
  options: string[];
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
  maxLength?: number;
  /** 暴露内部输入框（新增行后聚焦）。 */
  inputRef?: (element: HTMLInputElement | null) => void;
}

/**
 * 模型 ID 可搜索下拉：输入即过滤候选并同步为值（自由输入语义），
 * Enter 选中高亮项，无高亮时保留输入。基于 ProjectPicker 的 combobox 规范改造。
 */
export function ModelCombobox({
  value, options, onChange, placeholder = '搜索或输入模型 ID', ariaLabel = '模型 ID', disabled, maxLength = 256, inputRef,
}: ModelComboboxProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  // 下拉弹出方向与限高：默认向下，最近裁切容器（弹窗 body 等）空间不足时翻转到上方。
  const [placement, setPlacement] = useState<'below' | 'above'>('below');
  const [listMaxHeight, setListMaxHeight] = useState(LIST_MAX_HEIGHT);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const query = value.trim().toLowerCase();
  const results = query
    ? options.filter(id => id.toLowerCase().includes(query))
    : options;
  // 即使候选为空也展示列表：空态提示用户先「获取模型列表」，而不是像纯文本框。
  const showList = open;

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', closeOutside);
    return () => document.removeEventListener('mousedown', closeOutside);
  }, [open]);

  // 打开时按最近裁切容器的可视空间决定弹出方向，并把高度限制在可视空间内：
  // 列表只显示部分候选且在内部滚动，不会被弹窗底边遮住，也不会把弹窗撑出滚动条。
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const root = rootRef.current;
      if (!root) return;
      let clip: HTMLElement | null = root.parentElement;
      while (clip && clip !== document.body && getComputedStyle(clip).overflowY === 'visible') {
        clip = clip.parentElement;
      }
      const bounds = clip && clip !== document.body
        ? clip.getBoundingClientRect()
        : { top: 0, bottom: window.innerHeight };
      const rect = root.getBoundingClientRect();
      const spaceBelow = bounds.bottom - rect.bottom - LIST_GAP;
      const spaceAbove = rect.top - bounds.top - LIST_GAP;
      const next = spaceBelow >= LIST_MIN_HEIGHT || spaceBelow >= spaceAbove ? 'below' : 'above';
      const space = next === 'below' ? spaceBelow : spaceAbove;
      setPlacement(next);
      setListMaxHeight(Math.min(LIST_MAX_HEIGHT, Math.max(LIST_MIN_HEIGHT, space)));
    };
    measure();
    window.addEventListener('resize', measure);
    document.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      document.removeEventListener('scroll', measure, true);
    };
  }, [open]);

  // 空间极端不足（限高触底）时把列表滚入可视区，尽量完整露出。
  useLayoutEffect(() => {
    if (!open) return;
    listRef.current?.scrollIntoView({ block: 'nearest' });
  }, [open, placement, listMaxHeight]);

  const choose = (id: string) => {
    onChange(id);
    setActiveIndex(0);
    setOpen(false);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape' && open) {
      // 先关闭列表，避免外层弹窗同时处理 Escape 而丢失编辑内容。
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!results.length) return;
      event.preventDefault();
      setOpen(true);
      setActiveIndex(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length);
    } else if (event.key === 'Enter') {
      // 有高亮项则选中，否则保留当前输入（自由输入）。
      event.preventDefault();
      if (showList && results[activeIndex]) choose(results[activeIndex]);
      else setOpen(false);
    }
  };

  return (
    <div className="model-combobox" ref={rootRef} onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }}>
      <input
        ref={inputRef}
        role="combobox"

        aria-label={ariaLabel}
        aria-autocomplete="list"
        aria-expanded={showList}
        aria-controls={listId}
        aria-activedescendant={showList && results[activeIndex] ? `${listId}-${activeIndex}` : undefined}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        maxLength={maxLength}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        onFocus={() => { setActiveIndex(0); setOpen(true); }}
        onChange={event => { onChange(event.target.value); setActiveIndex(0); setOpen(true); }}
        onKeyDown={handleKeyDown}
      />
      <button
        type="button"
        className={`model-combobox-toggle${showList ? ' open' : ''}`}
        tabIndex={-1}
        disabled={disabled}
        aria-label={showList ? '收起候选模型' : '展开候选模型'}
        onMouseDown={event => event.preventDefault()}
        onClick={() => { setActiveIndex(0); setOpen(current => !current); }}
      >
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {showList && (
        <div
          id={listId}
          ref={listRef}
          className={`model-combobox-list${placement === 'above' ? ' above' : ''}`}
          style={{ maxHeight: listMaxHeight }}
          role="listbox"
          aria-label="候选模型"
        >
          {results.length ? results.slice(0, 60).map((id, index) => (
            <button
              key={id}
              id={`${listId}-${index}`}
              type="button"
              role="option"
              aria-selected={id === value}
              className={index === activeIndex ? 'active' : ''}
              disabled={disabled}
              onMouseEnter={() => setActiveIndex(index)}
              onMouseDown={event => event.preventDefault()}
              onClick={() => choose(id)}
              title={id}
            >
              <span>{id}</span>
            </button>
          )) : (
            <div className="model-combobox-empty" role="status">
              {options.length ? '没有匹配的模型' : '暂无候选模型，请先获取模型列表，或直接输入模型 ID'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
