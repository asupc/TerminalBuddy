import { FC, useEffect, useRef, useState } from 'react';
import { Pencil, X } from 'lucide-react';
import { useAppStore } from '../stores/appStore';
import { TAB_COLORS } from '../types';
import type { ExtraParamPreset } from '../types';
import { Dialog } from './Dialog';
import './ExtraParamsDialog.css';

interface ExtraParamsDialogProps {
  onClose: () => void;
}

const ColorPicker: FC<{
  value: string | null;
  onChange: (color: string | null) => void;
}> = ({ value, onChange }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [open]);

  return (
    <div className="extra-params-color-picker" ref={ref}>
      <button
        type="button"
        className={`extra-params-color-swatch${value ? '' : ' theme-default'}`}
        style={value ? { backgroundColor: value } : undefined}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        title={value ? '点击更换颜色' : '跟随主题（点击设置颜色）'}
        aria-label="选择标签颜色"
      />
      {open && (
        <div className="extra-params-color-menu" onClick={(e) => e.stopPropagation()}>
          <div
            className={`extra-params-color-item${!value ? ' selected' : ''}`}
            onClick={() => { onChange(null); setOpen(false); }}
          >
            <span className="extra-params-color-swatch theme-default" />
            <span>跟随主题</span>
          </div>
          {TAB_COLORS.filter(Boolean).map((c) => c && (
            <div
              key={c.id}
              className={`extra-params-color-item${value === c.color ? ' selected' : ''}`}
              onClick={() => { onChange(c.color); setOpen(false); }}
            >
              <span className="extra-params-color-swatch" style={{ backgroundColor: c.color }} />
              <span style={{ color: c.color }}>{c.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

interface PresetDraft {
  name: string;
  params: string;
  tagColor: string | null;
}

const PresetEditor: FC<{
  draft: PresetDraft;
  onChange: (next: PresetDraft) => void;
  onSubmit: () => void;
  onCancel?: () => void;
  submitLabel: string;
}> = ({ draft, onChange, onSubmit, onCancel, submitLabel }) => {
  const submit = () => {
    if (!draft.name.trim() || !draft.params.trim()) return;
    onSubmit();
  };
  return (
    <div className="extra-param-editor">
      <input
        className="extra-param-input extra-param-input-name"
        value={draft.name}
        onChange={(e) => onChange({ ...draft, name: e.target.value })}
        placeholder="名称（同时作为 tag 显示）"
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
      />
      <input
        className="extra-param-input extra-param-input-params"
        value={draft.params}
        onChange={(e) => onChange({ ...draft, params: e.target.value })}
        placeholder="参数"
        style={{ fontFamily: 'monospace' }}
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
      />
      <ColorPicker value={draft.tagColor} onChange={(c) => onChange({ ...draft, tagColor: c })} />
      <button
        type="button"
        className="btn-primary extra-param-action"
        onClick={submit}
        disabled={!draft.name.trim() || !draft.params.trim()}
      >
        {submitLabel}
      </button>
      {onCancel && (
        <button type="button" className="btn-secondary extra-param-action" onClick={onCancel}>
          取消
        </button>
      )}
    </div>
  );
};

const emptyDraft: PresetDraft = { name: '', params: '', tagColor: null };

export const ExtraParamsDialog: FC<ExtraParamsDialogProps> = ({ onClose }) => {
  const {
    extraParamPresets,
    addExtraParamPreset,
    updateExtraParamPreset,
    removeExtraParamPreset,
  } = useAppStore();
  const [draft, setDraft] = useState<PresetDraft>(emptyDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<PresetDraft>(emptyDraft);

  const handleAdd = () => {
    if (!draft.name.trim() || !draft.params.trim()) return;
    addExtraParamPreset(draft.name.trim(), draft.params.trim(), draft.tagColor);
    setDraft(emptyDraft);
  };

  const startEdit = (preset: ExtraParamPreset) => {
    setEditingId(preset.id);
    setEditDraft({
      name: preset.name,
      params: preset.params,
      tagColor: preset.tagColor,
    });
  };

  const commitEdit = () => {
    if (!editingId) return;
    if (!editDraft.name.trim() || !editDraft.params.trim()) return;
    updateExtraParamPreset(editingId, {
      name: editDraft.name.trim(),
      params: editDraft.params.trim(),
      tagColor: editDraft.tagColor,
    });
    setEditingId(null);
  };

  const cancelEdit = () => setEditingId(null);

  return (
    <Dialog
      title="管理启动参数"
      className="extra-params-dialog"
      bodyClassName="extra-params-dialog-content"
      onClose={onClose}
    >
      <div className="extra-params-input-section">
        <PresetEditor
          draft={draft}
          onChange={setDraft}
          onSubmit={handleAdd}
          submitLabel="添加"
        />
      </div>

      <div className="extra-params-list">
        <label style={{ display: 'block', marginBottom: 8 }}>
          已有预设 ({extraParamPresets.length})
        </label>
        {extraParamPresets.length === 0 && (
          <div className="extra-params-empty">暂无预设</div>
        )}
        {extraParamPresets.map((preset) =>
          editingId === preset.id ? (
            <div key={preset.id} className="extra-param-item editing">
              <PresetEditor
                draft={editDraft}
                onChange={setEditDraft}
                onSubmit={commitEdit}
                onCancel={cancelEdit}
                submitLabel="保存"
              />
            </div>
          ) : (
            <div key={preset.id} className="extra-param-item">
              <span
                className="extra-param-tag-chip"
                style={preset.tagColor ? { backgroundColor: preset.tagColor } : undefined}
                title="tag"
              >
                {preset.name}
              </span>
              <span className="extra-param-params">{preset.params}</span>
              <button
                className="extra-param-edit"
                onClick={() => startEdit(preset)}
                title="编辑"
                aria-label={`编辑 ${preset.name}`}
              >
                <Pencil aria-hidden="true" />
              </button>
              <button
                className="extra-param-delete"
                onClick={() => removeExtraParamPreset(preset.id)}
                title="删除"
                aria-label={`删除 ${preset.name}`}
              >
                <X aria-hidden="true" />
              </button>
            </div>
          ),
        )}
      </div>
    </Dialog>
  );
};