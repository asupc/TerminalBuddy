import {
  listen as tauriListen,
  type EventCallback,
  type EventName,
  type Options,
  type UnlistenFn,
} from '@tauri-apps/api/event';
import { listen as browserListen } from '../browser/event';
import { isTauriRuntime } from '../platform';

export type { Event, EventCallback, EventName, Options, UnlistenFn } from '@tauri-apps/api/event';

export async function listen<T>(
  event: EventName,
  handler: EventCallback<T>,
  options?: Options,
): Promise<UnlistenFn> {
  if (isTauriRuntime()) {
    return tauriListen<T>(event, handler, options);
  }
  return browserListen<T>(
    event,
    handler as unknown as (e: { event: string; id: number; payload: T }) => void,
  );
}
