import { FC, useEffect, useState } from 'react';
import { isBrowserClient } from '../../services/platform';
import { saveCloseBehavior, saveEnableTabNavigation, saveSingleInstance, saveLaunchAtLogin, saveLaunchWindowMode, saveTerminalLoadingMode, getDefaultTerminalStatus, setDefaultTerminalEnabled, type VsCodeTerminalSupport, type DefaultTerminalStatus } from '../../services/tauri';
import { showAlert } from '../../services/dialog';
import { type AppSettings } from '../../utils/settings';

interface BehaviorSettingsProps {
  settings: AppSettings;
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  vsCodeSupport: VsCodeTerminalSupport | null;
}

export const BehaviorSettings: FC<BehaviorSettingsProps> = ({ settings, updateSetting, vsCodeSupport }) => {
  const vsCodeAvailable = vsCodeSupport?.available === true;
  // 默认终端状态自管（不进 localStorage 镜像）：注册表是唯一权威来源。
  const [defaultTerminal, setDefaultTerminal] = useState<DefaultTerminalStatus | null>(null);
  useEffect(() => {
    getDefaultTerminalStatus().then(setDefaultTerminal).catch(console.error);
  }, []);
  const toggleDefaultTerminal = async (value: boolean) => {
    try {
      setDefaultTerminal(await setDefaultTerminalEnabled(value));
    } catch (error) {
      await showAlert(String(error), '默认终端');
      // 开关写入失败：重新拉真实状态回滚 UI
      getDefaultTerminalStatus().then(setDefaultTerminal).catch(console.error);
    }
  };
  return (
    <div className="settings-general">
      {/* 卡片组 1: 终端加载与系统接管 */}
      <div className="settings-card-group">
        <div className="card-group-header">
          <span className="card-group-title">终端内核与加载</span>
        </div>
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-title">终端加载方案</div>
            <p className={`settings-row-desc terminal-loading-support ${vsCodeSupport?.available ? 'available' : 'unavailable'}`}>
              {vsCodeSupport === null
                ? '正在检测系统 Node.js 和 VS Code 终端插件...'
                : vsCodeSupport.available
                  ? `${vsCodeSupport.reason}，可以启用 VS Code 模式。`
                  : `VS Code 模式不可用：${vsCodeSupport.reason}`}
            </p>
          </div>
          <div className="settings-row-ctrl">
            <div className="breathing-light-mode-options" role="radiogroup" aria-label="终端加载方案">
              <label className={`breathing-light-mode ${settings.terminalLoadingMode === 'default' ? 'active' : ''}`}>
                <input
                  type="radio"
                  name="terminalLoadingMode"
                  checked={settings.terminalLoadingMode === 'default'}
                  onChange={() => {
                    updateSetting('terminalLoadingMode', 'default');
                    saveTerminalLoadingMode('default').catch(console.error);
                  }}
                />
                <span>默认</span>
              </label>
              <label
                className={`breathing-light-mode ${settings.terminalLoadingMode === 'vsCode' ? 'active' : ''} ${vsCodeAvailable ? '' : 'disabled'}`}
                title={vsCodeSupport?.reason || '正在检测系统 Node.js'}
              >
                <input
                  type="radio"
                  name="terminalLoadingMode"
                  checked={settings.terminalLoadingMode === 'vsCode'}
                  disabled={!vsCodeAvailable}
                  onChange={() => {
                    updateSetting('terminalLoadingMode', 'vsCode');
                    saveTerminalLoadingMode('vsCode').catch(console.error);
                  }}
                />
                <span>VS Code</span>
              </label>
            </div>
          </div>
        </div>

        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-title">默认终端（实验）</div>
            <p className="settings-row-desc">
              开启后，双击 .bat、Win+R 运行 cmd 等新的控制台程序将在 TerminalBuddy 新标签页中打开。
              当前状态：{defaultTerminal?.description ?? '检测中…'}
            </p>
          </div>
          <div className="settings-row-ctrl">
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={defaultTerminal?.enabled ?? false}
                disabled={isBrowserClient()}
                onChange={(e) => {
                  toggleDefaultTerminal(e.target.checked);
                }}
              />
              <span className="hook-sr-only">默认终端</span>
            </label>
          </div>
        </div>
      </div>

      {/* 卡片组 2: 启动与窗口行为 */}
      <div className="settings-card-group">
        <div className="card-group-header">
          <span className="card-group-title">启动与窗口行为</span>
        </div>

        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-title">启动窗口模式</div>
            <p className="settings-row-desc">下次启动时直接按所选模式显示，不会先最大化再切回窗口</p>
          </div>
          <div className="settings-row-ctrl">
            <div className="breathing-light-mode-options">
              <label className={`breathing-light-mode ${settings.launchWindowMode === 'windowed' ? 'active' : ''}`}>
                <input
                  type="radio"
                  name="launchWindowMode"
                  disabled={isBrowserClient()}
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
                  disabled={isBrowserClient()}
                  checked={settings.launchWindowMode === 'maximized'}
                  onChange={() => {
                    updateSetting('launchWindowMode', 'maximized');
                    saveLaunchWindowMode('maximized').catch(console.error);
                  }}
                />
                <span>最大化启动</span>
              </label>
            </div>
          </div>
        </div>

        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-title">开机自动启动</div>
            <p className="settings-row-desc">登录 Windows 时自动启动 TerminalBuddy</p>
          </div>
          <div className="settings-row-ctrl">
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={settings.launchAtLogin}
                disabled={isBrowserClient()}
                onChange={(e) => {
                  const value = e.target.checked;
                  updateSetting('launchAtLogin', value);
                  saveLaunchAtLogin(value).catch(console.error);
                }}
              />
              <span className="hook-sr-only">开机自动启动</span>
            </label>
          </div>
        </div>

        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-title">关闭时最小化到托盘</div>
            <p className="settings-row-desc">关闭窗口时应用将隐藏到系统托盘，双击托盘图标或右键选择“打开窗口”可重新显示</p>
          </div>
          <div className="settings-row-ctrl">
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={settings.closeBehavior === 'tray'}
                disabled={isBrowserClient()}
                onChange={(e) => {
                  const value = e.target.checked ? 'tray' : 'exit';
                  updateSetting('closeBehavior', value);
                  saveCloseBehavior(value).catch(console.error);
                }}
              />
              <span className="hook-sr-only">关闭时最小化到托盘</span>
            </label>
          </div>
        </div>

        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-title">仅单窗口运行</div>
            <p className="settings-row-desc">重复启动时激活已有窗口，而非打开新窗口。需重启生效</p>
          </div>
          <div className="settings-row-ctrl">
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={settings.singleInstance}
                disabled={isBrowserClient()}
                onChange={(e) => {
                  const value = e.target.checked;
                  updateSetting('singleInstance', value);
                  saveSingleInstance(value).catch(console.error);
                }}
              />
              <span className="hook-sr-only">仅单窗口运行</span>
            </label>
          </div>
        </div>
      </div>

      {/* 卡片组 3: 会话与面板自动展开 */}
      <div className="settings-card-group">
        <div className="card-group-header">
          <span className="card-group-title">会话恢复与启动布局</span>
        </div>

        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-title">启动时恢复选项卡</div>
            <p className="settings-row-desc">关闭程序时自动保存打开的终端选项卡，下次启动时自动恢复</p>
          </div>
          <div className="settings-row-ctrl">
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={settings.restoreTabsOnStartup}
                onChange={(e) => updateSetting('restoreTabsOnStartup', e.target.checked)}
              />
              <span className="hook-sr-only">启动时恢复选项卡</span>
            </label>
          </div>
        </div>

        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-title">自动恢复 Claude Code 会话</div>
            <p className="settings-row-desc">启动时自动恢复上次的 Claude Code 会话（通过 claude --resume 继续对话）</p>
          </div>
          <div className="settings-row-ctrl">
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={settings.autoResumeClaudeSession}
                onChange={(e) => updateSetting('autoResumeClaudeSession', e.target.checked)}
              />
              <span className="hook-sr-only">自动恢复 Claude Code 会话</span>
            </label>
          </div>
        </div>

        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-title">启动时展开项目与命令面板</div>
            <p className="settings-row-desc">启动时自动展开左侧项目与命令面板</p>
          </div>
          <div className="settings-row-ctrl">
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={settings.configPanelAutoExpand}
                onChange={(e) => updateSetting('configPanelAutoExpand', e.target.checked)}
              />
              <span className="hook-sr-only">启动时展开项目与命令面板</span>
            </label>
          </div>
        </div>

        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-title">启动时展开文件与 Git 面板</div>
            <p className="settings-row-desc">启动时自动展开左侧文件与 Git 面板</p>
          </div>
          <div className="settings-row-ctrl">
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={settings.fileTreeAutoExpand}
                onChange={(e) => updateSetting('fileTreeAutoExpand', e.target.checked)}
              />
              <span className="hook-sr-only">启动时展开文件与 Git 面板</span>
            </label>
          </div>
        </div>

        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-title">启动时展开 Claude Code / Codex 会话面板</div>
            <p className="settings-row-desc">默认风格下启动即显示 Claude Code / Codex 会话列，标题栏按钮可随时切换</p>
          </div>
          <div className="settings-row-ctrl">
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={settings.historyPanelAutoExpand}
                onChange={(e) => updateSetting('historyPanelAutoExpand', e.target.checked)}
              />
              <span className="hook-sr-only">启动时展开 Claude Code / Codex 会话面板</span>
            </label>
          </div>
        </div>
      </div>

      {/* 卡片组 4: 终端交互细节 */}
      <div className="settings-card-group">
        <div className="card-group-header">
          <span className="card-group-title">交互细节与布局</span>
        </div>

        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-title">纵向会话标签</div>
            <p className="settings-row-desc">勾选时会话标签显示在左侧面板（纵向），未勾选时显示在终端上方（横向）</p>
          </div>
          <div className="settings-row-ctrl">
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
              <span className="hook-sr-only">纵向会话标签</span>
            </label>
          </div>
        </div>

        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-title">右键粘贴</div>
            <p className="settings-row-desc">右键时若无选中文本，直接粘贴剪贴板内容到终端</p>
          </div>
          <div className="settings-row-ctrl">
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={settings.rightClickPaste}
                onChange={(e) => {
                  updateSetting('rightClickPaste', e.target.checked);
                }}
              />
              <span className="hook-sr-only">右键粘贴</span>
            </label>
          </div>
        </div>

        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-title">双击运行 .bat 文件</div>
            <p className="settings-row-desc">开启后，在“文件与 Git”面板中双击 .bat 文件将直接运行；关闭时双击在编辑器中打开</p>
          </div>
          <div className="settings-row-ctrl">
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={settings.doubleClickRunBat}
                onChange={(e) => {
                  updateSetting('doubleClickRunBat', e.target.checked);
                }}
              />
              <span className="hook-sr-only">双击运行 .bat 文件</span>
            </label>
          </div>
        </div>
      </div>
    </div>
  );
};
