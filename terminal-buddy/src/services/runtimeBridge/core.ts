import {
  invoke as tauriInvoke,
  convertFileSrc as tauriConvertFileSrc,
  type InvokeArgs,
  type InvokeOptions,
} from '@tauri-apps/api/core';
import {
  invoke as browserInvoke,
  convertFileSrc as browserConvertFileSrc,
} from '../browser/core';
import { isTauriRuntime } from '../platform';

export type { InvokeArgs, InvokeOptions } from '@tauri-apps/api/core';

export async function invoke<T>(
  cmd: string,
  args?: InvokeArgs,
  options?: InvokeOptions,
): Promise<T> {
  if (isTauriRuntime()) {
    return tauriInvoke<T>(cmd, args, options);
  }
  const normalizedArgs =
    args && !Array.isArray(args) && !ArrayBuffer.isView(args) && !(args instanceof ArrayBuffer)
      ? args
      : {};
  return browserInvoke<T>(cmd, normalizedArgs);
}

export function convertFileSrc(filePath: string, protocol?: string): string {
  if (isTauriRuntime()) {
    return tauriConvertFileSrc(filePath, protocol);
  }
  return browserConvertFileSrc(filePath);
}
