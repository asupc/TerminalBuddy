import { FC } from 'react';
import { getHotkey, HOTKEY_ACTIONS, type HotkeyActionId } from '../../services/hotkeys';
import { type AppSettings } from '../../utils/settings';
import { HotkeyRecorder } from './HotkeyRecorder';

interface HotkeySettingsProps {
  settings: AppSettings;
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
}

export const HotkeySettings: FC<HotkeySettingsProps> = ({ settings, updateSetting }) => {
  return (
    <div className="settings-general">
      <div className="settings-section">
        <p className="settings-desc">点击按钮后按下组合键录制,按 Esc 取消</p>
        {HOTKEY_ACTIONS.map((action) => {
          const current = getHotkey(action.id);
          // 与其他动作当前生效键重复时提示,不阻止保存
          const duplicate = HOTKEY_ACTIONS.find(
            other => other.id !== action.id && current !== '' && getHotkey(other.id) === current,
          );
          return (
            <div key={action.id} className="hotkey-row">
              <span className="hotkey-row-name">{action.name}</span>
              <HotkeyRecorder
                value={current}
                onRecord={(hotkey) => {
                  const next: Partial<Record<HotkeyActionId, string>> = { ...(settings.hotkeys ?? {}), [action.id]: hotkey };
                  updateSetting('hotkeys', next);
                }}
              />
              {duplicate && <span className="hotkey-duplicate">与「{duplicate.name}」重复</span>}
              <p className="settings-desc hotkey-desc">
                {action.desc}{action.id === 'showWindow' ? '（全局，后台也可用）' : ''}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
};
