export type TerminalType = 'powershell' | 'cmd' | 'ssh' | 'docker' | 'k8s' | 'mstsc';

/** 连接配置（手机端只读，仅需导航用到的字段；后端 Profile 还有更多字段） */
export interface Profile {
  id: string;
  name: string;
  group: string;
  terminalType: TerminalType;
}

/** 存活终端实例（来自 GET /api/terminals 与 meta WS 推送） */
export interface TerminalInfo {
  id: string;
  profileId: string;
  profileName: string;
  group: string;
  terminalType: TerminalType;
  owner: 'pc' | 'web';
}
