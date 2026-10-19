const updatingTerminals = new Set<string>();

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
