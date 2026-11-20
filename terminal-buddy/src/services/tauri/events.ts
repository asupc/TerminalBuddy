import { listen, type UnlistenFn } from './../remoteWorkspace/events';

/** 带泛型 payload 的统一事件监听包装，免去各处手动类型断言。 */
export function listenTauri<T>(
  event: string,
  callback: (payload: T) => void,
): Promise<UnlistenFn> {
  return listen<T>(event, (event) => callback(event.payload));
}
