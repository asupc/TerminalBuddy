import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpCircle, CheckCircle2, CircleAlert, Download, LoaderCircle, RefreshCw, Save } from 'lucide-react';
import {
  getAgentCli, getAgentCliEnvironment, installAgentCli, updateAgentCli,
  type AgentCli, type AgentCliStatus, type AgentCliEnvironment,
} from '../../services/agentCli';
import { saveAgentCommands, getBackendAppSettings, saveAgentDownloadSource, type AgentDownloadSource } from '../../services/tauri';
import { useAppStore } from '../../stores/appStore';
import { DEFAULT_CLAUDE_COMMAND } from '../../utils/claudeLaunch';
import { DEFAULT_CODEX_COMMAND } from '../../utils/codexLaunch';
import { DEFAULT_ANTIGRAVITY_COMMAND } from '../../utils/antigravityLaunch';
import './AgentManagementSettings.css';

const tools = [
  { id: 'claude', name: 'Claude Code', defaultCommand: DEFAULT_CLAUDE_COMMAND, usesNpmSource: true },
  { id: 'codex', name: 'Codex CLI', defaultCommand: DEFAULT_CODEX_COMMAND, usesNpmSource: true },
  { id: 'antigravity', name: 'Antigravity CLI', defaultCommand: DEFAULT_ANTIGRAVITY_COMMAND, usesNpmSource: false },
] as const;
type ToolAction = 'check' | 'install' | 'update';

const createToolRecord = <T,>(initial: T): Record<AgentCli, T> => ({
  claude: initial,
  codex: initial,
  antigravity: initial,
});

/**
 * 各 Agent 的品牌标，均取自官方资源或几何标识：
 * Claude 星芒取自 claude.ai 的 favicon（原色 #D97757）；
 * Codex 用 ChatGPT 六瓣结（取自 chatgpt-guides.com/logo.svg，currentColor 染色）；
 * Antigravity CLI 使用 Google 蓝升空 A 形几何标识。
 */
