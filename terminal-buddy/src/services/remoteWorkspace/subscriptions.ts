import { isRemoteWorkspace } from './config';

export async function subscribeTerminal(id: string, callback: (output: string) => void): Promise<() => void> {
  if (isRemoteWorkspace()) {
    const { subscribeRemoteTerminal } = await import('./proxy');
    return subscribeRemoteTerminal(id, callback);
  }
  const { subscribeTerminal: subscribeBrowser } = await import('../browser/core');
  return subscribeBrowser(id, callback);
}
