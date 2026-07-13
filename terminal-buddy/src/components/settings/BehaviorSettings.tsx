import { FC } from 'react';
import { saveCloseBehavior, saveEnableTabNavigation, saveSingleInstance, saveLaunchAtLogin, saveLaunchWindowMode } from '../../services/tauri';
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
        <label className="settings-label">UI 样式</label>
        <div className="breathing-light-mode-options ui-style-options" role="radiogroup" aria-label="UI 样式">
          <label className={`breathing-light-mode ${settings.uiStyle === 'default' ? 'active' : ''}`}>
            <input
              type="radio"
              name="uiStyle"
              value="default"
              checked={settings.uiStyle === 'default'}
              onChange={() => updateSetting('uiStyle', 'default')}
            />
            <span>默认</span>
          </label>
          <label className={`breathing-light-mode ${settings.uiStyle === 'sidebar' ? 'active' : ''}`}>
            <input
              type="radio"
              name="uiStyle"
              value="sidebar"
              checked={settings.uiStyle === 'sidebar'}
              onChange={() => updateSetting('uiStyle', 'sidebar')}
            />
            <span>侧边栏</span>
          </label>
        </div>
        <p className="settings-desc">侧边栏样式参考 VS Code，将配置、文件、选项卡和设置入口集中到左侧</p>
      </div>
      <div className="settings-section">
        <label className="settings-label">启动窗口模式</label>
        <div className="breathing-light-mode-options">
          <label className={`breathing-light-mode ${settings.launchWindowMode === 'windowed' ? 'active' : ''}`}>
            <input
              type="radio"
              name="launchWindowMode"
              checked={settings.launchWindowMode === 'windowed'}
              onChange={() => {
                updateSetting('launchWindowMode', 'windowed');
                saveLaunchWindowMode('windowed').catch(console.error);
              }}
            />
            <span>窗口模式</span>
          </label>
          <label className={`breathing-light-mode ${settings.launchWindowMode === 'maximized' ? 'active' : ''}`}>
            <input
              type="radio"
              name="launchWindowMode"
              checked={settings.launchWindowMode === 'maximized'}
              onChange={() => {
                updateSetting('launchWindowMode', 'maximized');
                saveLaunchWindowMode('maximized').catch(console.error);
              }}
            />
            <span>最大化启动</span>
          </label>
        </div>
        <p className="settings-desc">下次启动时直接按所选模式显示，不会先最大化再切回窗口</p>
      </div>
      <div className="settings-section">
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={settings.terminalFollowAppTheme}
            onChange={(e) => updateSetting('terminalFollowAppTheme', e.target.checked)}
          />
          <span>终端跟随应用主题</span>
        </label>
        <p className="settings-desc">开启后终端配色随应用主题切换（浅色模式→浅色底）；在连接配置里单独选择了其他配色的连接不受影响</p>
      </div>
      <div className="settings-section">
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={settings.restoreTabsOnStartup}
            onChange={(e) => updateSetting('restoreTabsOnStartup', e.target.checked)}
          />
          <span>启动时恢复选项卡</span>
        </label>
        <p className="settings-desc">关闭程序时自动保存打开的终端选项卡，下次启动时自动恢复</p>
      </div>
      <div className="settings-section">
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={settings.autoResumeClaudeSession}
            onChange={(e) => updateSetting('autoResumeClaudeSession', e.target.checked)}
          />
          <span>自动恢复 Claude Code 会话</span>
        </label>
        <p className="settings-desc">启动时自动恢复上次的 Claude Code 会话（通过 claude --resume 继续对话）</p>
      </div>
      <div className="settings-section">
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={settings.claudeDecisionNotifications}
            onChange={(e) => updateSetting('claudeDecisionNotifications', e.target.checked)}
          />
          <span>Claude Code 决策通知</span>
        </label>
        <label className="settings-label">
          等待
          <input
            type="number"
            min="0"
            max="3600"
            value={settings.claudeDecisionNotificationDelaySeconds}
            onChange={(e) => updateSetting('claudeDecisionNotificationDelaySeconds', Math.min(3600, Math.max(0, Number(e.target.value) || 0)))}
            style={{ width: 72, margin: '0 8px' }}
          />
          秒后通知
        </label>
        <p className="settings-desc">Claude Code 等待确认或提出问题达到指定时间后通知</p>
      </div>
      <div className="settings-section">
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={settings.claudeCompletionNotifications}
            onChange={(e) => updateSetting('claudeCompletionNotifications', e.target.checked)}
          />
          <span>Claude Code 完成通知</span>
        </label>
        <label className="settings-label">
          等待
          <input
            type="number"
            min="0"
            max="3600"
            value={settings.claudeCompletionNotificationDelaySeconds}
            onChange={(e) => updateSetting('claudeCompletionNotificationDelaySeconds', Math.min(3600, Math.max(0, Number(e.target.value) || 0)))}
            style={{ width: 72, margin: '0 8px' }}
          />
          秒后通知
        </label>
        <p className="settings-desc">任务完成达到指定时间后通知；当前激活的终端（含分屏窗格）不会通知</p>
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
          <span>纵向选项卡</span>
        </label>
        <p className="settings-desc">勾选时选项卡显示在左侧面板（纵向），未勾选时显示在终端上方（横向）</p>
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
            checked={settings.doubleClickRunBat}
            onChange={(e) => {
              updateSetting('doubleClickRunBat', e.target.checked);
            }}
          />
          <span>双击运行 .bat 文件</span>
        </label>
        <p className="settings-desc">开启后，在文件导航中双击 .bat 文件将直接运行（等同于“在系统中打开”）；关闭时双击在编辑器中打开</p>
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
            <span>跟随选项卡颜色</span>
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
      <div className="settings-section">
        <label className="settings-label">列表选中样式</label>
        <div className="breathing-light-mode-options">
          <label className={`breathing-light-mode ${settings.listSelectionStyle === 'default' ? 'active' : ''}`}>
            <input
              type="radio"
              name="listSelectionStyle"
              checked={settings.listSelectionStyle === 'default'}
              onChange={() => updateSetting('listSelectionStyle', 'default')}
            />
            <span>默认样式（灰）</span>
          </label>
          <label className={`breathing-light-mode ${settings.listSelectionStyle === 'idea' ? 'active' : ''}`}>
            <input
              type="radio"
              name="listSelectionStyle"
              checked={settings.listSelectionStyle === 'idea'}
              onChange={() => updateSetting('listSelectionStyle', 'idea')}
            />
            <span>IDEA样式（蓝）</span>
          </label>
          <label className={`breathing-light-mode ${settings.listSelectionStyle === 'custom' ? 'active' : ''}`}>
            <input
              type="radio"
              name="listSelectionStyle"
              checked={settings.listSelectionStyle === 'custom'}
              onChange={() => updateSetting('listSelectionStyle', 'custom')}
            />
            <span>自定义</span>
          </label>
        </div>
        {settings.listSelectionStyle === 'custom' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
            <div className="color-slot">
              <label>背景色</label>
              <div className="color-input-wrap">
                <input
                  type="color"
                  value={settings.listSelectionBg}
                  onChange={(e) => updateSetting('listSelectionBg', e.target.value)}
                />
                <input
                  type="text"
                  value={settings.listSelectionBg}
                  onChange={(e) => updateSetting('listSelectionBg', e.target.value)}
                />
              </div>
            </div>
            <div className="color-slot">
              <label>字体色</label>
              <div className="color-input-wrap">
                <input
                  type="color"
                  value={settings.listSelectionFg}
                  onChange={(e) => updateSetting('listSelectionFg', e.target.value)}
                />
                <input
                  type="text"
                  value={settings.listSelectionFg}
                  onChange={(e) => updateSetting('listSelectionFg', e.target.value)}
                />
              </div>
            </div>
            <div className="color-slot">
              <label>边框色</label>
              <div className="color-input-wrap">
                <input
                  type="color"
                  value={settings.listSelectionBorderColor}
                  onChange={(e) => updateSetting('listSelectionBorderColor', e.target.value)}
                />
                <input
                  type="text"
                  value={settings.listSelectionBorderColor}
                  onChange={(e) => updateSetting('listSelectionBorderColor', e.target.value)}
                />
              </div>
            </div>
            <div className="color-slot">
              <label>边框宽度</label>
              <input
                type="number"
                min={0}
                max={10}
                step={1}
                value={settings.listSelectionBorderWidth}
                onChange={(e) => updateSetting('listSelectionBorderWidth', Math.max(0, Number(e.target.value) || 0))}
                style={{ width: 60 }}
              />
              <span style={{ fontSize: 12, color: 'var(--text-secondary)', marginLeft: 4 }}>px</span>
            </div>
          </div>
        )}
        <div style={{ marginTop: 8 }}>
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 10px',
              borderRadius: 3,
              background: 'var(--list-active-bg)',
              color: 'var(--list-active-fg)',
              fontSize: 12,
              boxShadow: 'inset 0 0 0 var(--list-active-border-width) var(--list-active-border-color)',
            }}
          >
            <span style={{ fontWeight: 600 }}>SSH</span>
            <span>示例选中条目</span>
          </div>
        </div>
        <p className="settings-desc">连接导航与文件导航中，被选中列表条目的配色（上方为实时预览）</p>
      </div>
    </div>
  );
};