function AgentBrandMark({ id }: { id: AgentCli }) {
  if (id === 'claude') {
    return (
      <svg viewBox="0 0 248 248" aria-hidden="true">
        <path fill="#D97757" d="M52.4285 162.873L98.7844 136.879L99.5485 134.602L98.7844 133.334H96.4921L88.7237 132.862L62.2346 132.153L39.3113 131.207L17.0249 130.026L11.4214 128.844L6.2 121.873L6.7094 118.447L11.4214 115.257L18.171 115.847L33.0711 116.911L55.485 118.447L71.6586 119.392L95.728 121.873H99.5485L100.058 120.337L98.7844 119.392L97.7656 118.447L74.5877 102.732L49.4995 86.1905L36.3823 76.62L29.3779 71.7757L25.8121 67.2858L24.2839 57.3608L30.6515 50.2716L39.3113 50.8623L41.4763 51.4531L50.2636 58.1879L68.9842 72.7209L93.4357 90.6804L97.0015 93.6343L98.4374 92.6652L98.6571 91.9801L97.0015 89.2625L83.757 65.2772L69.6214 40.8192L63.2534 30.6579L61.5978 24.632C60.9565 22.1032 60.579 20.0111 60.579 17.4246L67.8381 7.49965L71.9133 6.19995L81.7193 7.49965L85.7946 11.0443L91.9074 24.9865L101.714 46.8451L116.996 76.62L121.453 85.4816L123.873 93.6343L124.764 96.1155H126.292V94.6976L127.566 77.9197L129.858 57.3608L132.15 30.8942L132.915 23.4505L136.608 14.4708L143.994 9.62643L149.725 12.344L154.437 19.0788L153.8 23.4505L150.998 41.6463L145.522 70.1215L141.957 89.2625H143.994L146.414 86.7813L156.093 74.0206L172.266 53.698L179.398 45.6635L187.803 36.802L193.152 32.5484H203.34L210.726 43.6549L207.415 55.1159L196.972 68.3492L188.312 79.5739L175.896 96.2095L168.191 109.585L168.882 110.689L170.738 110.53L198.755 104.504L213.91 101.787L231.994 98.7149L240.144 102.496L241.036 106.395L237.852 114.311L218.495 119.037L195.826 123.645L162.07 131.592L161.696 131.893L162.137 132.547L177.36 133.925L183.855 134.279H199.774L229.447 136.524L237.215 141.605L241.8 147.867L241.036 152.711L229.065 158.737L213.019 154.956L175.45 145.977L162.587 142.787H160.805V143.85L171.502 154.366L191.242 172.089L215.82 195.011L217.094 200.682L213.91 205.172L210.599 204.699L188.949 188.394L180.544 181.069L161.696 165.118H160.422V166.772L164.752 173.152L187.803 207.771L188.949 218.405L187.294 221.832L181.308 223.959L174.813 222.777L161.187 203.754L147.305 182.486L136.098 163.345L134.745 164.2L128.075 235.42L125.019 239.082L117.887 241.8L111.902 237.31L108.718 229.984L111.902 215.452L115.722 196.547L118.779 181.541L121.58 162.873L123.291 156.636L123.14 156.219L121.773 156.449L107.699 175.752L86.304 204.699L69.3663 222.777L65.291 224.431L58.2867 220.768L58.9235 214.27L62.8713 208.48L86.304 178.705L100.44 160.155L109.551 149.507L109.462 147.967L108.959 147.924L46.6977 188.512L35.6182 189.93L30.7788 185.44L31.4156 178.115L33.7079 175.752L52.4285 162.873Z" />
      </svg>
    );
  }
  if (id === 'antigravity') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="#4285F4" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 3.5L4.5 20.5" />
        <path d="M12 3.5L19.5 20.5" />
        <path d="M7.5 14.5C9.8 11.8 14.2 11.8 16.5 14.5" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 320 320" fill="currentColor" aria-hidden="true">
      <path d="m297.06 130.97c7.26-21.79 4.76-45.66-6.85-65.48-17.46-30.4-52.56-46.04-86.84-38.68-15.25-17.18-37.16-26.95-60.13-26.81-35.04-.08-66.13 22.48-76.91 55.82-22.51 4.61-41.94 18.7-53.31 38.67-17.59 30.32-13.58 68.54 9.92 94.54-7.26 21.79-4.76 45.66 6.85 65.48 17.46 30.4 52.56 46.04 86.84 38.68 15.24 17.18 37.16 26.95 60.13 26.8 35.06.09 66.16-22.49 76.94-55.86 22.51-4.61 41.94-18.7 53.31-38.67 17.57-30.32 13.55-68.51-9.94-94.51zm-120.28 168.11c-14.03.02-27.62-4.89-38.39-13.88.49-.26 1.34-.73 1.89-1.07l63.72-36.8c3.26-1.85 5.26-5.32 5.24-9.07v-89.83l26.93 15.55c.29.14.48.42.52.74v74.39c-.04 33.08-26.83 59.9-59.91 59.97zm-128.84-55.03c-7.03-12.14-9.56-26.37-7.15-40.18.47.28 1.3.79 1.89 1.13l63.72 36.8c3.23 1.89 7.23 1.89 10.47 0l77.79-44.92v31.1c.02.32-.13.63-.38.83l-64.41 37.19c-28.69 16.52-65.33 6.7-81.92-21.95zm-16.77-139.09c7-12.16 18.05-21.46 31.21-26.29 0 .55-.03 1.52-.03 2.2v73.61c-.02 3.74 1.98 7.21 5.23 9.06l77.79 44.91-26.93 15.55c-.27.18-.61.21-.91.08l-64.42-37.22c-28.63-16.58-38.45-53.21-21.95-81.89zm221.26 51.49-77.79-44.92 26.93-15.54c.27-.18.61-.21.91-.08l64.42 37.19c28.68 16.57 38.51 53.26 21.94 81.94-7.01 12.14-18.05 21.44-31.2 26.28v-75.81c.03-3.74-1.96-7.2-5.2-9.06zm26.8-40.34c-.47-.29-1.3-.79-1.89-1.13l-63.72-36.8c-3.23-1.89-7.23-1.89-10.47 0l-77.79 44.92v-31.1c-.02-.32.13-.63.38-.83l64.41-37.16c28.69-16.55 65.37-6.7 81.91 22 6.99 12.12 9.52 26.31 7.15 40.1zm-168.51 55.43-26.94-15.55c-.29-.14-.48-.42-.52-.74v-74.39c.02-33.12 26.89-59.96 60.01-59.94 14.01 0 27.57 4.92 38.34 13.88-.49.26-1.33.73-1.89 1.07l-63.72 36.8c-3.26 1.85-5.26 5.31-5.24 9.06l-.04 89.79zm14.63-31.54 34.65-20.01 34.65 20v40.01l-34.65 20-34.65-20z" />
    </svg>
  );
}

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
  const [actions, setActions] = useState<Record<AgentCli, ToolAction | null>>(() => createToolRecord<ToolAction | null>(null));
  const [errors, setErrors] = useState<Record<AgentCli, string>>(() => createToolRecord(''));
  const [error, setError] = useState('');
  const [downloadSource, setDownloadSource] = useState<AgentDownloadSource | null>(null);
  const [savingSource, setSavingSource] = useState(false);
  const [sourceError, setSourceError] = useState('');
  const sourcePending = useRef(false);
  const refreshPending = useRef(false);
  const busyTools = useRef(new Set<AgentCli>());
  const revisions = useRef<Record<AgentCli, number>>(createToolRecord(0));

  const agentCommands = useAppStore(state => state.agentCommands);
  const setAgentCommands = useAppStore(state => state.setAgentCommands);
  const [commands, setCommands] = useState<Record<AgentCli, string>>(() => createToolRecord(''));
  const [commandsDirty, setCommandsDirty] = useState<Record<AgentCli, boolean>>(() => createToolRecord(false));
  const [savingCommand, setSavingCommand] = useState<AgentCli | null>(null);
  const [commandsMessage, setCommandsMessage] = useState<Record<AgentCli, string>>(() => createToolRecord(''));

  useEffect(() => {
    // 只同步未编辑的条目，避免覆盖另一个工具正在输入的内容。
    setCommands(current => ({
      claude: commandsDirty.claude ? current.claude : agentCommands.claude,
      codex: commandsDirty.codex ? current.codex : agentCommands.codex,
      antigravity: commandsDirty.antigravity ? current.antigravity : agentCommands.antigravity,
    }));
  }, [agentCommands, commandsDirty]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setDownloadSource(null);
    void getBackendAppSettings()
      .then(settings => {
        if (cancelled) return;
        setDownloadSource(settings.agentDownloadSource ?? 'npmmirror');
        setSourceError('');
      })
      .catch(reason => {
        if (!cancelled) setSourceError(`读取下载源失败：${reason instanceof Error ? reason.message : String(reason)}`);
      });
    return () => { cancelled = true; };
  }, [active]);

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
    const usesNpmSource = tools.find(item => item.id === tool)?.usesNpmSource ?? true;
    if ((usesNpmSource && (!downloadSource || sourcePending.current)) || busyTools.current.has(tool) || isRunning(environment?.[tool])) return;
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
      setErrors(value => ({ ...value, [tool]: `${label}失败：${reason instanceof Error ? reason.message : String(reason)}` }));
    } finally {
      revisions.current[tool] += 1;
      busyTools.current.delete(tool);
      setActions(value => ({ ...value, [tool]: null }));
    }
  };

  const changeDownloadSource = async (source: AgentDownloadSource) => {
    if (sourcePending.current || source === downloadSource) return;
    sourcePending.current = true;
    setSavingSource(true);
    setSourceError('');
    try {
      await saveAgentDownloadSource(source);
      setDownloadSource(source);
      for (const tool of tools) {
        if (tool.usesNpmSource) revisions.current[tool.id] += 1;
      }
      setErrors(current => ({ ...current, claude: '', codex: '' }));
      setEnvironment(current => {
        if (!current) return null;
        const next = { ...current };
        for (const tool of tools) {
          if (tool.usesNpmSource) {
            next[tool.id] = { ...current[tool.id], update: null, message: null, updatedVersion: null };
          }
        }
        return next;
      });
      await refresh();
    } catch (reason) {
      setSourceError(`切换下载源失败：${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      sourcePending.current = false;
      setSavingSource(false);
    }
  };

  const saveCommand = async (tool: AgentCli) => {
    if (savingCommand) return;
    setSavingCommand(tool);
    setCommandsMessage(value => ({ ...value, [tool]: '' }));
    try {
      const command = commands[tool].trim();
      // save_agent_commands 一次写全量基础命令：当前工具用草稿，其它工具沿用已保存值，
      // 避免把用户尚未保存的其它编辑项一并写回。
      const next = { ...agentCommands, [tool]: command };
      await saveAgentCommands(next.claude, next.codex, next.antigravity);
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
      <div className="settings-card-group">
        <div className="card-group-header">
          <span className="card-group-title">npm 下载源配置</span>
        </div>
        <div className="settings-row settings-row--wrap-ctrl">
          <div className="settings-row-info">
            <label className="settings-row-title" htmlFor="agent-download-source">版本检查与安装源</label>
            <p className="settings-row-desc">
              {downloadSource === 'npmmirror'
                ? 'registry.npmmirror.com · 仅用于 Claude Code 与 Codex CLI 的检查、安装和更新（国内镜像）。安装需要 Node.js（建议 ≥ 22.19）；镜像同步可能稍有延迟。'
                : downloadSource === 'official'
                  ? 'registry.npmjs.org · 仅用于 Claude Code 与 Codex CLI，使用官方版本源和安装渠道，需要能访问国外下载站点。'
                  : '仅用于 Claude Code 与 Codex CLI 的版本检查、安装和更新，选择后自动保存。'}
            </p>
            {sourceError && <p className="container-environment-error" role="alert">{sourceError}</p>}
          </div>
          <div className="settings-row-ctrl">
            <select
              id="agent-download-source"
              className="tb-select"
              style={{ width: 224 }}
              value={downloadSource ?? ''}
              disabled={!downloadSource || savingSource || working || refreshing || tools.some(tool => actions[tool.id] !== null)}
              onChange={event => { void changeDownloadSource(event.target.value as AgentDownloadSource); }}
            >
              {!downloadSource && <option value="">正在读取…</option>}
              <option value="npmmirror">国内镜像（npmmirror，默认）</option>
              <option value="official">官方源</option>
            </select>
            {savingSource && <LoaderCircle size={14} className="container-environment-spin" aria-label="保存中" />}
          </div>
        </div>
      </div>
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

          return <section key={tool.id} className={`container-environment-tool agent-cli-${tool.id}`} aria-label={tool.name}>
            <div className="container-environment-tool-header">
              <span className="container-environment-tool-icon"><AgentBrandMark id={tool.id} /></span>
              <div className="container-environment-tool-details">
                <div className="container-environment-tool-name">
                  <strong>{tool.name}</strong>
                  {cli?.version
                    ? <code className="agent-cli-version" title={update?.latestVersion ? `最新版本 ${update.latestVersion}` : undefined}>v{cli.version}</code>
                    : <span className="agent-cli-version-muted">{installing ? '安装中…' : cli ? '未安装' : refreshing ? '检测中…' : '等待检测'}</span>}
                  {update?.latestVersion && cli?.version !== update.latestVersion && <span className="agent-cli-version-muted">→ v{update.latestVersion}</span>}
                </div>
                <p className="container-environment-hint">
                  {updating || installing
                    ? (tool.usesNpmSource
                      ? `正在通过${downloadSource === 'npmmirror' ? '国内镜像' : '官方源'}下载安装，离开设置页不会中断。`
                      : '正在通过 Google 官方源下载安装，离开设置页不会中断。')
                    : cli && cli.status !== 'installed'
                      ? (tool.usesNpmSource
                        ? (downloadSource === 'npmmirror' ? '通过国内 npm 镜像安装（需要 Node.js）' : '通过官方渠道安装')
                        : '通过 Google 官方发布源安装（需可访问 Google 服务）')
                      : cli && !tool.usesNpmSource
                        ? '使用 Google 官方发布源检查更新（不受 npm 下载源影响）'
                        : null}
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
                  disabled={busy || (tool.usesNpmSource && (savingSource || !downloadSource))} onClick={() => { void runAction(tool.id, nextAction); }}
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
              {commandsMessage[tool.id] && (
                <span
                  className={commandsMessage[tool.id] === '已保存' ? 'agent-command-saved' : 'container-environment-error'}
                  role="status"
                  aria-live="polite"
                >{commandsMessage[tool.id]}</span>
              )}
            </div>
            {toolError && <p className="container-environment-error container-environment-install-error" role="alert">{toolError}</p>}
          </section>;
        })}
      </div>
      <p className="container-environment-hint container-environment-footer">每个工具可独立检查、更新与保存基础命令；切换下载源后请重新检查更新，更新成功后请新建终端使用新版。</p>
    </div>
  );
}
