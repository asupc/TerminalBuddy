export type TerminalBuddyUpdatePhase = 'start' | 'switch' | 'end' | 'failed';
export type TerminalBuddyUpdateStatus =
  | 'running'
  | 'updated'
  | 'rolled-back'
  | 'rollback-failed'
  | 'recovered'
  | 'failed';

export interface TerminalBuddyUpdate {
  id: string;
  terminalId: string;
  phase: TerminalBuddyUpdatePhase;
  status: TerminalBuddyUpdateStatus;
  localLog: string;
  serverLog: string;
  online: boolean;
  reconnected: boolean;
}

const updatingTerminals = new Set<string>();
const listeners = new Set<() => void>();
let update: TerminalBuddyUpdate | null = null;

export function getTerminalBuddyUpdate(): TerminalBuddyUpdate | null {
  return update;
}

export function subscribeTerminalBuddyUpdate(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function setTerminalBuddyUpdate(value: TerminalBuddyUpdate): void {
  update = value;
  listeners.forEach(listener => listener());
}

export function patchTerminalBuddyUpdate(id: string, changes: Partial<TerminalBuddyUpdate>): void {
  if (update?.id === id) setTerminalBuddyUpdate({ ...update, ...changes });
}

export function markTerminalUpdating(id: string, updating: boolean): void {
  if (updating) updatingTerminals.add(id);
  else updatingTerminals.delete(id);
}

export function isTerminalUpdating(id: string): boolean {
  return updatingTerminals.has(id);
}

export function hasUpdatingTerminals(): boolean {
  return updatingTerminals.size > 0;
}
