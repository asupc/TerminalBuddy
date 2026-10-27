import type { TerminalActivityPhase } from '../stores/appStore';

export interface PiOscStatus {
  phase: TerminalActivityPhase;
  state: string;
  kind?: string;
  message?: string;
}

const PHASE_BY_STATE: Record<string, TerminalActivityPhase> = {
  working: 'running',
  blocked: 'attention',
  done: 'completed',
  completed: 'completed',
  error: 'failed',
  failed: 'failed',
  idle: 'idle',
  clear: 'idle',
};

function decodeBase64(value: string): string | undefined {
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * 解析 OSC 7501：`state=working:app=pi:kind=permission:msg=<base64>`。
 * 只识别 Pi 的状态；其他程序的状态不干扰指示灯。
 */
export function parsePiOscStatus(data: string): PiOscStatus | null {
  const fields = new Map<string, string>();
  for (const part of data.split(':')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    fields.set(part.slice(0, separator).trim().toLowerCase(), part.slice(separator + 1).trim());
  }
  const app = fields.get('app')?.toLowerCase();
  if (app && app !== 'pi') return null;
  const state = fields.get('state')?.toLowerCase();
  if (!state) return null;
  const phase = PHASE_BY_STATE[state];
  if (!phase) return null;
  const encoded = fields.get('msg');
  const message = encoded ? decodeBase64(encoded)?.trim() : undefined;
  return {
    phase,
    state,
    kind: fields.get('kind')?.toLowerCase(),
    message: message || undefined,
  };
}
