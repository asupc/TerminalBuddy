import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronDown } from 'lucide-react';
import './ModelCombobox.css';

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
  const rootRef = useRef<HTMLDivElement>(null);
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
        <div id={listId} className="model-combobox-list" role="listbox" aria-label="候选模型">
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
