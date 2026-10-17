export type TerminalType = 'powershell' | 'pwsh' | 'cmd' | 'bash' | 'sh' | 'zsh' | 'ssh' | 'docker' | 'k8s' | 'mstsc';
export type TerminalLoadingMode = 'default' | 'vsCode';

/** 输出产生时的网格；重放电脑终端时必须先恢复该尺寸。 */
export interface TerminalReplayFrame {
  data: string;
  cols: number;
  rows: number;
}
export type ExtraParamMode = 'append' | 'independent';

/** 项目（与后端 commands/profile.rs Project 同构，来自 GET /api/projects） */
export interface Project {
  name: string;
  path: string;
  /** 自定义启动命令（如 claude）；空串表示仅进入目录 */
  startupCommand: string;
}

/** 连接配置（与后端 Profile 同构，仅取 Web 端会用到的字段；其余字段均视作可选以兼容精简场景） */
export interface Profile {
  id: string;
  name: string;
  group: string;
  terminalType: TerminalType;
  /** 启动命令（用于启动参数预设的 commandMatch 匹配） */
  startupCommands?: string[];
  /** 本地 Shell 起始路径 */
  startupPath?: string;
  /** 本地 Shell 环境变量 */
  environmentVariables?: Record<string, string>;
  /** 主题 id */
  colorTheme?: string;
  /** tab 标签颜色 */
  tabColor?: string | null;
  /** 终端窗口尺寸 */
  windowSize?: { width: number; height: number } | null;
  pinned?: boolean;
  createdAt?: string;
  lastUsedAt?: string | null;
  // SSH
  sshHost?: string;
  sshPort?: number;
  sshUser?: string;
  sshAuthType?: 'password' | 'key' | string;
  sshKeyPath?: string;
  sshPassword?: string | null;
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
  mstscPassword?: string | null;
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
  /** 创建端设备：手机端只能关闭 mobile 创建的会话（旧后端无此字段 → 视为可关） */
  creator?: 'desktop' | 'mobile';
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

// ----- Claude 历史会话（与后端 services/claude_history_service.rs 同构）-----

export interface ClaudeSessionItem {
  sessionId: string;
  projectDir: string;
  filePath: string;
  title: string;
  customTitle: string | null;
  startedAt: number | null;
  updatedAt: number;
  messageCount: number;
  inputTokens: number;
  outputTokens: number;
  model: string | null;
  starred: boolean;
  archived: boolean;
}

export interface ClaudeSearchHit {
  sessionId: string;
  title: string;
  projectDir: string;
  snippet: string;
  seq: number;
  timestamp: number | null;
  updatedAt: number;
}

export interface ClaudeReplayTool {
  name: string;
  summary: string;
}

export interface ClaudeReplayMessage {
  seq: number;
  role: 'user' | 'assistant' | 'tool';
  timestamp: number | null;
  text: string;
  tools: ClaudeReplayTool[];
  toolName: string | null;
}

export interface ClaudeReplayPage {
  total: number;
  messages: ClaudeReplayMessage[];
  title: string;
  projectDir: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  startedAt: number | null;
  updatedAt: number;
}

export interface ClaudeHistoryScanResult {
  scanned: number;
  updated: number;
  total: number;
  /** 本批之后仍需索引的会话数；>0 表示后台补齐任务还在跑 */
  pending: number;
}

// ----- Web 端文件树 / Git（与后端 commands/fs.rs、commands/git.rs 同构）-----

/** 注意：后端 FileNode 未做 camelCase 重命名，保持 snake_case */
export interface FileNode {
  name: string;
  path: string;
  is_directory: boolean;
  size: number;
  last_modified: number;
}

export interface GitRepositoryStatus {
  repoRoot: string;
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  changedCount: number;
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  hasRemote: boolean;
}

export interface GitBranch {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
  upstream: string | null;
}

export interface GitOperationStatus {
  action: string;
  /** running | done | failed | idle */
  status: 'running' | 'done' | 'failed' | 'idle';
  output: string;
  startedAt: number;
  finishedAt: number | null;
}

/** 与 Docker 完整界面共用的运行环境和 Claude 模型数据。 */
export interface RuntimeInfo {
  platform: string;
  defaultTerminalType: TerminalType;
}
export interface LlmModelConfig {
  id: string;
  enabled: boolean;
  contextWindow: number;
  effortLevel: string;
  maxOutputTokens: number;
}
export interface LlmProvider {
  id: string;
  name: string;
  baseUrl: string;
  authType: string;
  keySet: boolean;
  keyTail: string;
  isDefault: boolean;
  defaultEffortLevel: string;
  modelsUrl: string;
  enabledModels: LlmModelConfig[];
  sortIndex: number;
}
export interface LlmProviderInput extends Omit<LlmProvider, 'keySet' | 'keyTail'> {
  apiKey?: string;
}
export interface LlmLaunchTarget {
  providerId: string;
  providerName: string;
  isDefault: boolean;
  models: { id: string; effort: string; contextWindow: number }[];
}

/** 与完整网页的 Codex 供应商共用同一份后端配置，密钥只返回是否设置及尾号。 */
export interface CodexProvider {
  id: string;
  name: string;
  baseUrl: string;
  keySet: boolean;
  keyTail: string;
  model: string;
  reasoningEffort: string;
  contextWindow: number;
  autoCompactTokenLimit: number;
  disableResponseStorage: boolean;
}
export interface CodexProviderInput extends Omit<CodexProvider, 'id' | 'keySet' | 'keyTail'> {
  id?: string;
  apiKey?: string;
}
export interface CodexProviderState {
  providers: CodexProvider[];
  activeProviderId: string | null;
  configDir: string;
  configError: string | null;
}
