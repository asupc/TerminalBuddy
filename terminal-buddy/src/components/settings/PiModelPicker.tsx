import { useRef, useState } from 'react';
import { GripVertical, Plus, RefreshCw, Trash2, ChevronDown } from 'lucide-react';
import { PI_THINKING_LEVELS, emptyPiModel, type PiModelConfig } from '../../services/tauri/piProviders';
import { ModelCombobox } from '../shared/ModelCombobox';
import { useDragReorder } from '../shared/useDragReorder';

const buttonClass = 'claude-segment-btn';
const descriptionClass = 'pi-provider-description';

const tokenCount = (value: string) => Math.min(4294967295, Math.max(0, Math.floor(Number(value) || 0)));

/** 思考档位三态：'' = 跟随 Pi 默认；'null' = 不支持（null）；其他 = 自定义映射值。 */
type LevelChoice = { mode: 'default' | 'unsupported' | 'custom'; value: string };

function choiceFrom(levels: Record<string, string | null>, level: string): LevelChoice {
  if (!(level in levels)) return { mode: 'default', value: '' };
  const mapped = levels[level];
  return mapped === null ? { mode: 'unsupported', value: '' } : { mode: 'custom', value: mapped };
}

function applyChoice(levels: Record<string, string | null>, level: string, choice: LevelChoice): Record<string, string | null> {
  const next = { ...levels };
  if (choice.mode === 'default') delete next[level];
  else if (choice.mode === 'unsupported') next[level] = null;
  else next[level] = choice.value;
  return next;
}

function ThinkingMapEditor({ model, disabled, onChange }: {
  model: PiModelConfig;
  disabled: boolean;
  onChange: (levels: Record<string, string | null>) => void;
}) {
  return (
    <div className="pi-thinking-map">
      <div className="pi-thinking-map-head">思考级别映射 <small>默认跟随 Pi；不支持则该档位不可选</small></div>
      <div className="pi-thinking-map-grid">
        {PI_THINKING_LEVELS.map(level => {
          const choice = choiceFrom(model.thinkingLevelMap.levels, level);
          return (
            <label key={level} className="pi-thinking-row">
              <span className="pi-thinking-level">{level}</span>
              <select
                disabled={disabled}
                value={choice.mode}
                aria-label={`${model.id || '模型'}思考级别 ${level}`}
                onChange={e => {
                  const mode = e.target.value as LevelChoice['mode'];
                  onChange(applyChoice(model.thinkingLevelMap.levels, level,
                    mode === 'custom' ? { mode, value: level } : { mode, value: '' }));
                }}
              >
                <option value="default">跟随默认</option>
                <option value="unsupported">不支持</option>
                <option value="custom">自定义值</option>
              </select>
              {choice.mode === 'custom' && (
                <input
                  disabled={disabled}
                  value={choice.value}
                  maxLength={128}
                  placeholder={level}
                  aria-label={`${model.id || '模型'}思考级别 ${level} 映射值`}
                  onChange={e => onChange(applyChoice(model.thinkingLevelMap.levels, level, { mode: 'custom', value: e.target.value }))}
                />
              )}
            </label>
          );
        })}
      </div>
    </div>
  );
}

