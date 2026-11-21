import { getCurrentWebview as tauriGetCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWebview as browserGetCurrentWebview } from '../browser/webview';
import { isTauriRuntime } from '../platform';

export function getCurrentWebview(): ReturnType<typeof tauriGetCurrentWebview> {
  if (isTauriRuntime()) {
    return tauriGetCurrentWebview();
  }
  return browserGetCurrentWebview() as unknown as ReturnType<typeof tauriGetCurrentWebview>;
}
