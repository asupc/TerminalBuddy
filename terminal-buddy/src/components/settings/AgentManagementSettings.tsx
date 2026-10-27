import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpCircle, CheckCircle2, CircleAlert, Download, LoaderCircle, RefreshCw, Save, TerminalSquare } from 'lucide-react';
import {
  getAgentCli, getAgentCliEnvironment, installAgentCli, updateAgentCli,
  type AgentCli, type AgentCliStatus, type AgentCliEnvironment,
} from '../../services/agentCli';
import { saveAgentCommands, getBackendAppSettings } from '../../services/tauri';
import { getPiExtensionState, installPiExtension, uninstallPiExtension, savePiToolApprovalEnabled, type PiExtensionState } from '../../services/tauri';
import { useAppStore } from '../../stores/appStore';
import { DEFAULT_CLAUDE_COMMAND } from '../../utils/claudeLaunch';
import { DEFAULT_CODEX_COMMAND } from '../../utils/codexLaunch';
import { DEFAULT_PI_COMMAND } from '../../utils/piLaunch';
import './AgentManagementSettings.css';

const tools = [
  { id: 'claude', name: 'Claude Code', defaultCommand: DEFAULT_CLAUDE_COMMAND },
  { id: 'codex', name: 'Codex CLI', defaultCommand: DEFAULT_CODEX_COMMAND },
  { id: 'pi', name: 'Pi', defaultCommand: DEFAULT_PI_COMMAND },
] as const;
type ToolAction = 'check' | 'install' | 'update';

function isRunning(cli: AgentCliStatus | undefined): boolean {
  return cli?.status === 'installing' || cli?.status === 'updating';
}

function preserveUpdate(previous: AgentCliStatus | undefined, next: AgentCliStatus): AgentCliStatus {
  return {
    ...next,
    update: next.update ?? (
      previous?.version === next.version && previous?.status === next.status ? previous.update : null
    ),
  };
}

interface AgentManagementSettingsProps {
  active: boolean;
}

