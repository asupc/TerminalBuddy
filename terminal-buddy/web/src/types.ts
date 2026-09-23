export type TerminalType = 'powershell' | 'pwsh' | 'cmd' | 'ssh' | 'docker' | 'k8s' | 'mstsc';
export type TerminalLoadingMode = 'default' | 'vsCode';
export type ExtraParamMode = 'append' | 'independent';

/** 连接配置（与后端 Profile 同构，仅取 Web 端会用到的字段；其余字段均视作可选以兼容精简场景） */
export interface Profile {
  id: string;
  name: string;
  group: string;
  terminalType: TerminalType;
  /** 启动命令（用于启动参数预设的 commandMatch 匹配） */
  startupCommands?: string[];
  /** 起始路径（powershell / cmd） */
  startupPath?: string;
  /** 环境变量（powershell / cmd） */
  environmentVariables?: Record<string, string>;
  /** 主题 id */
  colorTheme?: string;
  /** tab 标签颜色 */
  tabColor?: string | null;
  /** 终端窗口尺寸 */
  windowSize?: { width: number; height: number } | null;
  // SSH
  sshHost?: string;
  sshPort?: number;
  sshUser?: string;
  sshAuthType?: 'password' | 'key' | string;
  sshKeyPath?: string;
  // Docker
  dockerContainerId?: string;
  dockerContainerName?: string;
  // Kubernetes
  k8sNamespace?: string;
  k8sPodName?: string;
  k8sContainerName?: string;
  // 远程桌面（Web 端不会列出 mstsc，但类型完整保留）
  mstscHost?: string;
  mstscPort?: number;
  mstscUser?: string;
  mstscResolution?: string;
}

/** 存活终端实例（来自 GET /api/terminals 与 meta WS 推送） */
export interface TerminalInfo {
  id: string;
  profileId: string;
  profileName: string;
  group: string;
  terminalType: TerminalType;
  loadingMode: TerminalLoadingMode;
  owner: 'pc' | 'web';
  /** 启动参数预设的 tag（启动时快照，跨端可见、刷新不丢） */
  extraParamTag?: string;
  extraParamTagColor?: string | null;
  /** 启动时使用的额外参数快照（供「以此配置新建终端」复用） */
  extraStartupParams?: string;
  /** 额外参数模式：append / independent */
  extraStartupMode?: ExtraParamMode;
}

export interface TabColorOption {
  id: string;
  name: string;
  color: string;
}

/** tab 标签颜色调色板：null 表示跟随主题默认色（与 PC 端 TAB_COLORS 一致） */
export const TAB_COLORS: (TabColorOption | null)[] = [
  null,
  { id: 'red', name: '红色', color: '#F44336' },
  { id: 'crimson', name: '深红', color: '#DC143C' },
  { id: 'pink', name: '粉色', color: '#E91E63' },
  { id: 'hotpink', name: '艳粉', color: '#FF69B4' },
  { id: 'orange', name: '橙色', color: '#FF5722' },
  { id: 'deeporange', name: '深橙', color: '#FF6D00' },
  { id: 'amber', name: '琥珀', color: '#FFC107' },
  { id: 'gold', name: '金色', color: '#FFD700' },
  { id: 'yellow', name: '明黄', color: '#FFEB3B' },
  { id: 'lime', name: '青柠', color: '#8BC34A' },
  { id: 'green', name: '绿色', color: '#4CAF50' },
  { id: 'emerald', name: '翠绿', color: '#2ECC71' },
  { id: 'teal', name: '墨绿', color: '#009688' },
  { id: 'cyan', name: '青色', color: '#00BCD4' },
  { id: 'skyblue', name: '天蓝', color: '#03A9F4' },
  { id: 'blue', name: '蓝色', color: '#2196F3' },
  { id: 'royalblue', name: '皇家蓝', color: '#4169E1' },
  { id: 'indigo', name: '靛蓝', color: '#5C6BC0' },
  { id: 'purple', name: '紫色', color: '#9C27B0' },
  { id: 'deeppurple', name: '深紫', color: '#7C4DFF' },
  { id: 'violet', name: '紫罗兰', color: '#BA68C8' },
  { id: 'magenta', name: '品红', color: '#E040FB' },
  { id: 'brown', name: '棕色', color: '#8D6E63' },
  { id: 'grey', name: '灰色', color: '#BDBDBD' },
  { id: 'white', name: '白色', color: '#FAFAFA' },
];

/** 启动参数预设（与 PC 端共享 ClientData/extra_param_presets.json） */
export interface ExtraParamPreset {
  id: string;
  name: string;
  params: string;
  /** 追加到原启动命令，或作为独立命令执行 */
  mode: ExtraParamMode;
  /** tag 底色，取自 TAB_COLORS；null 表示跟随主题默认色 */
  tagColor: string | null;
  /** 命令匹配（PC 端用，Web 端保留字段不做过滤） */
  commandMatch: string | null;
  /** 是否启用（PC 端管理弹窗维护）：禁用的预设不出现在启动菜单 */
  enabled?: boolean;
}

/** 终端主题色（与 PC 端 src/types/index.ts PRESET_THEMES 保持一致） */
export interface ColorTheme {
  id: string;
  name: string;
  background: string;
  foreground: string;
}

export const PRESET_THEMES: ColorTheme[] = [
  { id: 'dark-default', name: '深色默认', background: '#1E1E1E', foreground: '#CCCCCC' },
  { id: 'dark-green', name: '黑客绿', background: '#0C0C0C', foreground: '#00FF00' },
  { id: 'dark-blue', name: '海洋蓝', background: '#0D1B2A', foreground: '#E0E0E0' },
  { id: 'dark-powershell', name: 'PS深色', background: '#012456', foreground: '#F1F1F1' },
  { id: 'light', name: '浅色', background: '#FFFFFF', foreground: '#333333' },
  { id: 'solarized-dark', name: 'Solarized暗', background: '#002B36', foreground: '#839496' },
  { id: 'solarized-light', name: 'Solarized亮', background: '#FDF6E3', foreground: '#657B83' },
  { id: 'vintage', name: '复古绿屏', background: '#0A0A0A', foreground: '#33FF33' },
];

export const DEFAULT_THEME_ID = 'dark-default';

export function resolveTheme(themeId?: string): ColorTheme {
  return PRESET_THEMES.find((t) => t.id === themeId) ?? PRESET_THEMES[0];
}
