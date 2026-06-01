export type TerminalType = 'powershell' | 'cmd' | 'ssh' | 'docker' | 'k8s' | 'editor' | 'mstsc';

export interface Profile {
  id: string;
  name: string;
  group: string;
  terminalType: TerminalType;
  startupPath: string;
  startupCommands: string[];
  environmentVariables: Record<string, string>;
  colorTheme: string;
  tabColor: string | null;
  windowSize: { width: number; height: number } | null;
  sshHost?: string;
  sshPort?: number;
  sshUser?: string;
  sshAuthType?: 'password' | 'key';
  sshKeyPath?: string;
  sshPassword?: string;
  dockerContainerId?: string;
  dockerContainerName?: string;
  k8sNamespace?: string;
  k8sPodName?: string;
  k8sContainerName?: string;
  mstscHost?: string;
  mstscPort?: number;
  mstscUser?: string;
  mstscPassword?: string;
  mstscResolution?: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface ColorTheme {
  id: string;
  name: string;
  background: string;
  foreground: string;
}

export interface CustomTheme extends ColorTheme {
  cursor: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
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

export interface TabColorOption {
  id: string;
  name: string;
  color: string;
}

export const TAB_COLORS: (TabColorOption | null)[] = [
  null, // theme default
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

export const BREATHING_LIGHT_COLORS: TabColorOption[] = TAB_COLORS.filter(
  (c): c is TabColorOption => c !== null && !['grey', 'white'].includes(c.id)
);

export interface TerminalSession {
  id: string;
  profileId: string;
  profileName: string;
  terminalType: TerminalType;
  colorTheme: { background: string; foreground: string };
  tabColor: string | null;
  groupId: string;
  sessionType?: 'terminal' | 'editor';
  isDirty?: boolean;
  sshRemotePath?: string;
  sshTerminalId?: string;
  owner?: 'pc' | 'web';
}

export interface Workspace {
  id: string;
  name: string;
  icon?: string;
  groups: WorkspaceGroup[];
  createdAt: string;
  lastUsedAt: string;
}

export interface WorkspaceGroup {
  id: string;
  name: string;
  color?: string;
  terminals: WorkspaceTerminal[];
  collapsed: boolean;
}

export interface WorkspaceTerminal {
  profileId?: string;
  terminalType: TerminalType;
  startupPath?: string;
  startupCommands?: string[];
  environmentVariables?: Record<string, string>;
  sshHost?: string;
  sshPort?: number;
  sshUser?: string;
  sshAuthType?: 'password' | 'key';
  sshKeyPath?: string;
  dockerContainerId?: string;
  dockerContainerName?: string;
  k8sNamespace?: string;
  k8sPodName?: string;
  k8sContainerName?: string;
  colorTheme?: string;
  tabColor?: string;
}

export interface TabGroup {
  id: string;
  name: string;
  color?: string;
  collapsed: boolean;
}

export interface ExtraParamPreset {
  id: string;
  name: string;
  params: string;
}

export interface RemoteFileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  permissions: number;
  modified: number;
  owner: string;
  group: string;
}

export interface ServerStats {
  uptime: string;
  cpuUsage: number;
  memory: MemoryStats;
  disk: DiskStats[];
  network: NetworkStats;
  timestamp: number;
}

export interface MemoryStats {
  total: number;
  used: number;
  available: number;
  usagePercent: number;
  swapTotal: number;
  swapUsed: number;
}

export interface DiskStats {
  mount: string;
  total: number;
  used: number;
  available: number;
  usagePercent: number;
}

export interface NetworkStats {
  rxBytes: number;
  txBytes: number;
  rxSpeed: number;
  txSpeed: number;
}

export type TransferStatus = 'active' | 'completed' | 'failed';
export type TransferDirection = 'upload' | 'download';
export interface TransferItem {
  id: string;
  terminalId: string;
  direction: TransferDirection;
  remotePath: string;
  localPath: string;
  fileName: string;
  status: TransferStatus;
  transferred: number;
  total: number;
  percent: number;
  error?: string;
}
