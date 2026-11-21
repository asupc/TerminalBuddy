import { FC, lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  BrainCircuit,
  Boxes,
  Container,
  Database,
  FileJson,
  FileX2,
  Globe2,
  Keyboard,
  Palette,
  Plug,
  Search,
  Server,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  SquareTerminal,
  type LucideIcon,
} from 'lucide-react';
import {
  getBackendAppSettings,
  getDataPath,
  getDownloadsDirectory,
  getVsCodeTerminalSupport,
  syncLaunchAtLogin,
  type VsCodeTerminalSupport,
} from '../../services/tauri';
import { type AppSettings, getAppSettings, saveAppSettings } from '../../utils/settings';
import { useAppStore } from '../../stores/appStore';
import { isDockerClient } from '../../services/platform';
import { ConfirmDialog, Dialog } from '../shared/Dialog';
import './SettingsPage.css';

const BehaviorSettings = lazy(() => import('./BehaviorSettings').then(module => ({ default: module.BehaviorSettings })));
const AppearanceSettings = lazy(() => import('./AppearanceSettings').then(module => ({ default: module.AppearanceSettings })));
const HotkeySettings = lazy(() => import('./HotkeySettings').then(module => ({ default: module.HotkeySettings })));
const DataSettings = lazy(() => import('./DataSettings').then(module => ({ default: module.DataSettings })));
const ProfilesSettings = lazy(() => import('./ProfilesSettings').then(module => ({ default: module.ProfilesSettings })));
const CommandsSettings = lazy(() => import('./CommandsSettings').then(module => ({ default: module.CommandsSettings })));
const ExclusionSettings = lazy(() => import('./ExclusionSettings').then(module => ({ default: module.ExclusionSettings })));
const AiUsageSettings = lazy(() => import('./AiUsageSettings').then(module => ({ default: module.AiUsageSettings })));
const SshSettings = lazy(() => import('./SshSettings').then(module => ({ default: module.SshSettings })));
const WebManageSettings = lazy(() => import('../shared/WebManageDialog').then(module => ({ default: module.WebManageSettings })));
const AgentManagementSettings = lazy(() => import('./AgentManagementSettings').then(module => ({ default: module.AgentManagementSettings })));
const LlmProvidersSettings = lazy(() => import('./LlmProvidersSettings').then(module => ({ default: module.LlmProvidersSettings })));
const ClaudeSettingsEditor = lazy(() => import('../claude-panel/segments/ClaudeSettingsSegment').then(module => ({ default: module.ClaudeSettingsSegment })));
const WebAuthSettings = lazy(() => import('./WebAuthSettings').then(module => ({ default: module.WebAuthSettings })));

interface SettingsPageProps {
  onClose: () => void;
}

const SETTINGS_DIALOG_SIZE_KEY = 'settings.dialogSize';

interface SettingsDialogSize {
  width: number;
  height: number;
}

