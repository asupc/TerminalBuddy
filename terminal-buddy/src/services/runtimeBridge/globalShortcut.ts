import {
  register as tauriRegister,
  unregister as tauriUnregister,
  type ShortcutHandler,
} from '@tauri-apps/plugin-global-shortcut';
import { isTauriRuntime } from '../platform';

export type { ShortcutEvent, ShortcutHandler } from '@tauri-apps/plugin-global-shortcut';

export async function register(
  shortcuts: string | string[],
  handler: ShortcutHandler,
): Promise<void> {
  if (isTauriRuntime()) {
    return tauriRegister(shortcuts, handler);
  }
}

export async function unregister(shortcuts: string | string[]): Promise<void> {
  if (isTauriRuntime()) {
    return tauriUnregister(shortcuts);
  }
}
