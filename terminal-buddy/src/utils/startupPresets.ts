import type { ExtraParamPreset, Profile, Project } from '../types';

/** 项目和配置共用匹配规则：启用、大小写不敏感的包含匹配，空条件通用。 */
export function matchingStartupPresets(presets: ExtraParamPreset[], commands: string[]): ExtraParamPreset[] {
  return presets.filter(preset => {
    if (!preset.enabled) return false;
    const match = preset.commandMatch?.trim().toLowerCase();
    return !match || commands.some(command => command.toLowerCase().includes(match));
  });
}

/**
 * 项目右键「命令行」可用的预设：commandMatch 命中项目下任一配置的启动命令即显示
 * （空条件通用）。命令行是空白终端、没有原启动命令可追加，只保留独立命令模式。
 */
export function matchingProjectPresets(
  presets: ExtraParamPreset[],
  profiles: Profile[],
  project: Project,
): ExtraParamPreset[] {
  const commands = profiles
    .filter(profile => (profile.group || '默认') === project.name)
    .flatMap(profile => profile.startupCommands);
  return matchingStartupPresets(presets, commands).filter(preset => preset.mode === 'independent');
}
