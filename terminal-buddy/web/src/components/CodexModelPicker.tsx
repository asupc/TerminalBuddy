import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { CODEX_EFFORT_OPTIONS } from '../utils/codexLaunch';

const buttonClass = 'btn';
const descriptionClass = 'provider-description';

export function CodexModelPicker({ models, selected, reasoningEfforts, defaultModel, disabled, refreshing, onRefresh, onChange }: {
  models: string[];
  selected: string[];
  reasoningEfforts: string[];
  defaultModel: string;
  disabled: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  onChange: (selected: string[], defaultModel: string, reasoningEfforts: string[]) => void;
}) {
  const [expanded, setExpanded] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const pickerRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEffect(() => {
    if (expanded === null) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !pickerRef.current?.contains(event.target as Node)) return;
      // 先关闭列表，避免外层弹窗同时处理 Escape 而丢失编辑内容。
      event.preventDefault();
      event.stopPropagation();
      setExpanded(null);
      inputRefs.current[expanded]?.focus();
    };
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!pickerRef.current) return;
      const entry = pickerRef.current.querySelectorAll('.codex-model-entry')[expanded];
      if (!entry?.contains(event.target as Node)) setExpanded(null);
    };
    window.addEventListener('keydown', closeOnEscape, true);
    // 等点击完成后收起，避免列表高度变化让底部按钮在按下时移动。
    document.addEventListener('click', closeOnOutsideClick);
    return () => {
      window.removeEventListener('keydown', closeOnEscape, true);
      document.removeEventListener('click', closeOnOutsideClick);
    };
  }, [expanded]);
  const visible = models.filter(id => id.toLowerCase().includes(query.trim().toLowerCase()));
  const configured = selected.map(id => id.trim()).filter(Boolean);

  const update = (next: string[], preferred = defaultModel, efforts = reasoningEfforts) => {
    const ids = next.map(id => id.trim()).filter(Boolean);
    onChange(next, ids.includes(preferred) ? preferred : ids[0] ?? '', efforts);
  };
  const changeRow = (index: number, value: string) => {
    const next = selected.map((id, i) => i === index ? value : id);
    update(next, selected[index].trim() === defaultModel ? value.trim() : defaultModel);
  };
  const addRow = () => {
    update([...selected, ''], defaultModel, [...reasoningEfforts, 'max']);
    setExpanded(null);
    requestAnimationFrame(() => inputRefs.current[selected.length]?.focus());
  };

  return (
    <div className="codex-model-picker" ref={pickerRef}>
      <div className="codex-model-picker-heading">
        <strong>模型配置</strong>
        <div className="codex-model-picker-tools">
          <button type="button" className={buttonClass} disabled={disabled} onClick={onRefresh}>
            <RefreshCw size={14} />{refreshing ? '更新中…' : '更新模型列表'}
          </button>
          <button type="button" className={buttonClass} disabled={disabled || selected.length >= 200} onClick={addRow}>
            <Plus size={14} />添加模型
          </button>
        </div>
      </div>
      {selected.map((id, index) => (
        <div className="codex-model-entry" key={index}
          onKeyDown={event => {
            if (event.key !== 'Tab') return;
            const entry = event.currentTarget;
            requestAnimationFrame(() => {
              if (!entry.contains(document.activeElement)) setExpanded(current => current === index ? null : current);
            });
          }}>
          <div className="codex-model-input-row">
            <input ref={element => { inputRefs.current[index] = element; }} aria-label={`模型 ID ${index + 1}`}
              value={id} disabled={disabled} maxLength={256} autoComplete="off" autoCapitalize="none" spellCheck={false}
              placeholder="输入模型 ID，或从右侧列表选择" onChange={event => changeRow(index, event.target.value)}
              onKeyDown={event => { if (event.key === 'Enter') event.preventDefault(); }} />
            <select className="codex-model-effort" aria-label={`模型推理等级 ${index + 1}`} title="推理等级"
              value={reasoningEfforts[index] ?? 'max'} disabled={disabled}
              onChange={event => update(selected, defaultModel, selected.map((_, i) => i === index ? event.target.value : reasoningEfforts[i] ?? 'max'))}>
              {CODEX_EFFORT_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            <button type="button" className={buttonClass} disabled={disabled} aria-label={`展开模型列表 ${index + 1}`}
              aria-expanded={expanded === index} aria-controls={`${listId}-${index}`} onClick={() => {
                setExpanded(expanded === index ? null : index); setQuery('');
              }}><ChevronDown size={14} /><span>模型列表</span></button>
            <button type="button" className={`${buttonClass}${id.trim() && defaultModel === id.trim() ? ' active' : ''}`}
              disabled={disabled || !id.trim() || defaultModel === id.trim()} onClick={() => update(selected, id.trim())}>
              {id.trim() && defaultModel === id.trim() ? '默认模型' : '设为默认'}
            </button>
            <button type="button" className={`${buttonClass} danger`} disabled={disabled} aria-label={`删除模型 ${index + 1}`}
              onClick={() => { update(selected.filter((_, i) => i !== index), defaultModel, reasoningEfforts.filter((_, i) => i !== index)); setExpanded(null); }}><Trash2 size={14} /></button>
          </div>
          {expanded === index && <div className="codex-model-dropdown" id={`${listId}-${index}`}>
            <input aria-label={`搜索模型 ${index + 1}`} value={query} disabled={disabled} placeholder="搜索已保存的模型…"
              onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') event.preventDefault(); }} />
            <div className="codex-model-picker-list" role="listbox" aria-label="已保存的模型列表">
              {visible.map(model => {
                const used = selected.some((value, i) => i !== index && value.trim() === model);
                return <button key={model} type="button" role="option" aria-selected={id.trim() === model}
                  disabled={disabled || used} title={model} onClick={() => {
                    changeRow(index, model); setExpanded(null); inputRefs.current[index]?.focus();
                  }}><span>{model}</span>{used && <small>已添加</small>}</button>;
              })}
              {!visible.length && <p className={descriptionClass}>{models.length ? '没有匹配的模型' : '暂无已保存的模型，请先点击“更新模型列表”，也可直接输入模型 ID。'}</p>}
            </div>
          </div>}
        </div>
      ))}
      {!selected.length && <p className={descriptionClass}>点击“添加模型”新增一行，可手动输入或从模型列表中选择。</p>}
      <p className={descriptionClass}>已配置 {new Set(configured).size} 个模型 · 已保存列表 {models.length} 个。选择后立即填入当前行，每个模型可单独设置推理等级，新增默认 MAX。保存供应商后生效；默认模型用于常规启动。</p>
    </div>
  );
}
