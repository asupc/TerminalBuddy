import { FC, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Pencil, X, GripVertical } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import { TAB_COLORS } from '../../types';
import type { ExtraParamMode, ExtraParamPreset } from '../../types';
import { Dialog, ConfirmDialog } from '../shared/Dialog';
import './ExtraParamsDialog.css';

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
  mode: ExtraParamMode;
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
        placeholder={draft.mode === 'independent' ? '完整命令' : '参数'}
        style={{ fontFamily: 'monospace' }}
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
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

const emptyDraft: PresetDraft = { name: '', params: '', mode: 'append', tagColor: null, commandMatch: '' };

/**
 * 启动参数预设的管理 UI 主体：新增/编辑/删除/列表。
 * 既可作为 Dialog 内容（带外层 Dialog 的入场动画），也可直接嵌入设置面板。
 * 弹出位置无关，因此不要在此处渲染任何外框/Dialog/标题。
 */
export const ExtraParamsManager: FC = () => {
  const {
    extraParamPresets,
    addExtraParamPreset,
    updateExtraParamPreset,
    removeExtraParamPreset,
    reorderExtraParamPresets,
  } = useAppStore();
  const [draft, setDraft] = useState<PresetDraft>(emptyDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<PresetDraft>(emptyDraft);
  const [pendingDelete, setPendingDelete] = useState<ExtraParamPreset | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; position: 'before' | 'after' } | null>(null);

  const handleAdd = () => {
    if (!draft.name.trim() || !draft.params.trim()) return;
    addExtraParamPreset(draft.name.trim(), draft.params.trim(), draft.tagColor, draft.commandMatch.trim() || null, draft.mode);
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
    updateExtraParamPreset(editingId, {
      name: editDraft.name.trim(),
      params: editDraft.params.trim(),
      mode: editDraft.mode,
      tagColor: editDraft.tagColor,
      commandMatch: editDraft.commandMatch.trim() || null,
    });
    setEditingId(null);
  };

  const cancelEdit = () => setEditingId(null);

  // 拖拽排序不走 HTML5 DnD：WebView2 上 Tauri 的原生 drag-drop（dragDropEnabled，文件拖入依赖）
  // 会替换 OLE drop target，导致页面内 dragover/drop 事件永不触发。
  // 改用 mouse 事件实现（同 ConfigEditDialog 启动命令排序的做法）。
  const listRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ id: string; startY: number; active: boolean } | null>(null);
  const dropTargetRef = useRef<{ id: string; position: 'before' | 'after' } | null>(null);

  // 按 clientY 命中目标行，并返回插入位置；越过底部时落在最后一行 after
  const hitTestRow = (clientY: number, draggingId: string): { id: string; position: 'before' | 'after' } | null => {
    const rows = listRef.current?.querySelectorAll<HTMLElement>('.extra-param-item') ?? [];
    let last: { id: string; position: 'before' | 'after' } | null = null;
    for (const row of rows) {
      const id = row.dataset.presetId;
      if (!id || id === draggingId) continue;
      const rect = row.getBoundingClientRect();
      if (clientY < rect.bottom) {
        return { id, position: clientY < rect.top + rect.height / 2 ? 'before' : 'after' };
      }
      last = { id, position: 'after' };
    }
    return last;
  };

  const handleHandleMouseDown = (e: React.MouseEvent<HTMLSpanElement>, id: string) => {
    if (e.button !== 0) return;
    e.preventDefault(); // 阻止按下后选中文本
    dragRef.current = { id, startY: e.clientY, active: false };

    const handleMouseMove = (ev: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (!drag.active) {
        // 移动超过阈值才进入拖拽，避免单击误触
        if (Math.abs(ev.clientY - drag.startY) < 4) return;
        drag.active = true;
        setDraggingId(drag.id);
      }
      const target = hitTestRow(ev.clientY, drag.id);
      dropTargetRef.current = target;
      setDropTarget(prev => (prev?.id === target?.id && prev?.position === target?.position ? prev : target));
    };

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      const drag = dragRef.current;
      const target = dropTargetRef.current;
      dragRef.current = null;
      dropTargetRef.current = null;
      setDraggingId(null);
      setDropTarget(null);
      if (drag?.active && target && target.id !== drag.id) {
        reorderExtraParamPresets(drag.id, target.id, target.position);
      }
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

  return (
    <>
      <div className="extra-params-input-section">
        <PresetEditor
          draft={draft}
          onChange={setDraft}
          onSubmit={handleAdd}
          submitLabel="添加"
        />
      </div>

      <div className="extra-params-list" ref={listRef}>
        <label style={{ display: 'block', marginBottom: 8 }}>
          已有预设 ({extraParamPresets.length})
        </label>
        {extraParamPresets.length === 0 && (
          <div className="extra-params-empty">暂无预设</div>
        )}
        {extraParamPresets.map((preset) => {
          const isEditing = editingId === preset.id;
          const isDragging = draggingId === preset.id;
          const dropClass = dropTarget && dropTarget.id === preset.id
            ? (dropTarget.position === 'before' ? ' drop-before' : ' drop-after')
            : '';
          return isEditing ? (
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
            <div
              key={preset.id}
              className={`extra-param-item${preset.enabled ? '' : ' disabled'}${isDragging ? ' dragging' : ''}${dropClass}`}
              data-preset-id={preset.id}
            >
              <span
                className="extra-param-drag-handle"
                onMouseDown={(e) => handleHandleMouseDown(e, preset.id)}
                title="拖拽排序"
                aria-label={`拖拽排序 ${preset.name}`}
                role="button"
                tabIndex={0}
              >
                <GripVertical size={14} aria-hidden="true" />
              </span>
              <label
                className="extra-param-toggle"
                title={preset.enabled ? '已启用，点击禁用（禁用后右键菜单不再显示）' : '已禁用，点击启用'}
              >
                <input
                  type="checkbox"
                  checked={preset.enabled}
                  onChange={(e) => updateExtraParamPreset(preset.id, { enabled: e.target.checked })}
                  aria-label={`启用 ${preset.name}`}
                />
              </label>
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
          );
        })}
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
    </>
  );
};

interface ExtraParamsDialogProps {
  onClose: () => void;
}

export const ExtraParamsDialog: FC<ExtraParamsDialogProps> = ({ onClose }) => {
  // 受控：mount 时下一帧切到 open 触发入场；onClose 请求关闭时跑离场，离场结束再回调 prop onClose
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setOpen(true));
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <Dialog
      title="管理启动参数"
      className="extra-params-dialog"
      bodyClassName="extra-params-dialog-content"
      open={open}
      onClose={() => setOpen(false)}
      onExit={onClose}
    >
      <ExtraParamsManager />
    </Dialog>
  );
};
