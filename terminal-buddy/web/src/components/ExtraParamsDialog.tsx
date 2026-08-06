import { useState } from 'react';
import { Pencil, X } from 'lucide-react';
import { useStore } from '../store';
import { TAB_COLORS } from '../types';
import type { ExtraParamMode, ExtraParamPreset } from '../types';
import { Dialog } from './Dialog';
import './ExtraParamsDialog.css';

interface ExtraParamsDialogProps {
  onClose: () => void;
}

/** 标签颜色选择器：inline 平铺所有色块（避免弹出菜单被 dialog body 裁剪）。 */
function ColorPicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (color: string | null) => void;
}) {
  return (
    <div className="extra-params-color-picker" role="group" aria-label="标签颜色">
      {TAB_COLORS.map((c) =>
        c === null ? (
          <button
            type="button"
            key="default"
            className={`extra-params-color-cell theme-default${!value ? ' selected' : ''}`}
            onClick={() => onChange(null)}
            title="跟随主题"
            aria-label="跟随主题"
            aria-pressed={!value}
          />
        ) : (
          <button
            type="button"
            key={c.id}
            className={`extra-params-color-cell${value === c.color ? ' selected' : ''}`}
            style={{ backgroundColor: c.color }}
            onClick={() => onChange(c.color)}
            title={c.name}
            aria-label={c.name}
            aria-pressed={value === c.color}
          />
        ),
      )}
    </div>
  );
}

interface PresetDraft {
  name: string;
  params: string;
  mode: ExtraParamMode;
  tagColor: string | null;
  commandMatch: string;
}

function PresetEditor({
  draft,
  onChange,
  onSubmit,
  onCancel,
  submitLabel,
}: {
  draft: PresetDraft;
  onChange: (next: PresetDraft) => void;
  onSubmit: () => void;
  onCancel?: () => void;
  submitLabel: string;
}) {
  const canSubmit = draft.name.trim() !== '' && draft.params.trim() !== '';
  const submit = () => {
    if (!canSubmit) return;
    onSubmit();
  };
  return (
    <div className="extra-param-editor">
      <div className="extra-param-editor-fields">
        <input
          className="extra-param-input extra-param-input-name"
          value={draft.name}
          onChange={(e) => onChange({ ...draft, name: e.target.value })}
          placeholder="名称（同时作为 tag 显示）"
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
        />
        <input
          className="extra-param-input extra-param-input-params"
          value={draft.params}
          onChange={(e) => onChange({ ...draft, params: e.target.value })}
          placeholder={draft.mode === 'independent' ? '完整命令，如 claude --prod' : '参数，如 --prod'}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
        />
        <select
          className="extra-param-input extra-param-mode-select"
          value={draft.mode}
          onChange={(e) => onChange({ ...draft, mode: e.target.value as ExtraParamMode })}
          aria-label="执行方式"
          title="选择追加到原启动命令，或作为独立命令执行"
        >
          <option value="append">追加参数</option>
          <option value="independent">独立命令</option>
        </select>
        <input
          className="extra-param-input extra-param-input-match"
          value={draft.commandMatch}
          onChange={(e) => onChange({ ...draft, commandMatch: e.target.value })}
          placeholder="命令匹配（选填）"
          title="仅当连接的启动命令包含此文本时才显示该预设；留空则对所有连接可用"
          style={{ fontFamily: 'monospace' }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
        />
      </div>
      <div className="extra-param-editor-color">
        <span className="extra-param-editor-color-label">标签色</span>
        <ColorPicker
          value={draft.tagColor}
          onChange={(c) => onChange({ ...draft, tagColor: c })}
        />
      </div>
      <div className="extra-param-editor-actions">
        <button
          type="button"
          className="btn primary extra-param-action"
          onClick={submit}
          disabled={!canSubmit}
        >
          {submitLabel}
        </button>
        {onCancel && (
          <button type="button" className="btn extra-param-action" onClick={onCancel}>
            取消
          </button>
        )}
      </div>
    </div>
  );
}

const emptyDraft: PresetDraft = { name: '', params: '', mode: 'append', tagColor: null, commandMatch: '' };

export function ExtraParamsDialog({ onClose }: ExtraParamsDialogProps) {
  const extraParamPresets = useStore((s) => s.extraParamPresets);
  const addExtraParamPreset = useStore((s) => s.addExtraParamPreset);
  const updateExtraParamPreset = useStore((s) => s.updateExtraParamPreset);
  const removeExtraParamPreset = useStore((s) => s.removeExtraParamPreset);
  const [draft, setDraft] = useState<PresetDraft>(emptyDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<PresetDraft>(emptyDraft);

  const handleAdd = () => {
    if (!draft.name.trim() || !draft.params.trim()) return;
    void addExtraParamPreset(
      draft.name.trim(),
      draft.params.trim(),
      draft.tagColor,
      draft.commandMatch.trim() || null,
      draft.mode,
    );
    setDraft(emptyDraft);
  };

  const startEdit = (preset: ExtraParamPreset) => {
    setEditingId(preset.id);
    setEditDraft({
      name: preset.name,
      params: preset.params,
      mode: preset.mode ?? 'append',
      tagColor: preset.tagColor,
      commandMatch: preset.commandMatch ?? '',
    });
  };

  const commitEdit = () => {
    if (!editingId) return;
    if (!editDraft.name.trim() || !editDraft.params.trim()) return;
    void updateExtraParamPreset(editingId, {
      name: editDraft.name.trim(),
      params: editDraft.params.trim(),
      mode: editDraft.mode,
      tagColor: editDraft.tagColor,
      commandMatch: editDraft.commandMatch.trim() || null,
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
        <PresetEditor draft={draft} onChange={setDraft} onSubmit={handleAdd} submitLabel="添加" />
      </div>

      <div className="extra-params-list">
        <div className="extra-params-list-label">已有预设 ({extraParamPresets.length})</div>
        {extraParamPresets.length === 0 ? (
          <div className="extra-params-empty">暂无预设，在上方添加一个吧</div>
        ) : (
          extraParamPresets.map((preset) =>
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
                <span className={`extra-param-mode-badge ${preset.mode === 'independent' ? 'independent' : ''}`}>
                  {preset.mode === 'independent' ? '独立命令' : '追加参数'}
                </span>
                {preset.commandMatch && (
                  <span
                    className="extra-param-match"
                    title={`仅匹配启动命令包含「${preset.commandMatch}」的连接`}
                  >
                    {preset.commandMatch}
                  </span>
                )}
                <button
                  type="button"
                  className="extra-param-edit"
                  onClick={() => startEdit(preset)}
                  title="编辑"
                  aria-label={`编辑 ${preset.name}`}
                >
                  <Pencil size={15} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="extra-param-delete"
                  onClick={() => removeExtraParamPreset(preset.id)}
                  title="删除"
                  aria-label={`删除 ${preset.name}`}
                >
                  <X size={15} aria-hidden="true" />
                </button>
              </div>
            ),
          )
        )}
      </div>
    </Dialog>
  );
}
