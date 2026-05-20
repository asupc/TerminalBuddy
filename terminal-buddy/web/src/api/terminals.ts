import client from './client';
import type { TerminalInfo } from '../types';

export async function listTerminals(): Promise<TerminalInfo[]> {
  const { data } = await client.get('/terminals');
  return data;
}

export async function startTerminal(profileId: string): Promise<TerminalInfo> {
  const { data } = await client.post('/terminals', { profileId });
  return data;
}

export async function closeTerminal(id: string): Promise<void> {
  await client.delete(`/terminals/${id}`);
}
