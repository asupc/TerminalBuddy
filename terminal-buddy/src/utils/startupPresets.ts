import type { ExtraParamPreset } from '../types';

/** 项目和配置共用匹配规则：启用、大小写不敏感的包含匹配，空条件通用。 */
export function matchingStartupPresets(presets: ExtraParamPreset[], commands: string[]): ExtraParamPreset[] {
  return presets.filter(preset => {
    if (!preset.enabled) return false;
    const match = preset.commandMatch?.trim().toLowerCase();
    return !match || commands.some(command => command.toLowerCase().includes(match));
  });
}
