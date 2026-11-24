import { useRef } from 'react';
import { GripVertical, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { CODEX_EFFORT_OPTIONS } from '../../services/tauri/codexProviders';
import { ModelCombobox } from '../shared/ModelCombobox';
import { useDragReorder } from '../shared/useDragReorder';

const buttonClass = 'claude-segment-btn';
const descriptionClass = 'codex-provider-description';

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
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const rowKeySeed = useRef(0);
  const newRowKey = () => `codex-model-row-${++rowKeySeed.current}`;
  const rowKeysRef = useRef<string[]>(selected.map(() => newRowKey()));
  if (rowKeysRef.current.length !== selected.length) {
    const resized = rowKeysRef.current.slice(0, selected.length);
    while (resized.length < selected.length) resized.push(newRowKey());
    rowKeysRef.current = resized;
  }

  const update = (next: string[], preferred = defaultModel, efforts = reasoningEfforts) => {
    const ids = next.map(id => id.trim()).filter(Boolean);
    onChange(next, ids.includes(preferred) ? preferred : ids[0] ?? '', efforts);
  };
  const { containerRef, startDrag, dragClass } = useDragReorder((from, to) => {
    const nextKeys = [...rowKeysRef.current];
    const [movedKey] = nextKeys.splice(from, 1);
    if (movedKey) {
      nextKeys.splice(to, 0, movedKey);
      rowKeysRef.current = nextKeys;
    }
    const next = [...selected];
    const [moved] = next.splice(from, 1);
    if (moved === undefined) return;
    next.splice(to, 0, moved);
    // 推理等级与行一一对应，重排时同步搬移，避免等级错位。
    const efforts = selected.map((_, index) => reasoningEfforts[index] ?? 'max');
    const [movedEffort] = efforts.splice(from, 1);
    efforts.splice(to, 0, movedEffort ?? 'max');
    update(next, defaultModel, efforts);
  });
  const changeRow = (index: number, value: string) => {
    const next = selected.map((id, i) => i === index ? value : id);
    update(next, selected[index].trim() === defaultModel ? value.trim() : defaultModel);
  };
  const addRow = () => {
    rowKeysRef.current = [...rowKeysRef.current, newRowKey()];
    update([...selected, ''], defaultModel, [...reasoningEfforts, 'max']);
    requestAnimationFrame(() => inputRefs.current[selected.length]?.focus());
  };

  return (
    <div className="codex-model-picker">
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
      {selected.length > 0 && <div className="codex-model-list" ref={containerRef}>
        {selected.map((id, index) => (
          <div className={`codex-model-entry model-drag-row${dragClass(index)}`} key={rowKeysRef.current[index] ?? index} data-drag-index={index}>
            <div className="codex-model-input-row">
              <span className="model-drag-handle" role="button" tabIndex={0} title="拖拽排序"
                aria-label={`拖拽排序模型 ${index + 1}`}
                onPointerDown={event => startDrag(event, index)}>
                <GripVertical size={14} aria-hidden="true" />
              </span>
              <ModelCombobox
                value={id}
                options={models}
                onChange={value => changeRow(index, value)}
                ariaLabel={`模型 ID ${index + 1}`}
                disabled={disabled}
                inputRef={element => { inputRefs.current[index] = element; }}
              />
              <select className="codex-model-effort" aria-label={`模型推理等级 ${index + 1}`} title="推理等级"
                value={reasoningEfforts[index] ?? 'max'} disabled={disabled}
                onChange={event => update(selected, defaultModel, selected.map((_, i) => i === index ? event.target.value : reasoningEfforts[i] ?? 'max'))}>
                {CODEX_EFFORT_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
              <button type="button" className={`${buttonClass}${id.trim() && defaultModel === id.trim() ? ' active' : ''}`}
                disabled={disabled || !id.trim() || defaultModel === id.trim()} onClick={() => update(selected, id.trim())}>
                {id.trim() && defaultModel === id.trim() ? '默认模型' : '设为默认'}
              </button>
              <button type="button" className={`${buttonClass} danger`} disabled={disabled} aria-label={`删除模型 ${index + 1}`}
                onClick={() => {
                  rowKeysRef.current = rowKeysRef.current.filter((_, i) => i !== index);
                  update(selected.filter((_, i) => i !== index), defaultModel, reasoningEfforts.filter((_, i) => i !== index));
                }}><Trash2 size={14} /></button>
            </div>
          </div>
        ))}
      </div>}
      {!selected.length && <p className={descriptionClass}>点击“添加模型”新增一行，可手动输入或从候选中选择。</p>}
      <p className={descriptionClass}>已配置 {new Set(selected.map(id => id.trim()).filter(Boolean)).size} 个模型 · 候选列表 {models.length} 个。每个模型可单独设置推理等级，新增默认 MAX。保存供应商后生效；默认模型用于常规启动。</p>
    </div>
  );
}
