import { FC, useState, useRef, useEffect } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  BarChart3,
  Bell,
  Check,
  Columns2,
  Flower2,
  Folder,
  Grid2X2,
  Heart,
  Info,
  Minus,
  Moon,
  Palette,
  PanelLeft,
  RefreshCw,
  Settings,
  Sparkles,
  Square,
  Sun,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { windowMinimize, windowToggleMaximize, windowClose, checkAppUpdate } from '../../services/tauri';
import type { UpdateInfo } from '../../services/tauri';
import { AiUsagePanel } from '../settings/AiUsagePanel';
import { AboutDialog } from '../settings/AboutDialog';
import { UpdatePopover, type UpdateCheckStatus } from '../settings/UpdatePopover';
import { APP_VERSION } from '../../version';
import appIcon from '../../assets/app-icon.png';
import './TitleBar.css';
import {
  APP_OPACITY_PREVIEW_EVENT,
  applyTheme,
  getAppOpacities,
  getAppSettings,
  getEffectiveThemeSkin,
  isDecorativeThemeSkin,
  isThemeSkin,
  MAX_APP_OPACITY,
  normalizeAppOpacity,
  previewAppOpacity,
  saveAppSettings,
  saveTheme,
} from '../../utils/settings';
import type {
  AppOpacityPreviewDetail,
  DecorativeThemeSkin,
  ThemeChangeDetail,
  ThemeSkin,
  UiStyle,
} from '../../utils/settings';
import { useAppStore } from '../../stores/appStore';
import { TERMINAL_SPLIT_TRANSITION_GUARD_MS } from '../../utils/terminalResizeEvent';
import { compareVersions } from '../../utils/version';

interface TitleBarProps {
  uiStyle: UiStyle;
  onSettings: () => void;
  configPanelVisible: boolean;
  fileTreeVisible: boolean;
  onToggleConfigPanel: () => void;
  onToggleFileTree: () => void;
  updateInfo: UpdateInfo | null;
  onUpdateDismiss: () => void;
  onPromoteToUpdate: (info: UpdateInfo) => void;
  lastCheckedAt: number | null;
  onUpdateLastChecked: (now: number) => void;
}

interface ThemeSkinOption {
  id: ThemeSkin;
  label: string;
  icon: LucideIcon;
}

const THEME_SKINS: ReadonlyArray<ThemeSkinOption> = [
  { id: 'dark', label: '深色模式', icon: Moon },
  { id: 'light', label: '浅色模式', icon: Sun },
  { id: 'cartoon', label: '甜系少女', icon: Heart },
  { id: 'starry', label: '星空魔法', icon: Sparkles },
  { id: 'cyber', label: '霓虹赛博', icon: Zap },
  { id: 'sakura', label: '樱花和风', icon: Flower2 },
];

