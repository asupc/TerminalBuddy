import {
  open as tauriOpen,
  save as tauriSave,
  type OpenDialogOptions,
  type OpenDialogReturn,
  type SaveDialogOptions,
} from '@tauri-apps/plugin-dialog';
import { isTauriRuntime } from '../platform';

export type {
  DialogFilter,
  OpenDialogOptions,
  OpenDialogReturn,
  SaveDialogOptions,
} from '@tauri-apps/plugin-dialog';

export async function open<T extends OpenDialogOptions>(
  options?: T,
): Promise<OpenDialogReturn<T>> {
  if (isTauriRuntime()) {
    return tauriOpen(options);
  }
  const { open: browserOpen } = await import('../browser/dialog');
  return (await browserOpen(options)) as OpenDialogReturn<T>;
}

export async function save(options?: SaveDialogOptions): Promise<string | null> {
  if (isTauriRuntime()) {
    return tauriSave(options);
  }
  const { save: browserSave } = await import('../browser/dialog');
  return browserSave(options);
}
