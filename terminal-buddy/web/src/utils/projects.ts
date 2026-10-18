import { api } from '../api';
import type { ExtraParamPreset, Profile, Project } from '../types';

export const DEFAULT_CLAUDE_COMMAND = 'claude --dangerously-skip-permissions';

export const PINNED_GROUP = '__pinned__';
export const LOCAL_TYPES = ['powershell', 'pwsh', 'cmd', 'bash', 'sh', 'zsh'];

export function effectiveProfilePath(profile: Profile, projects: Project[]): string {
  const base =
    projects.find((p) => p.name === (profile.group?.trim() || '默认'))?.path.trim() || '';
  const override = profile.startupPath?.trim() || '';
  if (!override) return base;
  if (/^(?:[a-z]:[\\/]|\\\\|\/)/i.test(override)) return override;
  return base ? `${base.replace(/[\\/]+$/, '')}/${override}` : '';
}

export function normalizePath(path: string | undefined, windows: boolean): string {
  const clean = (path || '').trim().replace(/\\/g, '/');
  const normalized = windows ? clean.toLowerCase() : clean;
  const prefix = normalized.startsWith('//') ? '//' : normalized.startsWith('/') ? '/' : '';
  const segments: string[] = [];
  for (const segment of normalized.slice(prefix.length).split('/')) {
    if (!segment || segment === '.') continue;
    if (
      segment === '..' &&
      segments.length &&
      segments[segments.length - 1] !== '..' &&
      !segments[segments.length - 1].endsWith(':')
    )
      segments.pop();
    else if (segment !== '..' || !prefix) segments.push(segment);
  }
  return prefix + segments.join('/');
}

export function matchingPresets(
  presets: ExtraParamPreset[],
  commands: string[],
): ExtraParamPreset[] {
  return presets.filter(
    (p) =>
      p.enabled !== false &&
      (!p.commandMatch ||
        commands.some((c) => c.toLowerCase().includes(p.commandMatch!.toLowerCase()))),
  );
}

export function isClaudeCommand(command: string): boolean {
  return /(?:^|[\s"'=])claude(?:\.cmd|\.exe|\.bat)?(?=$|[\s"'=])/i.test(command);
}

/** 模型引用替换整条命令，继承原 Claude 参数；跨工具启动使用默认命令。 */
export function modelCommand(providerId: string, modelId: string, commands: string[]): string {
  const command = commands.find(isClaudeCommand) ?? DEFAULT_CLAUDE_COMMAND;
  const match = /(?:[\s"'=]|^)claude(?:\.cmd|\.exe|\.bat)?["']?(?=$|\s)/i.exec(command);
  const args = match
    ? command.slice(match.index + match[0].length).split(/&&|\|\||;|\|/, 1)[0]
    : '';
  const inherited = args
    .replace(
      /(^|\s)--(model|settings|effort)(=("[^"]*"|'[^']*'|[^\s]+)|\s+("[^"]*"|'[^']*'|[^\s]+))?/gi,
      ' ',
    )
    .replace(/\s+/g, ' ')
    .trim();
  return [`__TB_CLAUDE_REF__:${providerId}:${modelId}`, inherited].filter(Boolean).join(' ');
}

/** 新建和复制保留完整字段；第二步失败时清理刚创建的空配置。 */
export async function createProfileFrom(
  source: Partial<Profile> & Pick<Profile, 'name' | 'group' | 'terminalType'>,
): Promise<void> {
  const created = await api.createProfile(source.name, source.group, source.terminalType);
  try {
    await api.updateProfile({
      ...created,
      ...source,
      id: created.id,
      createdAt: created.createdAt,
      lastUsedAt: null,
    });
  } catch (error) {
    try {
      await api.deleteProfile(created.id);
    } catch {
      /* 保留原始保存错误 */
    }
    throw error;
  }
}

/** 项目改名同步所属配置；旧版复制进去的项目路径转为继承，显式覆盖路径保留。 */
export async function saveProject(
  project: Project,
  original: Project | null,
  projects: Project[],
  profiles: Profile[],
  windows: boolean,
): Promise<void> {
  const updated = [...projects.filter((p) => p.name !== original?.name), project];
  const changed: Profile[] = [];
  let projectsSaved = false;
  try {
    await api.saveProjects(updated.filter((p) => p.path.trim()));
    projectsSaved = true;
    if (!original) return;
    for (const profile of profiles.filter((p) => (p.group?.trim() || '默认') === original.name)) {
      const inherits =
        !!original.path &&
        normalizePath(profile.startupPath, windows) === normalizePath(original.path, windows);
      if (profile.group === project.name && !inherits) continue;
      await api.updateProfile({
        ...profile,
        group: project.name,
        startupPath: inherits ? '' : profile.startupPath,
      });
      changed.push(profile);
    }
  } catch (error) {
    // 避免中途失败留下部分改名；刷新后仍可重试。
    for (const profile of changed.reverse()) {
      try {
        await api.updateProfile(profile);
      } catch {
        /* 主界面会重新拉取实际状态 */
      }
    }
    if (projectsSaved) {
      try {
        await api.saveProjects(projects.filter((p) => p.path.trim()));
      } catch {
        /* 保留原始错误 */
      }
    }
    throw error;
  }
}
