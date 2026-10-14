import { serverPlatform } from './browser/connection';

export function isBrowserClient(): boolean {
  return import.meta.env.MODE === 'browser';
}
export function clientTerminalOwner(): 'pc' | 'web' {
  return isBrowserClient() ? 'web' : 'pc';
}

export function serverUsesWindowsPaths(): boolean {
  return !isBrowserClient() || serverPlatform === 'windows';
}
export function defaultShellType(): 'powershell' | 'bash' {
  return serverUsesWindowsPaths() ? 'powershell' : 'bash';
}
