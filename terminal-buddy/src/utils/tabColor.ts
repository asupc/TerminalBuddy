import { getAppSettings } from './settings';

export function getWorkingDotColor(isWorking: boolean | undefined, tabColor: string | null | undefined): string {
  const baseColor = tabColor || 'var(--accent)';
  if (!isWorking) return baseColor;

  const settings = getAppSettings();
  if (settings.breathingLightColorMode === 'custom') {
    return settings.breathingLightCustomColor;
  }
  return baseColor;
}