function ModelRowEditor({ model, index, candidates, disabled, isDefault, onPatch, onSetDefault, onRemove, onStartDrag }: {
  model: PiModelConfig;
  index: number;
  candidates: string[];
  disabled: boolean;
  isDefault: boolean;
  onPatch: (patch: Partial<PiModelConfig>) => void;
  onSetDefault: () => void;
  onRemove: () => void;
  onStartDrag: (event: React.PointerEvent<HTMLElement>, index: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const configuredLevels = Object.keys(model.thinkingLevelMap.levels).length;
  return (
    <div className="pi-model-entry">
      <div className="pi-model-input-row">
        <span className="model-drag-handle" role="button" tabIndex={0} title="拖拽排序"
          aria-label={`拖拽排序模型 ${index + 1}`}
          onPointerDown={event => onStartDrag(event, index)}>
          <GripVertical size={14} aria-hidden="true" />
        </span>
        <ModelCombobox
          value={model.id}
          options={candidates}
          onChange={value => onPatch({ id: value })}
          ariaLabel={`模型 ID ${index + 1}`}
          disabled={disabled}
          inputRef={element => { inputRef.current = element; }}
        />
        <label className="pi-model-reasoning" title="该模型是否支持思考（reasoning）">
          <input
            type="checkbox"
            checked={model.reasoning}
            disabled={disabled}
            onChange={e => onPatch(e.target.checked
              ? { reasoning: true }
              : { reasoning: false, thinkingLevelMap: { levels: {} }, defaultThinking: null })}
          />
          推理
        </label>
        <button type="button" className={`${buttonClass}${isDefault ? ' active' : ''}`}
          disabled={disabled || !model.id.trim() || isDefault} onClick={onSetDefault}>
          {isDefault ? '默认模型' : '设为默认'}
        </button>
        <button type="button" className={buttonClass} disabled={disabled}
          aria-label={`${expanded ? '收起' : '展开'}模型 ${index + 1} 详细配置`}
          aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          <ChevronDown size={14} style={{ transform: expanded ? 'rotate(180deg)' : undefined }} />
          {expanded ? '收起' : `详细${configuredLevels ? ` · ${configuredLevels} 档映射` : ''}`}
        </button>
        <button type="button" className={`${buttonClass} danger`} disabled={disabled}
          aria-label={`删除模型 ${index + 1}`} onClick={onRemove}><Trash2 size={14} /></button>
      </div>
      {expanded && (
        <div className="pi-model-detail">
          <label className="claude-form-row">显示名称
            <input value={model.name} maxLength={80} disabled={disabled}
              onChange={e => onPatch({ name: e.target.value })}
              placeholder="留空使用模型 ID；也用于 --model 匹配" />
          </label>
          <div className="claude-form-row-inline">
            <label className="claude-form-row">上下文窗口（tokens）
              <input type="number" min={0} max={4294967295} step={1} disabled={disabled}
                value={model.contextWindow || ''} onChange={e => onPatch({ contextWindow: tokenCount(e.target.value) })}
                placeholder="留空使用 Pi 默认" />
            </label>
            <label className="claude-form-row">最大输出（tokens）
              <input type="number" min={0} max={4294967295} step={1} disabled={disabled}
                value={model.maxTokens || ''} onChange={e => onPatch({ maxTokens: tokenCount(e.target.value) })}
                placeholder="留空使用 Pi 默认" />
            </label>
            {model.reasoning && (
              <label className="claude-form-row">默认思考级别
                <select disabled={disabled} value={model.defaultThinking ?? ''}
                  title="右键按模型启动时直接以该级别传入 --thinking；不指定则由 Pi 自行决定"
                  onChange={e => onPatch({ defaultThinking: e.target.value || null })}>
                  <option value="">不指定（跟 Pi 默认）</option>
                  {PI_THINKING_LEVELS.map(level => (
                    <option key={level} value={level}>{level}</option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <label className="pi-provider-checkbox">
            <input type="checkbox" checked={model.imageInput} disabled={disabled}
              onChange={e => onPatch({ imageInput: e.target.checked })} />
            支持图片输入
          </label>
          {model.reasoning && (
            <ThinkingMapEditor model={model} disabled={disabled}
              onChange={levels => onPatch({ thinkingLevelMap: { levels } })} />
          )}
        </div>
      )}
    </div>
  );
}

export function PiModelPicker({ models, selected, defaultModel, disabled, refreshing, onRefresh, onChange }: {
  /** 拉取到的候选列表。 */
  models: string[];
  selected: PiModelConfig[];
  defaultModel: string;
  disabled: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  onChange: (selected: PiModelConfig[], defaultModel: string) => void;
}) {
  const update = (next: PiModelConfig[], preferred = defaultModel) => {
    const ids = next.map(model => model.id.trim()).filter(Boolean);
    onChange(next, ids.includes(preferred) ? preferred : ids[0] ?? '');
  };
  const { containerRef, startDrag, dragClass } = useDragReorder((from, to) => {
    const next = [...selected];
    const [moved] = next.splice(from, 1);
    if (moved === undefined) return;
    next.splice(to, 0, moved);
    update(next);
  });
  const addRow = () => update([...selected, emptyPiModel()]);

  return (
    <div className="pi-model-picker">
      <div className="pi-model-picker-heading">
        <strong>模型配置</strong>
        <div className="pi-model-picker-tools">
          <button type="button" className={buttonClass} disabled={disabled} onClick={onRefresh}>
            <RefreshCw size={14} />{refreshing ? '更新中…' : '更新模型列表'}
          </button>
          <button type="button" className={buttonClass} disabled={disabled || selected.length >= 200} onClick={addRow}>
            <Plus size={14} />添加模型
          </button>
        </div>
      </div>
      {selected.length > 0 && <div className="pi-model-list" ref={containerRef}>
        {selected.map((model, index) => (
          <div className={`model-drag-row${dragClass(index)}`} key={index} data-drag-index={index}>
            <ModelRowEditor
              model={model} index={index} candidates={models} disabled={disabled}
              isDefault={Boolean(model.id.trim()) && defaultModel === model.id.trim()}
              onStartDrag={startDrag}
              onPatch={patch => {
                const next = selected.map((entry, i) => i === index ? { ...entry, ...patch } : entry);
                // 默认模型改名时跟随，避免默认指向旧 ID。
                update(next, selected[index].id.trim() === defaultModel ? (patch.id ?? model.id).trim() : defaultModel);
              }}
              onSetDefault={() => update(selected, model.id.trim())}
              onRemove={() => update(selected.filter((_, i) => i !== index))}
            />
          </div>
        ))}
      </div>}
      {!selected.length && <p className={descriptionClass}>点击"添加模型"新增一行，可手动输入或从候选中选择。</p>}
      <p className={descriptionClass}>已配置 {new Set(selected.map(model => model.id.trim()).filter(Boolean)).size} 个模型 · 候选列表 {models.length} 个。开启"推理"的模型可配置思考级别映射与默认思考级别（右键按模型启动直接生效）；默认模型用于常规启动。</p>
    </div>
  );
}
