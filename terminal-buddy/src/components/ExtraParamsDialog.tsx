import { FC, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Pencil, X } from 'lucide-react';
import { useAppStore } from '../stores/appStore';
import { TAB_COLORS } from '../types';
import type { ExtraParamPreset } from '../types';
import { Dialog, ConfirmDialog } from './Dialog';
import './ExtraParamsDialog.css';

interface ExtraParamsDialogProps {
  onClose: () => void;
}

const ColorPicker: FC<{
  value: string | null;
  onChange: (color: string | null) => void;
}> = ({ value, onChange }) => {
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!open) return;
    // 延迟一拍再注册监听，避免打开本次点击的 mousedown 序列误关闭
    const id = window.setTimeout(() => {
      const onDocDown = (e: MouseEvent) => {
        const target = e.target as Node;
        if (ref.current?.contains(target) || menuRef.current?.contains(target)) return;
        setOpen(false);
      };
      document.addEventListener('mousedown', onDocDown);
      cleanupRef.current = () => document.removeEventListener('mousedown', onDocDown);
    }, 0);
    return () => {
      window.clearTimeout(id);
      if (cleanupRef.current) { cleanupRef.current(); cleanupRef.current = null; }
    };
  }, [open]);

  // 弹窗跟随鼠标点击位置（fixed，portal 到 body 以脱离 Dialog 的 transform 包含块）
  const toggle = (e: React.MouseEvent) => {
    if (!open) {
      const menuW = 180;
      const menuH = 180;
      let left = e.clientX;
      let top = e.clientY;
      if (left + menuW + 8 > window.innerWidth) left = window.innerWidth - menuW - 8;
      if (top + menuH + 8 > window.innerHeight) top = Math.max(8, e.clientY - menuH);
      setMenuStyle({ position: 'fixed', left, top });
    }
    setOpen((v) => !v);
  };

  return (
    <div className="extra-params-color-picker" ref={ref}>
      <button
        type="button"
        className={`extra-params-color-swatch${value ? '' : ' theme-default'}`}
        style={value ? { backgroundColor: value } : undefined}
        onClick={(e) => { e.stopPropagation(); toggle(e); }}
        title={value ? '点击更换颜色' : '跟随主题（点击设置颜色）'}
        aria-label="选择标签颜色"
      />
      {open && createPortal(
        <div ref={menuRef} className="extra-params-color-menu" style={menuStyle} onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className={`extra-params-color-cell theme-default${!value ? ' selected' : ''}`}
            title="跟随主题"
            onClick={() => { onChange(null); setOpen(false); }}
          />
          {TAB_COLORS.filter(Boolean).map((c) => c && (
            <button
              key={c.id}
              type="button"
              className={`extra-params-color-cell${value === c.color ? ' selected' : ''}`}
              style={{ backgroundColor: c.color }}
              title={c.name}
              onClick={() => { onChange(c.color); setOpen(false); }}
            />
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
};

interface PresetDraft {
  name: string;
  params: string;
  tagColor: string | null;
  commandMatch: string;
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
      <input
        className="extra-param-input extra-param-input-match"
        value={draft.commandMatch}
        onChange={(e) => onChange({ ...draft, commandMatch: e.target.value })}
        placeholder="命令匹配（选填）"
        title="仅当配置的启动命令包含此文本时，右键菜单才显示该预设；留空则对所有配置可用"
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

const emptyDraft: PresetDraft = { name: '', params: '', tagColor: null, commandMatch: '' };

export const ExtraParamsDialog: FC<ExtraParamsDialogProps> = ({ onClose }) => {
  // 受控：mount 时下一帧切到 open 触发入场；onClose 请求关闭时跑离场，离场结束再回调 prop onClose
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setOpen(true));
    return () => cancelAnimationFrame(id);
  }, []);
  const {
    extraParamPresets,
    addExtraParamPreset,
    updateExtraParamPreset,
    removeExtraParamPreset,
  } = useAppStore();
  const [draft, setDraft] = useState<PresetDraft>(emptyDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<PresetDraft>(emptyDraft);
  const [pendingDelete, setPendingDelete] = useState<ExtraParamPreset | null>(null);

  const handleAdd = () => {
    if (!draft.name.trim() || !draft.params.trim()) return;
    addExtraParamPreset(draft.name.trim(), draft.params.trim(), draft.tagColor, draft.commandMatch.trim() || null);
    setDraft(emptyDraft);
  };

  const startEdit = (preset: ExtraParamPreset) => {
    setEditingId(preset.id);
    setEditDraft({
      name: preset.name,
      params: preset.params,
      tagColor: preset.tagColor,
      commandMatch: preset.commandMatch ?? '',
    });
  };

  const commitEdit = () => {
    if (!editingId) return;
    if (!editDraft.name.trim() || !editDraft.params.trim()) return;
    updateExtraParamPreset(editingId, {
      name: editDraft.name.trim(),
      params: editDraft.params.trim(),
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
      open={open}
      onClose={() => setOpen(false)}
      onExit={onClose}
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
              {preset.commandMatch && (
                <span className="extra-param-match" title="命令匹配">匹配: {preset.commandMatch}</span>
              )}
              <button
                className="extra-param-edit"
                onClick={() => startEdit(preset)}
                title="编辑"
                aria-label={`编辑 ${preset.name}`}
              >
                <Pencil size={14} aria-hidden="true" />
              </button>
              <button
                className="extra-param-delete"
                onClick={() => setPendingDelete(preset)}
                title="删除"
                aria-label={`删除 ${preset.name}`}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          ),
        )}
      </div>
      {pendingDelete && (
        <ConfirmDialog
          title="删除启动参数"
          message={`确定要删除预设「${pendingDelete.name}」吗？`}
          confirmText="删除"
          onConfirm={() => {
            removeExtraParamPreset(pendingDelete.id);
            setPendingDelete(null);
          }}
          onClose={() => setPendingDelete(null)}
        />
      )}
    </Dialog>
  );
};