export function AgentManagementSettings({ active }: AgentManagementSettingsProps) {
  const [environment, setEnvironment] = useState<AgentCliEnvironment | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [actions, setActions] = useState<Record<AgentCli, ToolAction | null>>({ claude: null, codex: null, pi: null });
  const [errors, setErrors] = useState<Record<AgentCli, string>>({ claude: '', codex: '', pi: '' });
  const [error, setError] = useState('');
  const refreshPending = useRef(false);
  const busyTools = useRef(new Set<AgentCli>());
  const revisions = useRef<Record<AgentCli, number>>({ claude: 0, codex: 0, pi: 0 });

  const agentCommands = useAppStore(state => state.agentCommands);
  const setAgentCommands = useAppStore(state => state.setAgentCommands);
  const [commands, setCommands] = useState<Record<AgentCli, string>>({ claude: '', codex: '', pi: '' });
  const [commandsDirty, setCommandsDirty] = useState<Record<AgentCli, boolean>>({ claude: false, codex: false, pi: false });
  const [savingCommand, setSavingCommand] = useState<AgentCli | null>(null);
  const [commandsMessage, setCommandsMessage] = useState<Record<AgentCli, string>>({ claude: '', codex: '', pi: '' });
  const [piApprovalEnabled, setPiApprovalEnabled] = useState(false);
  const [piExtension, setPiExtension] = useState<PiExtensionState | null>(null);
  const [piSettingsBusy, setPiSettingsBusy] = useState(false);

  useEffect(() => {
    // 只同步未编辑的条目，避免覆盖另一个工具正在输入的内容。
    setCommands(current => ({
      claude: commandsDirty.claude ? current.claude : agentCommands.claude,
      codex: commandsDirty.codex ? current.codex : agentCommands.codex,
      pi: commandsDirty.pi ? current.pi : agentCommands.pi,
    }));
  }, [agentCommands, commandsDirty]);

  useEffect(() => {
    if (!active) return;
    void getBackendAppSettings()
      .then(settings => setPiApprovalEnabled(Boolean(settings.piToolApprovalEnabled)))
      .catch(() => {});
    void getPiExtensionState().then(setPiExtension).catch(() => setPiExtension(null));
  }, [active]);

  const togglePiApproval = async (enabled: boolean) => {
    setPiSettingsBusy(true);
    try {
      await savePiToolApprovalEnabled(enabled);
      setPiApprovalEnabled(enabled);
    } catch (reason) {
      setErrors(value => ({ ...value, pi: `保存 Pi 工具确认设置失败：${reason instanceof Error ? reason.message : '请重试'}` }));
    } finally {
      setPiSettingsBusy(false);
    }
  };

  const togglePiExtension = async () => {
    setPiSettingsBusy(true);
    try {
      if (piExtension?.globallyInstalled) await uninstallPiExtension();
      else await installPiExtension();
      setPiExtension(await getPiExtensionState());
    } catch (reason) {
      setErrors(value => ({ ...value, pi: `Pi 扩展操作失败：${reason instanceof Error ? reason.message : '请重试'}` }));
    } finally {
      setPiSettingsBusy(false);
    }
  };

  const refresh = useCallback(async () => {
    if (refreshPending.current) return;
    refreshPending.current = true;
    setRefreshing(true);
    const requestedRevisions = { ...revisions.current };
    try {
      const value = await getAgentCliEnvironment();
      // 历史面板等组件据此即时显示新安装的 Agent 标签，无需刷新页面。
      window.dispatchEvent(new CustomEvent('agent-cli-status-changed', { detail: value }));
      setEnvironment(current => {
        if (!current) return value;
        const next = { ...current };
        for (const tool of tools) {
          // 每个条目独立合并，迟到的整体检测不能覆盖该条目刚开始或已完成的操作。
          if (requestedRevisions[tool.id] === revisions.current[tool.id] && !busyTools.current.has(tool.id)) {
            next[tool.id] = preserveUpdate(current[tool.id], value[tool.id]);
          }
        }
        return next;
      });
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '环境检测失败，请重试');
    } finally {
      refreshPending.current = false;
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

  const working = tools.some(tool => isRunning(environment?.[tool.id])
    || actions[tool.id] === 'install' || actions[tool.id] === 'update');
  useEffect(() => {
    if (!working) return;
    // 离开分区后继续轮询后台安装或更新，返回时仍能看到实际版本与任务结果。
    const timer = window.setInterval(() => { void refresh(); }, 2000);
    return () => window.clearInterval(timer);
  }, [working, refresh]);

  const runAction = async (tool: AgentCli, action: ToolAction) => {
    if (busyTools.current.has(tool) || isRunning(environment?.[tool])) return;
    busyTools.current.add(tool);
    revisions.current[tool] += 1;
    setActions(value => ({ ...value, [tool]: action }));
    setErrors(value => ({ ...value, [tool]: '' }));
    const apply = (value: AgentCliStatus) => {
      setEnvironment(current => current ? { ...current, [tool]: value } : current);
    };
    try {
      const value = await (action === 'check' ? getAgentCli(tool, true)
        : action === 'update' ? updateAgentCli(tool) : installAgentCli(tool));
      apply(value);
    } catch (reason) {
      if (action !== 'check') {
        // 请求响应丢失时，后台任务可能已经启动，先恢复该条目的实际状态。
        try {
          const value = await getAgentCli(tool);
          apply(value);
          if (isRunning(value) || (action === 'update' && value.updatedVersion && value.updatedVersion === value.version && value.version !== environment?.[tool]?.version)) return;
        } catch { /* 保留下方原始错误，允许重新检测或重试。 */ }
      }
      const label = action === 'check' ? '检查更新' : action === 'update' ? '更新' : '安装';
      setErrors(value => ({ ...value, [tool]: `${label}失败：${reason instanceof Error ? reason.message : '请重试'}` }));
    } finally {
      revisions.current[tool] += 1;
      busyTools.current.delete(tool);
      setActions(value => ({ ...value, [tool]: null }));
    }
  };

  const saveCommand = async (tool: AgentCli) => {
    if (savingCommand) return;
    setSavingCommand(tool);
    setCommandsMessage(value => ({ ...value, [tool]: '' }));
    try {
      const command = commands[tool].trim();
      // save_agent_commands 一次写两个值：当前工具用草稿，另一个工具沿用已保存值，
      // 避免把用户尚未保存的另一侧编辑一并写回。
      const next = { ...agentCommands, [tool]: command };
      await saveAgentCommands(next.claude, next.codex, next.pi);
      setAgentCommands(next);
      setCommands(value => ({ ...value, [tool]: command }));
      setCommandsDirty(value => ({ ...value, [tool]: false }));
      setCommandsMessage(value => ({ ...value, [tool]: '已保存' }));
    } catch (reason) {
      setCommandsMessage(value => ({
        ...value,
        [tool]: reason instanceof Error ? reason.message : '保存失败，请重试',
      }));
    } finally {
      setSavingCommand(null);
    }
  };

  return (
    <div className="agent-management-settings">
      <div className="settings-card-group container-environment-list agent-cli-list">
        <div className="card-group-header container-environment-toolbar">
          <span className="card-group-title">命令行工具</span>
          <button type="button" className="container-environment-action" disabled={refreshing} onClick={() => { void refresh(); }}>
            <RefreshCw size={14} className={refreshing ? 'container-environment-spin' : undefined} aria-hidden="true" />
            {refreshing ? '检测中…' : '重新检测'}
          </button>
        </div>
        {error && <p className="container-environment-error container-environment-check-error" role="alert">{error}</p>}
        {tools.map(tool => {
          const cli = environment?.[tool.id];
          const action = actions[tool.id];
          const checking = action === 'check';
          const updating = action === 'update' || cli?.status === 'updating';
          const installing = action === 'install' || cli?.status === 'installing';
          const busy = checking || updating || installing;
          const update = cli?.update;
          const nextAction: ToolAction = cli?.version ? update?.state === 'available' ? 'update' : 'check' : 'install';
          const buttonText = checking ? '检查中…' : updating ? '更新中…' : installing ? '安装中…'
            : nextAction === 'update' ? '更新' : nextAction === 'check' ? '检查更新'
              : cli?.status === 'failed' ? '重试安装' : '一键安装';
          const statusText = updating ? '正在更新…' : installing ? '正在安装…'
            : cli?.status === 'installed' ? '已安装' : cli?.status === 'failed' ? '安装失败'
              : cli ? '未安装' : refreshing ? '正在检测…' : '等待检测';
          const updated = !!cli?.updatedVersion && cli.updatedVersion === cli.version && !cli.message;
          const updateText = checking ? '正在检查更新…' : updating || installing ? ''
            : update?.state === 'available' ? '发现新版本'
              : updated ? `更新成功，当前版本 ${cli.version}`
                : update?.state === 'upToDate' ? '已是最新版本'
                  : update?.state === 'ahead' ? '当前版本较新'
                    : update?.state === 'unknown' && cli?.version ? '当前构建无法比较版本' : '';
          const toolError = busy ? '' : errors[tool.id] || cli?.message
            || (update?.message ? `检查更新失败：${update.message}` : '');

          return <section key={tool.id} className="container-environment-tool" aria-label={tool.name}>
            <div className="container-environment-tool-header">
              <span className="container-environment-tool-icon"><TerminalSquare size={18} aria-hidden="true" /></span>
              <div className="container-environment-tool-details">
                <div className="container-environment-tool-name"><strong>{tool.name}</strong></div>
                <div className="container-environment-versions">
                  <span className="container-environment-version">
                    当前版本：<code>{cli?.version ?? (installing ? '安装中…' : cli ? '未安装' : refreshing ? '检测中…' : '等待检测')}</code>
                  </span>
                  {update?.latestVersion && <span className="container-environment-version">
                    最新版本：<code>{update.latestVersion}</code>
                  </span>}
                </div>
                <p className="container-environment-hint">
                  {updating ? '正在下载安装新版本，离开设置页不会中断。'
                    : installing ? '正在下载安装，离开设置页不会中断。'
                      : cli?.status === 'installed' ? <>在终端输入 <code>{tool.id}</code> 即可启动</>
                        : cli ? (tool.id === 'pi' ? '通过 npm 安装到用户目录（需要 Node.js ≥ 22.19）' : '使用官方安装器安装') : '检测安装状态与版本'}
                </p>
                {updateText && <p className={`container-environment-update ${checking ? 'checking' : updated && update?.state !== 'available' ? 'upToDate' : update?.state}`} role="status" aria-live="polite">
                  {checking ? <LoaderCircle size={13} className="container-environment-spin" aria-hidden="true" />
                    : update?.state === 'available' ? <ArrowUpCircle size={13} aria-hidden="true" />
                      : update?.state === 'unknown' && !updated ? <CircleAlert size={13} aria-hidden="true" />
                        : <CheckCircle2 size={13} aria-hidden="true" />}
                  {updateText}
                </p>}
              </div>
              <div className="container-environment-controls">
                <span className={`container-environment-status ${updating ? 'updating' : installing ? 'installing' : cli?.status ?? 'checking'}`} role="status" aria-live="polite">
                  {updating || installing || (!cli && refreshing) ? <LoaderCircle size={14} className="container-environment-spin" aria-hidden="true" />
                    : cli?.status === 'installed' ? <CheckCircle2 size={14} aria-hidden="true" /> : <CircleAlert size={14} aria-hidden="true" />}
                  {statusText}
                </span>
                {cli && <button
                  type="button" className={`container-environment-action${nextAction === 'check' && !updating ? '' : ' primary'}`}
                  disabled={busy} onClick={() => { void runAction(tool.id, nextAction); }}
                  aria-label={`${buttonText} ${tool.name}`}
                >
                  {busy ? <LoaderCircle size={14} className="container-environment-spin" aria-hidden="true" />
                    : nextAction === 'check' ? <RefreshCw size={14} aria-hidden="true" /> : <Download size={14} aria-hidden="true" />}
                  {buttonText}
                </button>}
              </div>
            </div>
            <div className="agent-command-field">
              <div className="agent-command-editor">
                <label className="agent-command-label" htmlFor={`agent-command-${tool.id}`}>基础启动命令</label>
                <input
                  id={`agent-command-${tool.id}`}
                  value={commands[tool.id]}
                  placeholder={tool.defaultCommand}
                  spellCheck={false}
                  disabled={savingCommand !== null}
                  onChange={event => {
                    setCommands(value => ({ ...value, [tool.id]: event.target.value }));
                    setCommandsDirty(value => (value[tool.id] ? value : { ...value, [tool.id]: true }));
                    setCommandsMessage(value => ({ ...value, [tool.id]: '' }));
                  }}
                />
                <button
                  type="button"
                  className="container-environment-action primary"
                  disabled={!commandsDirty[tool.id] || savingCommand !== null}
                  onClick={() => { void saveCommand(tool.id); }}
                >
                  {savingCommand === tool.id
                    ? <LoaderCircle size={14} className="container-environment-spin" aria-hidden="true" />
                    : <Save size={14} aria-hidden="true" />}
                  {savingCommand === tool.id ? '保存中…' : '保存'}
                </button>
              </div>
              <p className="agent-command-hint">
                项目按模型启动 Agent 与历史会话恢复时，以此命令为基础继承参数（如
                <code> --dangerously-skip-permissions</code>）；留空使用内置默认。
              </p>
              {commandsMessage[tool.id] && (
                <span
                  className={commandsMessage[tool.id] === '已保存' ? 'agent-command-saved' : 'container-environment-error'}
                  role="status"
                  aria-live="polite"
                >{commandsMessage[tool.id]}</span>
              )}
              {tool.id === 'pi' && (
                <div className="pi-agent-extra-settings">
                  <label className="pi-agent-toggle">
                    <input
                      type="checkbox"
                      checked={piApprovalEnabled}
                      disabled={piSettingsBusy}
                      onChange={event => void togglePiApproval(event.target.checked)}
                    />
                    工具确认（bash/edit/write 执行前询问；默认关闭，开启会改变 Pi 的全权限行为）
                  </label>
                  <div className="pi-agent-extension-row">
                    <span>
                      Pi 扩展：{piExtension?.globallyInstalled ? '已全局安装' : piExtension?.installed ? '已随启动注入' : '未安装'}
                    </span>
                    <button
                      type="button"
                      className="container-environment-action"
                      disabled={piSettingsBusy}
                      onClick={() => void togglePiExtension()}
                    >
                      {piExtension?.globallyInstalled ? '卸载全局扩展' : '全局安装扩展'}
                    </button>
                  </div>
                  <small className="agent-command-hint">
                    TerminalBuddy 启动的 Pi 会自动注入扩展；全局安装可覆盖手动启动的 pi。扩展仅上报会话与状态，无 TerminalBuddy 环境变量时完全 no-op。
                  </small>
                </div>
              )}
            </div>
            {toolError && <p className="container-environment-error container-environment-install-error" role="alert">{toolError}</p>}
          </section>;
        })}
      </div>
      <p className="container-environment-hint container-environment-footer">每个工具可独立检查、更新与保存基础命令；更新成功后会自动显示实际安装的版本。</p>
    </div>
  );
}
