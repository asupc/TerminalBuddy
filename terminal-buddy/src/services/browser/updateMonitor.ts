import { request } from './connection';

export type TerminalBuddyUpdatePhase = 'start' | 'switch' | 'end';
export type TerminalBuddyUpdateStatus =
  | 'running'
  | 'updated'
  | 'rolled-back'
  | 'rollback-failed'
  | 'recovered';

export interface TerminalBuddyUpdateMarker {
  phase: TerminalBuddyUpdatePhase;
  id: string;
}

export interface TerminalBuddyUpdateStatusResponse {
  updateId: string;
  status: TerminalBuddyUpdateStatus;
  log: string;
}

const markerPattern = /\x1b\]7777;terminal-buddy-update;(start|switch);([A-Za-z0-9_.-]+)(?:\x07|\x1b\\)/g;

/**
 * 解析 update.sh 通过 PTY 输出的私有 OSC 标记。
 * 标记不会渲染到 xterm 画面，但会在原始 output 回调中出现。
 */
export function parseTerminalBuddyUpdateMarkers(
  buffer: string,
): TerminalBuddyUpdateMarker[] {
  const markers: TerminalBuddyUpdateMarker[] = [];
  markerPattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = markerPattern.exec(buffer))) {
    markers.push({ phase: match[1] as TerminalBuddyUpdatePhase, id: match[2] });
  }
  return markers;
}

export function keepUpdateMarkerTail(buffer: string): string {
  // 标记最长约 90 字节；保留 256 字节足以跨 output 分包拼接。
  return buffer.length <= 256 ? buffer : buffer.slice(-256);
}

export function terminalBuddyUpdateText(output: string): string {
  return output
    .replace(markerPattern, '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

export async function getTerminalBuddyUpdateStatus(id: string): Promise<TerminalBuddyUpdateStatusResponse> {
  return request<TerminalBuddyUpdateStatusResponse>(`/api/update/status?id=${encodeURIComponent(id)}`);
}
