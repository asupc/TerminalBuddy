import { FC } from 'react';
import { saveCloseBehavior, saveEnableTabNavigation, saveSingleInstance, saveLaunchAtLogin } from '../../services/tauri';
import { BREATHING_LIGHT_COLORS } from '../../types';
import type { AppSettings, BreathingLightColorMode } from '../../utils/settings';

interface BehaviorSettingsProps {
  settings: AppSettings;
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
}

export const BehaviorSettings: FC<BehaviorSettingsProps> = ({ settings, updateSetting }) => {
  return (
    <div className="settings-general">
      <div className="settings-section">
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={settings.restoreTabsOnStartup}
            onChange={(e) => updateSetting('restoreTabsOnStartup', e.target.checked)}
          />
          <span>启动时恢复标签</span>
        </label>
        <p className="settings-desc">关闭程序时自动保存打开的终端标签，下次启动时自动恢复</p>
      </div>
      <div className="settings-section">
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={settings.configPanelAutoExpand}
            onChange={(e) => updateSetting('configPanelAutoExpand', e.target.checked)}
          />
          <span>启动时展开连接面板</span>
        </label>
        <p className="settings-desc">启动时自动展开左侧连接面板</p>
      </div>
      <div className="settings-section">
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={settings.fileTreeAutoExpand}
            onChange={(e) => updateSetting('fileTreeAutoExpand', e.target.checked)}
          />
          <span>启动时展开文件面板</span>
        </label>
        <p className="settings-desc">启动时自动展开左侧文件面板</p>
      </div>
      <div className="settings-section">
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={settings.closeBehavior === 'tray'}
            onChange={(e) => {
              const value = e.target.checked ? 'tray' : 'exit';
              updateSetting('closeBehavior', value);
              saveCloseBehavior(value).catch(console.error);
            }}
          />
          <span>关闭时最小化到托盘</span>
        </label>
        <p className="settings-desc">关闭窗口时应用将隐藏到系统托盘，双击托盘图标或右键选择"打开窗口"可重新显示</p>
      </div>
      <div className="settings-section">
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={settings.enableTabNavigation}
            onChange={(e) => {
              const value = e.target.checked;
              updateSetting('enableTabNavigation', value);
              saveEnableTabNavigation(value).catch(console.error);
              window.dispatchEvent(new CustomEvent('tab-navigation-changed'));
            }}
          />
          <span>侧边标签栏</span>
        </label>
        <p className="settings-desc">开启后标签显示在左侧面板，关闭后以选项卡形式显示在终端上方</p>
      </div>
      <div className="settings-section">
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={settings.rightClickPaste}
            onChange={(e) => {
              updateSetting('rightClickPaste', e.target.checked);
            }}
          />
          <span>右键粘贴</span>
        </label>
        <p className="settings-desc">右键时若无选中文本，直接粘贴剪贴板内容到终端</p>
      </div>
      <div className="settings-section">
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={settings.singleInstance}
            onChange={(e) => {
              const value = e.target.checked;
              updateSetting('singleInstance', value);
              saveSingleInstance(value).catch(console.error);
            }}
          />
          <span>仅单窗口运行</span>
        </label>
        <p className="settings-desc">重复启动时激活已有窗口，而非打开新窗口。需重启生效</p>
      </div>
      <div className="settings-section">
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={settings.launchAtLogin}
            onChange={(e) => {
              const value = e.target.checked;
              updateSetting('launchAtLogin', value);
              saveLaunchAtLogin(value).catch(console.error);
            }}
          />
          <span>开机自动启动</span>
        </label>
        <p className="settings-desc">登录 Windows 时自动启动 TerminalBuddy</p>
      </div>
      <div className="settings-section">
        <label className="settings-label">活动指示灯颜色</label>
        <div className="breathing-light-mode-options">
          <label className={`breathing-light-mode ${settings.breathingLightColorMode === 'tab' ? 'active' : ''}`}>
            <input
              type="radio"
              name="breathingLightColorMode"
              checked={settings.breathingLightColorMode === 'tab'}
              onChange={() => updateSetting('breathingLightColorMode', 'tab' as BreathingLightColorMode)}
            />
            <span>跟随标签颜色</span>
          </label>
          <label className={`breathing-light-mode ${settings.breathingLightColorMode === 'custom' ? 'active' : ''}`}>
            <input
              type="radio"
              name="breathingLightColorMode"
              checked={settings.breathingLightColorMode === 'custom'}
              onChange={() => updateSetting('breathingLightColorMode', 'custom' as BreathingLightColorMode)}
            />
            <span>自定义颜色</span>
          </label>
        </div>
        {settings.breathingLightColorMode === 'custom' && (
          <div className="tab-color-options" style={{ marginTop: 8 }}>
            {BREATHING_LIGHT_COLORS.map((c) => (
              <label
                key={c.id}
                className={`tab-color-chip ${settings.breathingLightCustomColor === c.color ? 'active' : ''}`}
              >
                <input
                  type="radio"
                  name="breathingLightCustomColor"
                  checked={settings.breathingLightCustomColor === c.color}
                  onChange={() => updateSetting('breathingLightCustomColor', c.color)}
                />
                <span className="tab-color-swatch" style={{ background: c.color }} />
                {c.name}
              </label>
            ))}
          </div>
        )}
        <p className="settings-desc">终端执行命令时指示灯使用的颜色</p>
      </div>
    </div>
  );
};
