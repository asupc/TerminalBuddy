export type TerminalType = 'powershell' | 'cmd' | 'ssh' | 'docker' | 'k8s' | 'mstsc';

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
  dockerContainerId?: string;
  dockerContainerName?: string;
  k8sNamespace?: string;
  k8sPodName?: string;
  k8sContainerName?: string;
  mstscHost?: string;
  mstscPort?: number;
  mstscUser?: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface WebTerminalSession {
  id: string;
  profileId: string;
  profileName: string;
  terminalType: TerminalType;
  owner: 'pc' | 'web';
}

export interface TerminalInfo {
  id: string;
  profileId: string;
  profileName: string;
  terminalType: string;
  owner: 'pc' | 'web';
}
