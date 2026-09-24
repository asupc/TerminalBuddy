import { FC, useEffect, useState } from 'react';
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
      <div className="settings-section">
        <label className="settings-label">终端加载方案</label>
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
        <p className={`settings-desc terminal-loading-support ${vsCodeSupport?.available ? 'available' : 'unavailable'}`}>
          {vsCodeSupport === null
            ? '正在检测系统 Node.js 和 VS Code 终端插件...'
            : vsCodeSupport.available
              ? `${vsCodeSupport.reason}，可以启用 VS Code 模式。`
              : `VS Code 模式不可用：${vsCodeSupport.reason}`}
        </p>
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
            checked={settings.historyPanelAutoExpand}
            onChange={(e) => updateSetting('historyPanelAutoExpand', e.target.checked)}
          />
          <span>启动时展开会话历史面板</span>
        </label>
        <p className="settings-desc">默认风格下启动即显示会话历史列，标题栏按钮可随时切换</p>
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
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={defaultTerminal?.enabled ?? false}
            onChange={(e) => {
              toggleDefaultTerminal(e.target.checked);
            }}
          />
          <span>默认终端（实验）</span>
        </label>
        <p className="settings-desc">
          开启后，双击 .bat、Win+R 运行 cmd 等新的控制台程序将在 TerminalBuddy 新标签页中打开。
          可用 Win+R 运行 cmd.exe 验证接管效果。需已安装 Windows Terminal；不会出现在
          Windows 设置的「默认终端」下拉列表中。关闭后恢复先前设置。
        </p>
        <p className="settings-desc">当前状态：{defaultTerminal?.description ?? '检测中…'}</p>
      </div>
    </div>
  );
};
