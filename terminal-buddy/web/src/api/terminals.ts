import client from './client';
import type { TerminalInfo } from '../types';

/** Estimate terminal rows/cols from the current viewport for PTY initialization.
 *  Intentionally undershoots so the first xterm fit+resize is always a "grow",
 *  which the backend's resize policy always allows. */
function estimateTerminalSize(): { rows: number; cols: number } {
  const isMobile = window.innerWidth < 768;
  const fontSize = isMobile ? 12 : 14;
  // Slightly generous char dimensions → fewer cols/rows → undershoot
  const cellWidth = fontSize * 0.65;
  const cellHeight = fontSize * 1.4;
  const sidebarWidth = isMobile ? 0 : 220;
  const availWidth = window.innerWidth - sidebarWidth - 20;
  const availHeight = window.innerHeight - 40;
  return {
    cols: Math.max(Math.floor(availWidth / cellWidth) - 2, 40),
    rows: Math.max(Math.floor(availHeight / cellHeight) - 1, 10),
  };
}

export async function listTerminals(): Promise<TerminalInfo[]> {
  const { data } = await client.get('/terminals');
  return data;
}

export async function startTerminal(profileId: string): Promise<TerminalInfo> {
  const { rows, cols } = estimateTerminalSize();
  const { data } = await client.post('/terminals', { profileId, rows, cols });
  return data;
}

export async function closeTerminal(id: string): Promise<void> {
  await client.delete(`/terminals/${id}`);
}
