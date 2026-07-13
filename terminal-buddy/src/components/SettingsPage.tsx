import { FC, lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  BrainCircuit,
  MessageSquareMore,
  Database,
  FileX2,
  Palette,
  Plug,
  Server,
  Settings,
  SlidersHorizontal,
  SquareTerminal,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  getBackendAppSettings,
  getDataPath,
  getDownloadsDirectory,
  syncLaunchAtLogin,
} from '../services/tauri';
import { type AppSettings, getAppSettings, saveAppSettings } from '../utils/settings';
import './SettingsPage.css';

const BehaviorSettings = lazy(() => import('./settings/BehaviorSettings').then(module => ({ default: module.BehaviorSettings })));
const DataSettings = lazy(() => import('./settings/DataSettings').then(module => ({ default: module.DataSettings })));
const ProfilesSettings = lazy(() => import('./settings/ProfilesSettings').then(module => ({ default: module.ProfilesSettings })));
const CommandsSettings = lazy(() => import('./settings/CommandsSettings').then(module => ({ default: module.CommandsSettings })));
const ThemesSettings = lazy(() => import('./settings/ThemesSettings').then(module => ({ default: module.ThemesSettings })));
const ExclusionSettings = lazy(() => import('./settings/ExclusionSettings').then(module => ({ default: module.ExclusionSettings })));
const AiUsageSettings = lazy(() => import('./settings/AiUsageSettings').then(module => ({ default: module.AiUsageSettings })));
const SshSettings = lazy(() => import('./settings/SshSettings').then(module => ({ default: module.SshSettings })));
const BotNotificationSettings = lazy(() => import('./settings/BotNotificationSettings').then(module => ({ default: module.BotNotificationSettings })));

interface SettingsPageProps {
  onClose: () => void;
}

type SettingsSectionId =
  | 'behavior'
  | 'data'
  | 'profiles'
  | 'commands'
  | 'themes'
  | 'exclusions'
  | 'ai-usage'
  | 'ssh'
  | 'bot-notifications';

interface SettingsSection {
  id: SettingsSectionId;
  label: string;
  icon: LucideIcon;
}

const SECTIONS: ReadonlyArray<SettingsSection> = [
  { id: 'behavior', label: '行为设置', icon: SlidersHorizontal },
  { id: 'data', label: '数据管理', icon: Database },
  { id: 'profiles', label: '连接管理', icon: Plug },
  { id: 'commands', label: '命令模板', icon: SquareTerminal },
  { id: 'themes', label: '主题管理', icon: Palette },
  { id: 'exclusions', label: '文件排除', icon: FileX2 },
  { id: 'ai-usage', label: 'AI 用量', icon: BrainCircuit },
  { id: 'ssh', label: 'SSH 设置', icon: Server },
  { id: 'bot-notifications', label: '机器人通知', icon: MessageSquareMore },
];

export const SettingsPage: FC<SettingsPageProps> = ({ onClose }) => {
  const [settings, setSettings] = useState<AppSettings>(getAppSettings);
  const [dataPath, setDataPath] = useState('');
  const [activeSection, setActiveSection] = useState<SettingsSectionId>('behavior');
  const [visitedSections, setVisitedSections] = useState<Set<SettingsSectionId>>(
    () => new Set<SettingsSectionId>(['behavior'])
  );
  const [confirmDialog, setConfirmDialog] = useState<{ message: string; onConfirm: () => void } | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
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
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    closeButtonRef.current?.focus();
    return () => previouslyFocused?.focus();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (!dialog) return;

      const nestedDialog = dialog.querySelector<HTMLElement>('.dialog-overlay .dialog');
      if (event.key === 'Escape' && !nestedDialog && !confirmDialog) {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key !== 'Tab') return;
      const focusScope = confirmDialog
        ? dialog.querySelector<HTMLElement>('.confirm-dialog')
        : nestedDialog ?? dialog;
      if (!focusScope) return;
      const focusable = Array.from(focusScope.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
      )).filter(element => element.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !focusScope.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !focusScope.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [confirmDialog, onClose]);

  useEffect(() => {
    const timer = setTimeout(() => saveAppSettings(settings), 300);
    return () => clearTimeout(timer);
  }, [settings]);

  useEffect(() => {
    getBackendAppSettings().then(backend => {
      const previous = getAppSettings();
      const synced = {
        ...previous,
        closeBehavior: backend.closeBehavior,
        launchWindowMode: backend.launchWindowMode,
        enableTabNavigation: backend.enableTabNavigation,
        singleInstance: backend.singleInstance,
      };
      setSettings(synced);
      saveAppSettings(synced);
      if (synced.enableTabNavigation !== previous.enableTabNavigation) {
        window.dispatchEvent(new CustomEvent('tab-navigation-changed'));
      }
    }).catch(() => {});

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
        return <BehaviorSettings settings={settings} updateSetting={updateSetting} />;
      case 'data':
        return <DataSettings dataPath={dataPath} askConfirm={askConfirm} setConfirmDialog={setConfirmDialog} />;
      case 'profiles':
        return <ProfilesSettings askConfirm={askConfirm} dismissConfirm={() => setConfirmDialog(null)} />;
      case 'commands':
        return <CommandsSettings askConfirm={askConfirm} dismissConfirm={() => setConfirmDialog(null)} />;
      case 'themes':
        return <ThemesSettings />;
      case 'exclusions':
        return <ExclusionSettings askConfirm={askConfirm} setConfirmDialog={setConfirmDialog} />;
      case 'ai-usage':
        return <AiUsageSettings settings={settings} updateSetting={updateSetting} />;
      case 'ssh':
        return <SshSettings settings={settings} updateSetting={updateSetting} />;
      case 'bot-notifications':
        return <BotNotificationSettings />;
    }
  };

  return (
    <div className="settings-dialog-overlay" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-dialog-title"
        onMouseDown={event => event.stopPropagation()}
      >
        <header className="settings-dialog-header">
          <div className="settings-dialog-heading">
            <Settings size={18} aria-hidden="true" />
            <h2 id="settings-dialog-title">设置</h2>
          </div>
          <button
            ref={closeButtonRef}
            className="settings-close-btn"
            type="button"
            onClick={onClose}
            title="关闭设置"
            aria-label="关闭设置"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>

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
              {SECTIONS.filter(section => visitedSections.has(section.id)).map(section => (
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
              ))}
            </div>

            <div className="settings-footer">
              <button className="btn-primary" type="button" onClick={onClose}>完成</button>
            </div>
          </div>
        </div>

        {confirmDialog && (
          <div className="confirm-dialog-overlay" onClick={() => setConfirmDialog(null)}>
            <div className="confirm-dialog" role="alertdialog" aria-modal="true" onClick={event => event.stopPropagation()}>
              <div className="confirm-dialog-title">确认操作</div>
              <div className="confirm-dialog-message">{confirmDialog.message}</div>
              <div className="confirm-dialog-buttons">
                <button className="btn-secondary" onClick={() => setConfirmDialog(null)}>取消</button>
                <button className="btn-danger" onClick={confirmDialog.onConfirm}>确定</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
