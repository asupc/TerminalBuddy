import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const source = readFileSync(new URL('../src/services/gitStatusCache.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText;

// Exercise the production cache; mock only Tauri so no real Git command is run.
function createCache(lookup) {
  const exports = {};
  const calls = [];
  runInNewContext(compiled, {
    exports,
    require(name) {
      assert.equal(name, './tauri');
      return {
        getGitRepositoryStatus(path) {
          calls.push(path);
          return Promise.resolve().then(() => lookup(path, calls.length));
        },
      };
    },
  });
  return { ...exports, calls };
}

function status(repoRoot, overrides = {}) {
  return {
    repoRoot, branch: 'main', upstream: null, ahead: 0, behind: 0,
    changedCount: 0, stagedCount: 0, unstagedCount: 0, untrackedCount: 0,
    hasRemote: false, ...overrides,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

const root = 'C:\\projects\\repo';
const child = `${root}\\src`;
const tests = [
  ['cached directories are synchronous and do not start a new lookup', async () => {
    const cache = createCache(() => status(root));
    await cache.loadGitRepositoryStatus(root, { exact: true });
    const snapshot = cache.getCachedGitRepositoryStatus(root, { exact: true });
    assert.equal(snapshot.status.repoRoot, root);
    assert.equal(cache.getCachedGitRepositoryStatus(root, { exact: true }), snapshot);
    for (let i = 0; i < 5; i++) {
      await cache.loadGitRepositoryStatus(root, { exact: true });
    }
    assert.equal(cache.calls.length, 1);
  }],
  ['non-repository directories are cached too', async () => {
    const cache = createCache(() => null);
    await cache.loadGitRepositoryStatus(root, { exact: true });
    assert.equal(cache.getCachedGitRepositoryStatus(root, { exact: true }).status, null);
    await cache.loadGitRepositoryStatus(root, { exact: true });
    assert.equal(cache.calls.length, 1);
  }],
  ['prefetch, toolbar, and menu share the same pending directory lookup', async () => {
    const pending = deferred();
    const cache = createCache(() => pending.promise);
    const requests = Array.from({ length: 3 }, () => cache.loadGitRepositoryStatus(root, { exact: true }));
    assert.equal(cache.calls.length, 1);
    pending.resolve(status(root));
    const results = await Promise.all(requests);
    assert.ok(results.every(result => result.repoRoot === root));
    assert.equal(cache.calls.length, 1);
  }],
  ['nested repositories are detected once instead of inheriting the parent identity', async () => {
    const nested = `${root}\\nested`;
    const cache = createCache(path => status(path === nested ? nested : root));
    await cache.loadGitRepositoryStatus(root, { exact: true });
    assert.equal(cache.getCachedGitRepositoryStatus(nested, { exact: true }), undefined);
    assert.equal(cache.getCachedGitRepositoryStatus(nested).status.repoRoot, root);
    await cache.loadGitRepositoryStatus(nested, { exact: true });
    assert.equal(cache.getCachedGitRepositoryStatus(nested, { exact: true }).status.repoRoot, nested);
    await cache.loadGitRepositoryStatus(nested, { exact: true });
    assert.equal(cache.calls.length, 2);
  }],
  ['a negative exact result is not overwritten by the parent cache', async () => {
    const cache = createCache(path => path === root ? status(root) : null);
    await cache.loadGitRepositoryStatus(root, { exact: true });
    await cache.loadGitRepositoryStatus(child, { exact: true });
    assert.equal(cache.getCachedGitRepositoryStatus(child).status, null);
    assert.equal(cache.getCachedGitRepositoryStatus(child, { exact: true }).status, null);
    await cache.loadGitRepositoryStatus(child, { exact: true });
    assert.equal(cache.calls.length, 2);
  }],
  ['directory aliases observe refreshed branch and remote state', async () => {
    let current = status(root);
    const cache = createCache(() => current);
    await cache.loadGitRepositoryStatus(child, { exact: true });
    current = status(root, { branch: 'feature', hasRemote: true });
    await cache.loadGitRepositoryStatus(root, { force: true, exact: true });
    const snapshot = cache.getCachedGitRepositoryStatus(child, { exact: true });
    assert.equal(snapshot.status.branch, 'feature');
    assert.equal(snapshot.status.hasRemote, true);
    assert.equal(cache.calls.length, 2);
  }],
  ['manual refresh detects external git init and repository removal', async () => {
    let current = null;
    const cache = createCache(() => current);
    await cache.loadGitRepositoryStatus(root, { exact: true });
    current = status(root);
    await cache.loadGitRepositoryStatus(root, { force: true, exact: true });
    await cache.loadGitRepositoryStatus(child, { exact: true });
    current = null;
    await cache.loadGitRepositoryStatus(root, { force: true, exact: true });
    assert.equal(cache.getCachedGitRepositoryStatus(root, { exact: true }).status, null);
    assert.equal(cache.getCachedGitRepositoryStatus(child, { exact: true }).status, null);
    assert.equal(cache.getCachedGitRepositoryStatus(`${root}\\other`), undefined);
  }],
  ['forced refresh waits for an older lookup and does not reuse its result', async () => {
    const old = deferred();
    const cache = createCache((_, count) => count === 1 ? old.promise : status(root, { branch: 'new' }));
    const first = cache.loadGitRepositoryStatus(root, { exact: true });
    const refresh = cache.loadGitRepositoryStatus(root, { force: true, exact: true });
    assert.equal(cache.calls.length, 1);
    old.resolve(status(root, { branch: 'old' }));
    await first;
    const result = await refresh;
    assert.equal(result.branch, 'new');
    assert.equal(cache.calls.length, 2);
  }],
  ['pending parent refreshes do not replace a nested-directory lookup', async () => {
    const nested = `${root}\nested`;
    const pending = deferred();
    let refreshPending = false;
    const cache = createCache(path => path === nested
      ? status(nested)
      : refreshPending ? pending.promise : status(root));
    await cache.loadGitRepositoryStatus(root, { exact: true });
    refreshPending = true;
    const parentRefresh = cache.loadGitRepositoryStatus(root, { force: true, exact: true });
    const detected = await cache.loadGitRepositoryStatus(nested, { exact: true });
    assert.equal(detected.repoRoot, nested);
    assert.equal(cache.calls.length, 3);
    pending.resolve(status(root));
    await parentRefresh;
  }],
  ['normalized directory spellings reuse the same detection', async () => {
    const cache = createCache(() => status(root));
    await cache.loadGitRepositoryStatus(root, { exact: true });
    const alias = `${root.toUpperCase().replace(/\\/g, '/')}\\`;
    await cache.loadGitRepositoryStatus(alias, { exact: true });
    assert.equal(cache.calls.length, 1);
  }],
  ['cache subscribers are notified on updates, not repeated reads', async () => {
    const cache = createCache(() => status(root));
    let notifications = 0;
    const unsubscribe = cache.subscribeGitRepositoryStatus(() => { notifications++; });
    await cache.loadGitRepositoryStatus(root, { exact: true });
    await cache.loadGitRepositoryStatus(root, { exact: true });
    assert.equal(notifications, 1);
    unsubscribe();
    await cache.loadGitRepositoryStatus(root, { force: true, exact: true });
    assert.equal(notifications, 1);
  }],
];

for (const [label, run] of tests) {
  await run();
  console.log(`PASS ${label}`);
}
console.log(`\n${tests.length} Git cache regression checks passed.`);
