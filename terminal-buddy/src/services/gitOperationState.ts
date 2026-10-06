/** 同一仓库的写操作必须互斥；状态只在本次应用运行期间保留，不写入磁盘。 */
export type GitMutationKind = 'checkout' | 'commit' | 'pull' | 'push';

export interface GitOperationToken {
  readonly repoKey: string;
  readonly repoRoot: string;
  readonly action: GitMutationKind;
  readonly id: symbol;
}

const operations = new Map<string, GitOperationToken>();
const listeners = new Set<() => void>();

export function gitRepositoryKey(repoRoot: string): string {
  return repoRoot.trim().replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

export function getGitOperation(repoRoot: string): GitOperationToken | null {
  return operations.get(gitRepositoryKey(repoRoot)) ?? null;
}

export function subscribeGitOperations(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** 在第一个 await 之前同步获取令牌，阻止同一事件循环内的重复提交。 */
export function tryBeginGitOperation(repoRoot: string, action: GitMutationKind): GitOperationToken | null {
  const repoKey = gitRepositoryKey(repoRoot);
  if (!repoKey || operations.has(repoKey)) return null;
  const token: GitOperationToken = { repoKey, repoRoot, action, id: Symbol(action) };
  operations.set(repoKey, token);
  notify();
  return token;
}

/** 只能由启动任务持有的令牌释放，过期任务不能清除新任务的忙碌状态。 */
export function finishGitOperation(token: GitOperationToken): void {
  if (operations.get(token.repoKey) !== token) return;
  operations.delete(token.repoKey);
  notify();
}
