import { FC } from 'react';
import { BREATHING_LIGHT_COLORS } from '../../types';
import { type AppSettings, type BreathingLightColorMode } from '../../utils/settings';

interface AppearanceSettingsProps {
  settings: AppSettings;
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
}

export const AppearanceSettings: FC<AppearanceSettingsProps> = ({ settings, updateSetting }) => {
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
      <div className="settings-section">
        <label className="settings-label">终端字号</label>
        <div className="settings-grid-2col">
          {(
            [
              { key: 'terminalFontSizeOff', label: '单屏', defaultValue: 14 },
              { key: 'terminalFontSize2x1', label: '一分二（2×1）', defaultValue: 12 },
              { key: 'terminalFontSize2x2', label: '四分屏（2×2）', defaultValue: 11 },
            ] as const
          ).map((row) => {
            const value = settings[row.key];
            return (
              <div key={row.key} className="settings-number-row">
                <span className="settings-number-label">{row.label}</span>
                <input
                  type="number"
                  min={8}
                  max={32}
                  step={1}
                  value={value}
                  onChange={(e) => {
                    const raw = e.target.value.trim();
                    if (raw === '' || raw === '-') {
                      updateSetting(row.key, row.defaultValue);
                      return;
                    }
                    const num = Number(raw);
                    const next = Number.isFinite(num) && num > 0
                      ? Math.max(8, Math.min(32, Math.round(num)))
                      : row.defaultValue;
                    updateSetting(row.key, next);
                  }}
                />
                <span className="settings-number-unit">px</span>
              </div>
            );
          })}
        </div>
        <p className="settings-desc">
          单屏 / 一分二 / 四分屏三种模式下使用的 xterm 字号；可保留默认 14 / 12 / 11，无视觉变化
        </p>
      </div>
    </div>
  );
};