export const TitleBar: FC<TitleBarProps> = ({
  uiStyle,
  onSettings,
  configPanelVisible,
  fileTreeVisible,
  onToggleConfigPanel,
  onToggleFileTree,
  updateInfo,
  onUpdateDismiss,
  onPromoteToUpdate,
  lastCheckedAt,
  onUpdateLastChecked,
}) => {
  const [aiUsageHover, setAiUsageHover] = useState(false);
  const [updateHover, setUpdateHover] = useState(false);
  const [showAboutDialog, setShowAboutDialog] = useState(false);
  const [splitBusy, setSplitBusy] = useState(false);
  const [refreshHover, setRefreshHover] = useState(false);
  const [checkStatus, setCheckStatus] = useState<UpdateCheckStatus>('idle');
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const splitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const updateHoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshHoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const themePickerRef = useRef<HTMLDivElement>(null);
  const themeButtonRef = useRef<HTMLButtonElement>(null);
  const themeOptionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    return () => {
      if (hoverTimer.current) {
        clearTimeout(hoverTimer.current);
      }
      if (splitTimer.current) {
        clearTimeout(splitTimer.current);
      }
      if (updateHoverTimer.current) {
        clearTimeout(updateHoverTimer.current);
      }
      if (refreshHoverTimer.current) {
        clearTimeout(refreshHoverTimer.current);
      }
    };
  }, []);
  const [theme, setTheme] = useState<ThemeSkin>(getEffectiveThemeSkin);
  const [showThemePicker, setShowThemePicker] = useState(false);
  const [appOpacities, setAppOpacities] = useState(
    () => getAppOpacities(getAppSettings()),
  );
  const splitMode = useAppStore(s => s.splitMode);

  // 监听应用主题变化。App 启动时 initTheme() 是异步的，applyTheme 会晚于本组件
  // 首次渲染执行，并派发 app-theme-changed。若不订阅，白板启动时按钮的内部 state
  // 会停在默认 'dark'，而已被 applyTheme 切成 light 的 DOM 与之不同步，
  // 导致第一次点击只是在「对齐 state」、界面不变，需点两次才真正切换。
  useEffect(() => {
    const onTheme = (e: Event) => {
      const skin = (e as CustomEvent<ThemeChangeDetail>).detail?.skin;
      if (isThemeSkin(skin)) {
        setTheme(state => (state === skin ? state : skin));
      }
    };
    window.addEventListener('app-theme-changed', onTheme);
    return () => window.removeEventListener('app-theme-changed', onTheme);
  }, []);

  useEffect(() => {
    const syncOpacities = () => {
      setAppOpacities(getAppOpacities(getAppSettings()));
    };
    window.addEventListener('app-settings-changed', syncOpacities);
    return () => window.removeEventListener('app-settings-changed', syncOpacities);
  }, []);

  useEffect(() => {
    if (!showThemePicker) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (!themePickerRef.current?.contains(event.target as Node)) setShowThemePicker(false);
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setShowThemePicker(false);
      themeButtonRef.current?.focus();
    };
    const selectedIndex = THEME_SKINS.findIndex(option => option.id === theme);
    const focusFrame = requestAnimationFrame(() => themeOptionRefs.current[selectedIndex]?.focus());

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleEscape);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [showThemePicker, theme]);

  const selectTheme = (next: ThemeSkin) => {
    setTheme(next);
    saveTheme(next);
    applyTheme(next);
    setShowThemePicker(false);
    themeButtonRef.current?.focus();
  };

  const updateAppOpacityPreview = (skin: DecorativeThemeSkin, opacity: number) => {
    const normalized = normalizeAppOpacity(opacity);
    setAppOpacities(current => ({ ...current, [skin]: normalized }));
    previewAppOpacity(skin, normalized);
    const detail: AppOpacityPreviewDetail = { skin, opacity: normalized };
    window.dispatchEvent(new CustomEvent(APP_OPACITY_PREVIEW_EVENT, { detail }));
  };

  const commitAppOpacity = (skin: DecorativeThemeSkin, opacity: number) => {
    const normalized = normalizeAppOpacity(opacity);
    const current = getAppSettings();
    saveAppSettings({
      ...current,
      appOpacityBySkin: {
        ...getAppOpacities(current),
        [skin]: normalized,
      },
    });
  };

  const handleThemeGridKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const currentIndex = themeOptionRefs.current.indexOf(document.activeElement as HTMLButtonElement);
    if (currentIndex < 0) return;

    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % THEME_SKINS.length;
    else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + THEME_SKINS.length) % THEME_SKINS.length;
    else if (event.key === 'ArrowDown') nextIndex = (currentIndex + 2) % THEME_SKINS.length;
    else if (event.key === 'ArrowUp') nextIndex = (currentIndex - 2 + THEME_SKINS.length) % THEME_SKINS.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = THEME_SKINS.length - 1;
    if (nextIndex === null) return;

    event.preventDefault();
    themeOptionRefs.current[nextIndex]?.focus();
  };

  const handleMouseEnter = () => {
    clearTimeout(hoverTimer.current);
    setAiUsageHover(true);
  };

  const handleMouseLeave = () => {
    hoverTimer.current = setTimeout(() => setAiUsageHover(false), 200);
  };

  const handleUpdateEnter = () => {
    if (updateHoverTimer.current) clearTimeout(updateHoverTimer.current);
    setUpdateHover(true);
  };

  const handleUpdateLeave = () => {
    updateHoverTimer.current = setTimeout(() => setUpdateHover(false), 200);
  };

  const handleRefreshEnter = () => {
    if (refreshHoverTimer.current) clearTimeout(refreshHoverTimer.current);
    setRefreshHover(true);
  };

  const handleRefreshLeave = () => {
    refreshHoverTimer.current = setTimeout(() => setRefreshHover(false), 200);
  };

  const handleCheckNow = async () => {
    setCheckStatus('checking');
    try {
      const info = await checkAppUpdate();
      const now = Date.now();
      // 保留 localStorage 写入，向后兼容可能读取它的代码（App state 为权威值）
      localStorage.setItem('appUpdate.lastCheckedAt', String(now));
      onUpdateLastChecked(now);
      if (info) {
        const dismissed = localStorage.getItem('appUpdate.dismissedVersion');
        if (info.version !== dismissed && compareVersions(info.version, APP_VERSION) > 0) {
          // 手动检查也驱动 Bell（同步状态）
          onPromoteToUpdate(info);
          setCheckStatus('has-update');
        } else {
          setCheckStatus('up-to-date');
        }
      } else {
        setCheckStatus('up-to-date');
      }
    } catch {
      setCheckStatus('up-to-date');
    }
  };

  const handleSplitClick = () => {
    if (splitBusy) return;
    setSplitBusy(true);
    useAppStore.getState().cycleSplitMode();
    if (splitTimer.current) clearTimeout(splitTimer.current);
    splitTimer.current = setTimeout(() => {
      splitTimer.current = null;
      setSplitBusy(false);
    }, TERMINAL_SPLIT_TRANSITION_GUARD_MS);
  };

  return (
    <div className="titlebar" data-tauri-drag-region="deep">
      <div className="titlebar-left">
        <img className="titlebar-logo" src={appIcon} alt="" draggable={false} />
        <span className="titlebar-title">TerminalBuddy</span>
        <span className="titlebar-version">v{APP_VERSION}</span>
        <div className="titlebar-nav-btns">
          {uiStyle === 'default' && (
            <>
              <button
                className={`titlebar-nav-btn ${configPanelVisible ? 'active' : ''}`}
                onClick={onToggleConfigPanel}
                title={configPanelVisible ? '隐藏连接导航' : '显示连接导航'}
                aria-label={configPanelVisible ? '隐藏连接导航' : '显示连接导航'}
                aria-pressed={configPanelVisible}
              >
                <PanelLeft aria-hidden="true" />
              </button>
              <button
                className={`titlebar-nav-btn ${fileTreeVisible ? 'active' : ''}`}
                onClick={onToggleFileTree}
                title={fileTreeVisible ? '隐藏文件导航' : '显示文件导航'}
                aria-label={fileTreeVisible ? '隐藏文件导航' : '显示文件导航'}
                aria-pressed={fileTreeVisible}
              >
                <Folder aria-hidden="true" />
              </button>
            </>
          )}
        </div>
      </div>
      <div className="titlebar-right">
        <div className="titlebar-action-group">
          <div
            className="ai-usage-trigger"
            onMouseEnter={handleRefreshEnter}
            onMouseLeave={handleRefreshLeave}
          >
            <button
              type="button"
              className="titlebar-btn titlebar-action-btn"
              title="检查更新"
              aria-label="检查更新"
              onClick={handleCheckNow}
              disabled={checkStatus === 'checking'}
            >
              <RefreshCw aria-hidden="true" />
            </button>
            {refreshHover && (
              <UpdatePopover
                status={checkStatus}
                info={updateInfo}
                lastCheckedAt={lastCheckedAt}
                currentVersion={APP_VERSION}
                onCheckNow={handleCheckNow}
                onDismiss={() => setRefreshHover(false)}
                onIgnore={onUpdateDismiss}
              />
            )}
          </div>
          <div
            className="ai-usage-trigger"
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
          >
            <button className="titlebar-btn titlebar-action-btn" title="查看 AI 用量" aria-label="查看 AI 用量">
              <BarChart3 aria-hidden="true" />
            </button>
            {aiUsageHover && <AiUsagePanel />}
          </div>
          {updateInfo && (
            <div
              className="ai-usage-trigger"
              onMouseEnter={handleUpdateEnter}
              onMouseLeave={handleUpdateLeave}
            >
              <button
                className="titlebar-btn titlebar-action-btn titlebar-status-btn"
                title={`发现新版本 v${updateInfo.version}`}
                aria-label={`发现新版本 v${updateInfo.version}，点击查看更新说明`}
              >
                <Bell aria-hidden="true" />
                <span className="titlebar-status-dot update-available" aria-hidden="true" />
              </button>
              {updateHover && (
                <UpdatePopover
                  status="has-update"
                  info={updateInfo}
                  lastCheckedAt={lastCheckedAt}
                  currentVersion={APP_VERSION}
                  onCheckNow={handleCheckNow}
                  onDismiss={() => setUpdateHover(false)}
                  onIgnore={onUpdateDismiss}
                />
              )}
            </div>
          )}
          <button
            type="button"
            className={`titlebar-btn titlebar-action-btn titlebar-split-btn ${splitMode !== 'off' ? 'split-active' : ''}`}
            onClick={handleSplitClick}
            disabled={splitBusy}
            title={splitBusy ? '分屏切换中...' : splitMode === 'off' ? '分屏：2×1' : splitMode === '2x1' ? '分屏：2×2' : '退出分屏'}
            aria-label={splitBusy ? '分屏切换中' : splitMode === 'off' ? '切换到两栏分屏' : splitMode === '2x1' ? '切换到四格分屏' : '退出分屏'}
          >
            {splitMode === '2x2' ? <Grid2X2 /> : <Columns2 />}
          </button>
          <div className="theme-skin-trigger" ref={themePickerRef}>
            <button
              ref={themeButtonRef}
              type="button"
              className={`titlebar-btn titlebar-action-btn ${showThemePicker ? 'active' : ''}`}
              onClick={() => setShowThemePicker(open => !open)}
              title={`皮肤设置：${THEME_SKINS.find(option => option.id === theme)?.label ?? ''}`}
              aria-label="选择应用皮肤"
              aria-haspopup="dialog"
              aria-expanded={showThemePicker}
              aria-controls="theme-skin-popover"
            >
              <Palette aria-hidden="true" />
            </button>
            {showThemePicker && (
              <div
                id="theme-skin-popover"
                className="theme-skin-popover"
                role="dialog"
                aria-label="选择应用皮肤"
              >
                <div className="theme-skin-heading">选择皮肤</div>
                <div
                  className="theme-skin-grid"
                  role="radiogroup"
                  aria-label="应用皮肤"
                  onKeyDown={handleThemeGridKeyDown}
                >
                  {THEME_SKINS.map((option, index) => {
                    const Icon = option.icon;
                    const selected = option.id === theme;
                    const decorativeSkin = isDecorativeThemeSkin(option.id) ? option.id : null;
                    const opacity = decorativeSkin ? appOpacities[decorativeSkin] : 0;
                    const previewStyle = decorativeSkin
                      ? { '--theme-app-opacity': opacity / 100 } as CSSProperties
                      : undefined;
                    return (
                      <div
                        key={option.id}
                        className={`theme-skin-card${decorativeSkin ? ' theme-skin-card-adjustable' : ''}`}
                      >
                        <button
                          ref={element => { themeOptionRefs.current[index] = element; }}
                          type="button"
                          className={`theme-skin-option theme-skin-option-${option.id}${selected ? ' selected' : ''}`}
                          role="radio"
                          aria-checked={selected}
                          tabIndex={selected ? 0 : -1}
                          onClick={() => selectTheme(option.id)}
                        >
                          <span className="theme-skin-preview" style={previewStyle} aria-hidden="true">
                            <span className="theme-skin-preview-bar" />
                            <span className="theme-skin-preview-sidebar" />
                            <span className="theme-skin-preview-content" />
                          </span>
                          <span className="theme-skin-option-label">
                            <Icon aria-hidden="true" />
                            <span>{option.label}</span>
                            {selected && <Check className="theme-skin-check" aria-hidden="true" />}
                          </span>
                        </button>
                        {decorativeSkin && (
                          <label className="theme-skin-opacity-control">
                            <span className="theme-skin-opacity-label">
                              <span>整体不透明度</span>
                              <span>{opacity}%</span>
                            </span>
                            <input
                              type="range"
                              min="0"
                              max={MAX_APP_OPACITY}
                              step="1"
                              value={opacity}
                              aria-label={`${option.label}整体界面不透明度`}
                              aria-valuetext={opacity === 0 ? '完全透明' : `${opacity}% 不透明`}
                              style={{
                                '--theme-app-opacity-percent': `${(opacity / MAX_APP_OPACITY) * 100}%`,
                              } as CSSProperties}
                              onChange={(event) => {
                                updateAppOpacityPreview(decorativeSkin, Number(event.currentTarget.value));
                              }}
                              onPointerUp={(event) => {
                                commitAppOpacity(decorativeSkin, Number(event.currentTarget.value));
                              }}
                              onKeyUp={(event) => {
                                commitAppOpacity(decorativeSkin, Number(event.currentTarget.value));
                              }}
                              onBlur={(event) => {
                                commitAppOpacity(decorativeSkin, Number(event.currentTarget.value));
                              }}
                            />
                          </label>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
          <button
            type="button"
            className="titlebar-btn titlebar-action-btn titlebar-about-btn"
            onClick={() => setShowAboutDialog(true)}
            title="关于 TerminalBuddy"
            aria-label="关于 TerminalBuddy"
          >
            <Info />
          </button>
          {uiStyle === 'default' && (
            <button
              type="button"
              className="titlebar-btn titlebar-action-btn"
              onClick={onSettings}
              title="设置"
              aria-label="设置"
            >
              <Settings />
            </button>
          )}
        </div>
        <div className="titlebar-window-controls">
          <button
            type="button"
            className="titlebar-btn titlebar-window-btn"
            onClick={() => windowMinimize()}
            title="最小化"
            aria-label="最小化窗口"
          >
            <Minus />
          </button>
          <button
            type="button"
            className="titlebar-btn titlebar-window-btn"
            onClick={() => windowToggleMaximize()}
            title="最大化"
            aria-label="最大化窗口"
          >
            <Square />
          </button>
          <button
            type="button"
            className="titlebar-btn titlebar-window-btn titlebar-close-btn"
            onClick={() => windowClose()}
            title="关闭"
            aria-label="关闭窗口"
          >
            <X />
          </button>
        </div>
      </div>

      {showAboutDialog && (
        <AboutDialog onClose={() => setShowAboutDialog(false)} />
      )}
    </div>
  );
};
