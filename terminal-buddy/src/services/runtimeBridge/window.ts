import { getCurrentWindow as tauriGetCurrentWindow } from '@tauri-apps/api/window';
import { getCurrentWindow as browserGetCurrentWindow } from '../browser/window';
import { isTauriRuntime } from '../platform';

export function getCurrentWindow(): ReturnType<typeof tauriGetCurrentWindow> {
  if (isTauriRuntime()) {
    return tauriGetCurrentWindow();
  }
  return browserGetCurrentWindow() as unknown as ReturnType<typeof tauriGetCurrentWindow>;
}
