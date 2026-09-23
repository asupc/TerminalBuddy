import { FC, lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  BrainCircuit,
  MessageSquareMore,
  Database,
  FileX2,
  Globe2,
  Keyboard,
  Palette,
  Plug,
  Server,
  Settings,
  SlidersHorizontal,
  SquareTerminal,
  Terminal,
  Webhook,
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
const BotNotificationSettings = lazy(() => import('./BotNotificationSettings').then(module => ({ default: module.BotNotificationSettings })));
const HookSettings = lazy(() => import('./HookSettings').then(module => ({ default: module.HookSettings })));
const WebManageSettings = lazy(() => import('../shared/WebManageDialog').then(module => ({ default: module.WebManageSettings })));
const ExtraParamsSettings = lazy(() => import('./ExtraParamsSettings').then(module => ({ default: module.ExtraParamsSettings })));

interface SettingsPageProps {
  onClose: () => void;
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
  | 'hooks'
  | 'web-management'
  | 'bot-notifications'
  | 'extra-params';

interface SettingsSection {
  id: SettingsSectionId;
  label: string;
  icon: LucideIcon;
}

const SECTIONS: ReadonlyArray<SettingsSection> = [
  { id: 'behavior', label: '行为设置', icon: SlidersHorizontal },
  { id: 'appearance', label: '外观设置', icon: Palette },
  { id: 'hotkeys', label: '快捷键设置', icon: Keyboard },
  { id: 'data', label: '数据管理', icon: Database },
  { id: 'profiles', label: '连接管理', icon: Plug },
  { id: 'commands', label: '命令模板', icon: SquareTerminal },
  { id: 'exclusions', label: '文件排除', icon: FileX2 },
  { id: 'ai-usage', label: 'AI 用量', icon: BrainCircuit },
  { id: 'ssh', label: 'SSH 设置', icon: Server },
  { id: 'hooks', label: 'Hook 设置', icon: Webhook },
  { id: 'web-management', label: 'Web 管理', icon: Globe2 },
  { id: 'bot-notifications', label: '机器人通知', icon: MessageSquareMore },
  { id: 'extra-params', label: '启动参数', icon: Terminal },
];

export const SettingsPage: FC<SettingsPageProps> = ({ onClose }) => {
  const [settings, setSettings] = useState<AppSettings>(getAppSettings);
  const [dataPath, setDataPath] = useState('');
  const [activeSection, setActiveSection] = useState<SettingsSectionId>('behavior');
  const [vsCodeSupport, setVsCodeSupport] = useState<VsCodeTerminalSupport | null>(null);
  const [visitedSections, setVisitedSections] = useState<Set<SettingsSectionId>>(
    () => new Set<SettingsSectionId>(['behavior'])
  );
  const [confirmDialog, setConfirmDialog] = useState<{ message: string; onConfirm: () => void } | null>(null);

  const navButtonRefs = useRef<Partial<Record<SettingsSectionId, HTMLButtonElement | null>>>({});
  const dataPathLoadedRef = useRef(false);
  const sshDefaultRequestedRef = useRef(false);

  const askConfirm = (message: string, onConfirm: () => void) => {
    setConfirmDialog({ message, onConfirm });
  };

  const updateSetting = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setSettings(previous => {
      const next = { ...previous, [key]: value };
      saveAppSettings(next);
      return next;
    });
  };

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
        claudeHookConfigDir: backend.claudeHookConfigDir ?? previous.claudeHookConfigDir,
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

  const handleTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    let targetIndex: number | null = null;
    if (event.key === 'ArrowDown') targetIndex = (index + 1) % SECTIONS.length;
    else if (event.key === 'ArrowUp') targetIndex = (index - 1 + SECTIONS.length) % SECTIONS.length;
    else if (event.key === 'Home') targetIndex = 0;
    else if (event.key === 'End') targetIndex = SECTIONS.length - 1;
    if (targetIndex === null) return;

    event.preventDefault();
    const target = SECTIONS[targetIndex];
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
        return <DataSettings dataPath={dataPath} askConfirm={askConfirm} setConfirmDialog={setConfirmDialog} />;
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
      case 'hooks':
        return <HookSettings settings={settings} updateSetting={updateSetting} />;
      case 'web-management':
        return <WebManageSettings />;
      case 'bot-notifications':
        return <BotNotificationSettings />;
      case 'extra-params':
        return <ExtraParamsSettings />;
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
        onClose={onClose}
      >
        <div className="settings-page">
          <nav className="settings-nav" role="tablist" aria-label="设置分类" aria-orientation="vertical">
            {SECTIONS.map((section, index) => {
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
                  onKeyDown={event => handleTabKeyDown(event, index)}
                  title={section.label}
                >
                  <Icon size={17} aria-hidden="true" />
                  <span className="settings-nav-label">{section.label}</span>
                </button>
              );
            })}
          </nav>

          <div className="settings-body">
            <div className="settings-content">
              {SECTIONS.filter(section => visitedSections.has(section.id)).map(section => {
                return (
                  <section
                    key={section.id}
                    id={`settings-panel-${section.id}`}
                    className="settings-panel"
                    role="tabpanel"
                    aria-labelledby={`settings-tab-${section.id}`}
                    hidden={activeSection !== section.id}
                  >
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