function readSettingsDialogSize(): SettingsDialogSize | null {
  try {
    const raw = localStorage.getItem(SETTINGS_DIALOG_SIZE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SettingsDialogSize> | null;
    if (
      !parsed
      || typeof parsed.width !== 'number'
      || typeof parsed.height !== 'number'
      || !Number.isFinite(parsed.width)
      || !Number.isFinite(parsed.height)
    ) {
      return null;
    }
    return {
      width: Math.min(parsed.width, Math.max(0, window.innerWidth - 48)),
      height: Math.min(parsed.height, Math.max(0, window.innerHeight - 48)),
    };
  } catch {
    return null;
  }
}

type SettingsSectionId =
  | 'behavior'
  | 'appearance'
  | 'hotkeys'
  | 'data'
  | 'profiles'
  | 'commands'
  | 'exclusions'
  | 'ai-usage'
  | 'ssh'
  | 'web-auth'
  | 'web-management'
  | 'agent-cli'
  | 'llm-providers'
  | 'claude-settings';

interface SettingsSection {
  id: SettingsSectionId;
  label: string;
  icon: LucideIcon;
  keywords?: string[];
  description?: string;
}

interface SettingsGroup {
  id: string;
  label: string;
  sections: SettingsSection[];
}

const SECTION_GROUPS: ReadonlyArray<SettingsGroup> = [
  {
    id: 'general',
    label: '常规与偏好',
    sections: [
      { id: 'behavior', label: '行为设置', icon: SlidersHorizontal, description: '内核引擎、启动与窗口行为、恢复选项卡与 Claude 会话', keywords: ['loading', 'vscode', 'window', 'startup', 'resume', '默认终端', '归档', 'archive', '自动归档', '空闲', '进程', '回收', 'idle', 'recycle', '实验', '实验性', '项目与任务', '任务', '会话', 'markdown', 'md', '源码', '分屏', '预览', '打开方式'] },
      { id: 'appearance', label: '外观设置', icon: Palette, description: '主题、界面风格、显示任务摘要、呼吸指示灯与色彩方案', keywords: ['theme', 'dark', 'light', 'color', 'sidebar', 'indicator', '任务', '摘要', '标题', 'summary', 'codex'] },
      { id: 'hotkeys', label: '快捷键设置', icon: Keyboard, description: '唤起主窗口、新建终端与关闭标签快捷键录制', keywords: ['key', 'shortcut', 'bind'] },
      { id: 'data', label: '数据管理', icon: Database, description: '数据存储路径迁移、完整备份与恢复导入', keywords: ['path', 'backup', 'export', 'import'] },
    ],
  },
  {
    id: 'terminal',
    label: '终端与连接',
    sections: [
      { id: 'profiles', label: '项目与连接', icon: Plug, description: '按项目与分组集中管理终端、SSH、容器及远程桌面连接', keywords: ['profile', 'ssh', 'docker', 'powershell', 'cmd', 'mstsc', 'rdp', '项目与命令', '连接'] },
      { id: 'commands', label: '命令模板', icon: SquareTerminal, description: '常用终端命令模板库与自定义命令', keywords: ['template', 'cmd', 'snippet'] },
      { id: 'ssh', label: 'SSH 设置', icon: Server, description: 'SSH 远程文件下载路径与服务器负载探针刷新', keywords: ['download', 'monitor', 'cpu', 'memory'] },
      // Docker 网页版专属：非 Docker 环境在 visibleGroups 中过滤掉
      { id: 'web-auth', label: '网页认证', icon: ShieldCheck, description: 'Docker 网页登录管理员密码与主页标题', keywords: ['web', 'docker', 'password', 'title', 'login', 'auth', '认证', '标题'] },
    ],
  },
  {
    id: 'ai',
    label: 'Agent & LLM',
    sections: [
      { id: 'agent-cli', label: 'Agent 管理', icon: Container, description: 'Claude Code、Codex CLI 与 Antigravity CLI 的安装、更新与基础启动命令', keywords: ['agent', 'claude', 'codex', 'antigravity', 'agy', 'cli', '安装', '环境', '版本', '更新', '启动命令'] },
      { id: 'llm-providers', label: '模型供应商', icon: Boxes, description: 'Claude 与 Codex 供应商的端点、密钥与模型配置', keywords: ['ai', 'provider', 'model', 'deepseek', 'anthropic', 'codex', 'api'] },
      { id: 'claude-settings', label: 'Claude 默认配置', icon: FileJson, description: '用户级 settings.json 图形化配置、官方说明与快照备份', keywords: ['claude', 'settings.json', 'effort', 'token', 'context'] },
      { id: 'ai-usage', label: 'AI 用量', icon: BrainCircuit, description: '配置各厂商控制台 API Key 或 Cookie，用于顶部工具栏实时查询套餐余量', keywords: ['usage', 'token', 'cost', 'stats', 'apikey', 'cookie', '用量'] },
    ],
  },
  {
    id: 'extensions',
    label: '扩展与服务',
    sections: [
      { id: 'web-management', label: 'Web 管理', icon: Globe2, description: '局域网 Web 终端访问服务与扫码连接', keywords: ['web', 'remote', 'port', 'password'] },
      { id: 'exclusions', label: '文件排除', icon: FileX2, description: '项目文件树只读监视排除正则与忽略目录', keywords: ['exclude', 'ignore', 'tree'] },
    ],
  },
];

export const SettingsPage: FC<SettingsPageProps> = ({ onClose }) => {
  const [settings, setSettings] = useState<AppSettings>(getAppSettings);
  // 「网页认证」与「容器环境」仅 Docker 网页版显示；运行时探测在 App 渲染前完成
  const dockerClient = isDockerClient();
  const visibleGroups = useMemo(
    () => dockerClient ? SECTION_GROUPS
      : SECTION_GROUPS.map(group => ({ ...group, sections: group.sections.filter(section => section.id !== 'web-auth') })),
    [dockerClient],
  );
  const visibleSections = useMemo(() => visibleGroups.flatMap(group => group.sections), [visibleGroups]);
  const [dataPath, setDataPath] = useState('');
  const storeSection = useAppStore(state => state.settingsDialogSection) as SettingsSectionId | null;
  const initialSection = storeSection;
  const [activeSection, setActiveSection] = useState<SettingsSectionId>(
    () => (initialSection && visibleSections.some(section => section.id === initialSection) ? initialSection : 'behavior'),
  );
  const [vsCodeSupport, setVsCodeSupport] = useState<VsCodeTerminalSupport | null>(null);
  const [search, setSearch] = useState('');
  const [visitedSections, setVisitedSections] = useState<Set<SettingsSectionId>>(
    () => new Set<SettingsSectionId>([initialSection && visibleSections.some(section => section.id === initialSection) ? initialSection : 'behavior']),
  );
  const [confirmDialog, setConfirmDialog] = useState<{ message: string; onConfirm: () => void } | null>(null);
  const [dialogSize, setDialogSize] = useState<SettingsDialogSize | null>(readSettingsDialogSize);

  const navButtonRefs = useRef<Partial<Record<SettingsSectionId, HTMLButtonElement | null>>>({});
  const dataPathLoadedRef = useRef(false);
  const sshDefaultRequestedRef = useRef(false);

  const askConfirm = (message: string, onConfirm: () => void) => {
    setConfirmDialog({ message, onConfirm });
  };

  const persistDialogSize = (size: SettingsDialogSize) => {
    const rounded = { width: Math.round(size.width), height: Math.round(size.height) };
    setDialogSize(rounded);
    try {
      localStorage.setItem(SETTINGS_DIALOG_SIZE_KEY, JSON.stringify(rounded));
    } catch {
      // 本地存储不可用时仅本次会话内生效
    }
  };

  const updateSetting = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setSettings(previous => {
      const next = { ...previous, [key]: value };
      saveAppSettings(next);
      return next;
    });
  };

  const filteredGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return visibleGroups;
    return visibleGroups.map(group => {
      const matchedSections = group.sections.filter(section => {
        if (section.label.toLowerCase().includes(q)) return true;
        if (section.description?.toLowerCase().includes(q)) return true;
        if (section.keywords?.some(k => k.toLowerCase().includes(q))) return true;
        return false;
      });
      return { ...group, sections: matchedSections };
    }).filter(group => group.sections.length > 0);
  }, [search, visibleGroups]);

  const flatVisibleSections = useMemo(() => {
    return filteredGroups.flatMap(group => group.sections);
  }, [filteredGroups]);

  useEffect(() => {
    getBackendAppSettings().then(backend => {
      const previous = getAppSettings();
      const synced = {
        ...previous,
        closeBehavior: backend.closeBehavior,
        launchWindowMode: backend.launchWindowMode,
        terminalLoadingMode: backend.terminalLoadingMode,
        enableTabNavigation: backend.enableTabNavigation,
        singleInstance: backend.singleInstance,
        nativeChatSessions: backend.nativeChatSessions ?? previous.nativeChatSessions,
        agentAutoArchiveEnabled: backend.agentAutoArchiveEnabled ?? previous.agentAutoArchiveEnabled,
        agentAutoArchiveDays: backend.agentAutoArchiveDays ?? previous.agentAutoArchiveDays,
        agentIdleRecycleEnabled: backend.agentIdleRecycleEnabled ?? previous.agentIdleRecycleEnabled,
        agentIdleRecycleHours: backend.agentIdleRecycleHours ?? previous.agentIdleRecycleHours,
      };
      setSettings(synced);
      saveAppSettings(synced);
      if (synced.enableTabNavigation !== previous.enableTabNavigation) {
        window.dispatchEvent(new CustomEvent('tab-navigation-changed'));
      }
    }).catch(() => {});

    getVsCodeTerminalSupport()
      .then(setVsCodeSupport)
      .catch(error => {
        setVsCodeSupport({
          available: false,
          reason: `检测失败：${String(error)}`,
          nodePath: null,
          nodeVersion: null,
        });
      });

    syncLaunchAtLogin().then(enabled => {
      const previous = getAppSettings();
      if (previous.launchAtLogin !== enabled) {
        const synced = { ...previous, launchAtLogin: enabled };
        setSettings(synced);
        saveAppSettings(synced);
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (activeSection === 'data' && !dataPathLoadedRef.current) {
      dataPathLoadedRef.current = true;
      getDataPath().then(setDataPath).catch(() => {});
    }
    if (activeSection === 'ssh' && !settings.sshDownloadDir && !sshDefaultRequestedRef.current) {
      sshDefaultRequestedRef.current = true;
      getDownloadsDirectory().then(directory => updateSetting('sshDownloadDir', directory)).catch(() => {});
    }
  }, [activeSection, settings.sshDownloadDir]);

  const selectSection = (sectionId: SettingsSectionId) => {
    setVisitedSections(previous => {
      if (previous.has(sectionId)) return previous;
      const next = new Set(previous);
      next.add(sectionId);
      return next;
    });
    setActiveSection(sectionId);
  };

  useEffect(() => {
    if (!storeSection || !visibleSections.some(section => section.id === storeSection)) return;
    setVisitedSections(previous => {
      if (previous.has(storeSection)) return previous;
      const next = new Set(previous);
      next.add(storeSection);
      return next;
    });
    setActiveSection(storeSection);
  }, [storeSection, visibleSections]);

  const handleTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, sectionId: SettingsSectionId) => {
    const list = flatVisibleSections;
    const currentIndex = list.findIndex(s => s.id === sectionId);
    if (currentIndex === -1) return;

    let targetIndex: number | null = null;
    if (event.key === 'ArrowDown') targetIndex = (currentIndex + 1) % list.length;
    else if (event.key === 'ArrowUp') targetIndex = (currentIndex - 1 + list.length) % list.length;
    else if (event.key === 'Home') targetIndex = 0;
    else if (event.key === 'End') targetIndex = list.length - 1;
    if (targetIndex === null) return;

    event.preventDefault();
    const target = list[targetIndex];
    selectSection(target.id);
    navButtonRefs.current[target.id]?.focus();
  };

  const renderPanel = (sectionId: SettingsSectionId) => {
    switch (sectionId) {
      case 'behavior':
        return (
          <BehaviorSettings
            settings={settings}
            updateSetting={updateSetting}
            vsCodeSupport={vsCodeSupport}
          />
        );
      case 'appearance':
        return <AppearanceSettings settings={settings} updateSetting={updateSetting} />;
      case 'hotkeys':
        return <HotkeySettings settings={settings} updateSetting={updateSetting} />;
      case 'data':
        return <DataSettings dataPath={dataPath} askConfirm={askConfirm} setConfirmDialog={setConfirmDialog} onDataPathChanged={setDataPath} />;
      case 'profiles':
        return <ProfilesSettings askConfirm={askConfirm} dismissConfirm={() => setConfirmDialog(null)} />;
      case 'commands':
        return <CommandsSettings askConfirm={askConfirm} dismissConfirm={() => setConfirmDialog(null)} />;
      case 'exclusions':
        return <ExclusionSettings askConfirm={askConfirm} setConfirmDialog={setConfirmDialog} />;
      case 'ai-usage':
        return <AiUsageSettings settings={settings} updateSetting={updateSetting} />;
      case 'ssh':
        return <SshSettings settings={settings} updateSetting={updateSetting} />;
      case 'web-auth':
        return <WebAuthSettings />;
      case 'web-management':
        return <WebManageSettings />;
      case 'agent-cli':
        return <AgentManagementSettings
          active={activeSection === 'agent-cli'}
        />;
      case 'llm-providers':
        return <LlmProvidersSettings />;
      case 'claude-settings':
        return <ClaudeSettingsEditor />;
    }
  };

  return (
    <>
      <Dialog
        title={(
          <>
            <Settings size={18} aria-hidden="true" />
            <span>设置</span>
          </>
        )}
        ariaLabel="设置"
        className="settings-dialog"
        titleClassName="settings-dialog-heading"
        bodyClassName="settings-dialog-shell"
        resizable
        style={dialogSize ? { ...dialogSize, boxSizing: 'border-box' } : undefined}
        onResizeEnd={persistDialogSize}
        onClose={onClose}
      >
        <div className="settings-page">
          <nav className="settings-nav" role="tablist" aria-label="设置分类" aria-orientation="vertical">
            <div className="settings-nav-search-wrap">
              <div className="settings-nav-search-inner">
                <Search size={13} aria-hidden="true" />
                <input
                  type="text"
                  className="settings-nav-search-input"
                  placeholder="搜索设置项…"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
              </div>
            </div>

            <div className="settings-nav-scroll">
              {filteredGroups.map(group => (
                <div key={group.id} className="settings-nav-group">
                  <div className="settings-nav-group-header">
                    <span>{group.label}</span>
                    <span style={{ opacity: 0.6 }}>{group.sections.length}</span>
                  </div>
                  <div className="settings-nav-group-items">
                    {group.sections.map(section => {
                      const Icon = section.icon;
                      const isActive = activeSection === section.id;
                      return (
                        <button
                          key={section.id}
                          ref={element => { navButtonRefs.current[section.id] = element; }}
                          id={`settings-tab-${section.id}`}
                          className={`settings-nav-item ${isActive ? 'active' : ''}`}
                          type="button"
                          role="tab"
                          aria-selected={isActive}
                          aria-controls={`settings-panel-${section.id}`}
                          tabIndex={isActive ? 0 : -1}
                          onClick={() => selectSection(section.id)}
                          onKeyDown={event => handleTabKeyDown(event, section.id)}
                          title={section.label}
                        >
                          <Icon size={16} aria-hidden="true" />
                          <span className="settings-nav-label">{section.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>

            <div className="settings-nav-footer">
              <span>TerminalBuddy</span>
              <span>{visibleSections.length} 个设置区</span>
            </div>
          </nav>

          <div className="settings-body">
            <div className="settings-content">
              {visibleSections.filter(section => visitedSections.has(section.id)).map(section => {
                const SectionIcon = section.icon;
                return (
                  <section
                    key={section.id}
                    id={`settings-panel-${section.id}`}
                    className="settings-panel"
                    role="tabpanel"
                    aria-labelledby={`settings-tab-${section.id}`}
                    hidden={activeSection !== section.id}
                  >
                    <div className="settings-page-header">
                      <div className="settings-page-title-wrap">
                        <div className="settings-page-icon" aria-hidden="true">
                          <SectionIcon size={18} />
                        </div>
                        <div className="settings-page-header-text">
                          <h3>{section.label}</h3>
                          {section.description && <p>{section.description}</p>}
                        </div>
                      </div>
                    </div>
                    <Suspense fallback={<div className="settings-panel-loading" aria-live="polite">加载设置…</div>}>
                      {renderPanel(section.id)}
                    </Suspense>
                  </section>
                );
              })}
            </div>
          </div>
        </div>

      </Dialog>
      {confirmDialog && (
        <ConfirmDialog
          title="确认操作"
          message={confirmDialog.message}
          onClose={() => setConfirmDialog(null)}
          onConfirm={confirmDialog.onConfirm}
        />
      )}
    </>
  );
};
