import { useRef, useState } from 'react';
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
          placeholder={
            draft.mode === 'independent' ? '完整命令，如 claude --prod' : '参数，如 --prod'
          }
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
        <ColorPicker value={draft.tagColor} onChange={(c) => onChange({ ...draft, tagColor: c })} />
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

const emptyDraft: PresetDraft = {
  name: '',
  params: '',
  mode: 'append',
  tagColor: null,
  commandMatch: '',
};

export function ExtraParamsDialog({ onClose }: ExtraParamsDialogProps) {
  const presets = useStore((s) => s.extraParamPresets);
  const presetsLoading = useStore((s) => s.presetsLoading);
  const presetsError = useStore((s) => s.presetsError);
  const reload = useStore((s) => s.loadExtraParamPresets);
  const add = useStore((s) => s.addExtraParamPreset);
  const update = useStore((s) => s.updateExtraParamPreset);
  const remove = useStore((s) => s.removeExtraParamPreset);
  const move = useStore((s) => s.moveExtraParamPreset);
  const [draft, setDraft] = useState<PresetDraft>(emptyDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<PresetDraft>(emptyDraft);
  const [pendingDelete, setPendingDelete] = useState<ExtraParamPreset | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const run = async (action: () => Promise<void>) => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const handleAdd = async () => {
    if (!draft.name.trim() || !draft.params.trim()) return;
    if (
      await run(() =>
        add(
          draft.name.trim(),
          draft.params.trim(),
          draft.tagColor,
          draft.commandMatch.trim() || null,
          draft.mode,
        ),
      )
    )
      setDraft(emptyDraft);
  };
  const commitEdit = async () => {
    if (!editingId || !editDraft.name.trim() || !editDraft.params.trim()) return;
    if (
      await run(() =>
        update(editingId, {
          name: editDraft.name.trim(),
          params: editDraft.params.trim(),
          mode: editDraft.mode,
          tagColor: editDraft.tagColor,
          commandMatch: editDraft.commandMatch.trim() || null,
        }),
      )
    )
      setEditingId(null);
  };
  return (
    <>
      <Dialog
        title="管理启动参数"
        className="extra-params-dialog"
        bodyClassName="extra-params-dialog-content"
        onClose={() => {
          if (!busy) onClose();
        }}
      >
        {error && (
          <div className="nav-error" role="alert">
            {error}
          </div>
        )}
        <div role="status">{presetsLoading ? '加载中…' : ''}</div>
        {presetsError && (
          <div className="nav-error" role="alert">
            {presetsError}
            <button
              className="btn small"
              disabled={busy || presetsLoading}
              onClick={() => void reload()}
            >
              重试
            </button>
          </div>
        )}
        <fieldset
          className="extra-params-fieldset"
          disabled={busy || presetsLoading || !!presetsError}
        >
          <div className="extra-params-input-section">
            <PresetEditor
              draft={draft}
              onChange={setDraft}
              onSubmit={() => void handleAdd()}
              submitLabel="添加"
            />
          </div>
          <div className="extra-params-list">
            <div className="extra-params-list-label">已有预设 ({presets.length})</div>
            {!presets.length && (
              <div className="extra-params-empty">暂无预设，在上方添加一个吧</div>
            )}
            {presets.map((preset, index) =>
              editingId === preset.id ? (
                <div key={preset.id} className="extra-param-item editing">
                  <PresetEditor
                    draft={editDraft}
                    onChange={setEditDraft}
                    onSubmit={() => void commitEdit()}
                    onCancel={() => setEditingId(null)}
                    submitLabel="保存"
                  />
                </div>
              ) : (
                <div
                  key={preset.id}
                  className={`extra-param-item${preset.enabled === false ? ' disabled' : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={preset.enabled !== false}
                    aria-label={`启用预设 ${preset.name}`}
                    onChange={(e) =>
                      void run(() => update(preset.id, { enabled: e.target.checked }))
                    }
                  />
                  <span
                    className="extra-param-tag-chip"
                    style={preset.tagColor ? { backgroundColor: preset.tagColor } : undefined}
                  >
                    {preset.name}
                  </span>
                  <span className="extra-param-params">{preset.params}</span>
                  <span
                    className={`extra-param-mode-badge ${preset.mode === 'independent' ? 'independent' : ''}`}
                  >
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
                    className="btn small"
                    disabled={index === 0}
                    aria-label={`上移预设 ${preset.name}`}
                    onClick={() => void run(() => move(preset.id, -1))}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="btn small"
                    disabled={index === presets.length - 1}
                    aria-label={`下移预设 ${preset.name}`}
                    onClick={() => void run(() => move(preset.id, 1))}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="extra-param-edit"
                    title="编辑"
                    aria-label={`编辑 ${preset.name}`}
                    onClick={() => {
                      setEditingId(preset.id);
                      setEditDraft({
                        name: preset.name,
                        params: preset.params,
                        mode: preset.mode || 'append',
                        tagColor: preset.tagColor,
                        commandMatch: preset.commandMatch || '',
                      });
                    }}
                  >
                    <Pencil size={15} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="extra-param-delete"
                    title="删除"
                    aria-label={`删除 ${preset.name}`}
                    onClick={() => {
                      setPendingDelete(preset);
                      setError('');
                    }}
                  >
                    <X size={15} aria-hidden="true" />
                  </button>
                </div>
              ),
            )}
          </div>
        </fieldset>
      </Dialog>
      {pendingDelete && (
        <Dialog
          title="删除启动参数"
          onClose={() => {
            if (!busy) setPendingDelete(null);
          }}
          footer={
            <>
              <button className="btn" disabled={busy} onClick={() => setPendingDelete(null)}>
                取消
              </button>
              <button
                className="btn danger"
                disabled={busy}
                onClick={async () => {
                  if (await run(() => remove(pendingDelete.id))) setPendingDelete(null);
                }}
              >
                删除
              </button>
            </>
          }
        >
          <p>确定删除“{pendingDelete.name}”？</p>
          {error && (
            <div className="nav-error" role="alert">
              {error}
            </div>
          )}
        </Dialog>
      )}
    </>
  );
}
