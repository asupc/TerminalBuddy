import { FC } from 'react';
import { Keyboard, RotateCcw } from 'lucide-react';
import { getHotkey, HOTKEY_ACTIONS, type HotkeyActionId } from '../../services/hotkeys';
import { type AppSettings } from '../../utils/settings';
import { HotkeyRecorder } from './HotkeyRecorder';

interface HotkeySettingsProps {
  settings: AppSettings;
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
}

export const HotkeySettings: FC<HotkeySettingsProps> = ({ settings, updateSetting }) => {
  const hasCustom = HOTKEY_ACTIONS.some(action => getHotkey(action.id) !== action.defaultHotkey);

  return (
    <div className="settings-general">
      <div className="settings-card-group">
        <div className="card-group-header">
          <span className="card-group-title">
            <Keyboard size={14} aria-hidden="true" />
            全局与工作区快捷键
          </span>
          <div className="card-group-header-actions">
            <span className="card-group-extra">共 {HOTKEY_ACTIONS.length} 项</span>
            <button
              type="button"
              className="btn-secondary btn-sm"
              disabled={!hasCustom}
              onClick={() => updateSetting('hotkeys', {})}
            >
              <RotateCcw size={13} aria-hidden="true" />
              恢复全部默认
            </button>
          </div>
        </div>

        {HOTKEY_ACTIONS.map((action) => {
          const current = getHotkey(action.id);
          // 与其他动作当前生效键重复时提示，不阻止保存
          const duplicate = HOTKEY_ACTIONS.find(
            other => other.id !== action.id && current !== '' && getHotkey(other.id) === current,
          );
          return (
            <div key={action.id} className="settings-row">
              <div className="settings-row-info">
                <div className="settings-row-title">
                  {action.name}
                  {action.id === 'showWindow' && (
                    <span className="s-status-chip ok">全局热键</span>
                  )}
                  {duplicate && (
                    <span className="s-status-chip danger">与「{duplicate.name}」重复</span>
                  )}
                </div>
                <p className="settings-row-desc">
                  {action.desc}（点击右侧键帽录制，按 Esc 取消）
                </p>
              </div>
              <div className="settings-row-ctrl">
                <HotkeyRecorder
                  value={current}
                  onRecord={(hotkey) => {
                    const next: Partial<Record<HotkeyActionId, string>> = {
                      ...(settings.hotkeys ?? {}),
                      [action.id]: hotkey,
                    };
                    updateSetting('hotkeys', next);
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
