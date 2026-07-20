export type TerminalType = 'powershell' | 'cmd' | 'ssh' | 'docker' | 'k8s' | 'mstsc';
export type TerminalLoadingMode = 'default' | 'vsCode';

/** 连接配置（手机端只读，仅需导航用到的字段；后端 Profile 还有更多字段） */
export interface Profile {
  id: string;
  name: string;
  group: string;
  terminalType: TerminalType;
  /** 启动命令（用于启动参数预设的 commandMatch 匹配） */
  startupCommands?: string[];
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
  /** tag 底色，取自 TAB_COLORS；null 表示跟随主题默认色 */
  tagColor: string | null;
  /** 命令匹配（PC 端用，Web 端保留字段不做过滤） */
  commandMatch: string | null;
}
