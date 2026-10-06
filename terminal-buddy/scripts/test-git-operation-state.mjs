import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const compiled = new Map();
const jsx = {
  jsx: (type, props, key) => ({ type, props: props ?? {}, key }),
  jsxs: (type, props, key) => ({ type, props: props ?? {}, key }),
  Fragment: Symbol('Fragment'),
};

function load(relativePath, modules = {}) {
  if (!compiled.has(relativePath)) {
    compiled.set(relativePath, ts.transpileModule(
      readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8'),
      { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } },
    ).outputText);
  }
  const exports = {};
  runInNewContext(compiled.get(relativePath), {
    exports,
    require(name) {
      if (name in modules) return modules[name];
      if (name.endsWith('.css')) return {};
      throw new Error(`Unmocked import: ${name}`);
    },
    console,
    window: { innerWidth: 1280, innerHeight: 800, addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout },
    document: { addEventListener() {}, removeEventListener() {} },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
  });
  return exports;
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const equalDeps = (left, right) => left && right && left.length === right.length
  && left.every((value, index) => Object.is(value, right[index]));

// Small deterministic hook runner: executes production hook bodies; does not perform real Git I/O.
function hooks() {
  const slots = [];
  let cursor = 0, dirty = true, effects = [], tree, renderFunction;
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { value: typeof initial === 'function' ? initial() : initial };
      return [slots[index].value, update => {
        const value = typeof update === 'function' ? update(slots[index].value) : update;
        if (!Object.is(value, slots[index].value)) { slots[index].value = value; dirty = true; }
      }];
    },
    useRef(initial) { const index = cursor++; return slots[index] ?? (slots[index] = { current: initial }); },
    useMemo(factory, deps) {
      const index = cursor++;
      if (!slots[index] || !equalDeps(slots[index].deps, deps)) slots[index] = { deps, value: factory() };
      return slots[index].value;
    },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps); },
    useEffect(fn, deps) {
      const index = cursor++;
      if (!slots[index] || !equalDeps(slots[index].deps, deps)) {
        slots[index] = { deps, cleanup: slots[index]?.cleanup };
        effects.push(() => { slots[index].cleanup?.(); slots[index].cleanup = fn(); });
      }
    },
    useLayoutEffect(fn, deps) { react.useEffect(fn, deps); },
    useSyncExternalStore(subscribe, getSnapshot) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { cleanup: subscribe(() => { dirty = true; }) };
      return getSnapshot();
    },
    useImperativeHandle(ref, factory) { cursor++; if (ref) ref.current = factory(); },
    forwardRef(fn) { return fn; },
  };
  function render(commit = () => {}) {
    cursor = 0; dirty = false; tree = renderFunction(); commit(tree);
    const pending = effects; effects = []; pending.forEach(fn => fn());
  }
  return {
    react,
    get tree() { return tree; },
    mount(fn, commit) { renderFunction = fn; render(commit); },
    async settle(commit) {
      for (let i = 0; i < 20; i++) { await Promise.resolve(); if (dirty) render(commit); }
    },
    dispose() { for (const slot of slots) slot?.cleanup?.(); },
  };
}

function elements(tree, predicate, results = []) {
  if (Array.isArray(tree)) tree.forEach(child => elements(child, predicate, results));
  else if (tree && typeof tree === 'object') {
    if (predicate(tree)) results.push(tree);
    elements(tree.props?.children, predicate, results);
  }
  return results;
}
const find = (tree, predicate) => elements(tree, predicate)[0];
const root = 'C:\projects\repo';
const otherRoot = 'C:\projects\other';
const repository = repoRoot => ({
  repoRoot, branch: 'main', hasRemote: true, upstream: 'origin/main', ahead: 1, behind: 1,
  changedCount: 1, stagedCount: 0, unstagedCount: 1, untrackedCount: 0,
});
const operationModule = () => load('src/services/gitOperationState.ts');

function createBar(operations = operationModule(), overrides = {}) {
  const runner = hooks();
  let props = { currentDirectory: root, showToolbar: true };
  const ref = { current: null };
  const calls = { pull: 0, push: 0, listen: 0, unlisten: 0, checkout: 0, commit: 0 };
  const alerts = [];
  const pull = deferred();
  const push = deferred();
  let pushOutput;
  const api = {
    gitPull() { calls.pull++; return pull.promise; },
    gitPushWithOptions() { calls.push++; return push.promise; },
    async listenGitPushOutput(_, callback) { calls.listen++; pushOutput = callback; return () => { calls.unlisten++; }; },
    async gitListBranches() { return [{ name: 'feature', isCurrent: false }]; },
    async gitGetChangedFiles() { return [{ path: 'file.ts', untracked: false }]; },
    async gitCheckoutBranch() { calls.checkout++; return 'Switched'; },
    async gitCommitPaths() { calls.commit++; return 'Committed'; },
    async gitPreviewPush() { return { commits: [], warning: null }; },
    ...overrides,
  };
  const changedStatuses = new Map();
  const cacheListeners = new Set();
  const statusAt = path => changedStatuses.has(path) ? changedStatuses.get(path) : repository(path);
  const cache = {
    getCachedGitRepositoryStatus: path => ({ status: statusAt(path), updatedAt: 0 }),
    loadGitRepositoryStatus: async path => statusAt(path),
    subscribeGitRepositoryStatus: listener => { cacheListeners.add(listener); return () => cacheListeners.delete(listener); },
  };
  const Component = load('src/components/git/GitNavBar.tsx', {
    react: runner.react, 'react/jsx-runtime': jsx, 'lucide-react': {},
    '../../services/tauri': api, '../../services/gitStatusCache': cache,
    '../../services/gitOperationState': operations,
    '../../stores/appStore': { useAppStore: selector => selector({ openGitHistoryTab() {} }) },
    '../../services/dialog': { showAlert: async (...args) => { alerts.push(args); } },
    './navbar-utils': {
      buildStatusTitle: () => '', compactOutput: value => value,
      parseUpstream: () => ({ remote: 'origin', branch: 'main' }), buildPushCommandPreview: () => 'git push',
    },
    './GitDialogs': { PullDialog: 'PullDialog', PushDialog: 'PushDialog', CommitDialog: 'CommitDialog' },
  }).GitNavBar;
  runner.mount(() => Component(props, ref));
  return {
    ...runner, calls, alerts, pull, push, ref, operations,
    get tree() { return runner.tree; },
    setProps(next) { props = { ...props, ...next }; runner.mount(() => Component(props, ref)); },
    output(chunk) { pushOutput?.(chunk); },
    updateRepositoryStatus(path, status) { changedStatuses.set(path, status); for (const listener of cacheListeners) listener(); },
  };
}

const tests = [
  ['repository mutex is synchronous, normalized, and token-owned', async () => {
    const ops = operationModule();
    const first = ops.tryBeginGitOperation(root, 'pull');
    assert.ok(first);
    assert.equal(ops.tryBeginGitOperation(root.toUpperCase().replace(/\\/g, '/'), 'commit'), null);
    assert.ok(ops.tryBeginGitOperation(otherRoot, 'push'));
    ops.finishGitOperation(first);
    const second = ops.tryBeginGitOperation(root, 'checkout');
    ops.finishGitOperation(first);
    assert.equal(ops.getGitOperation(root), second);
    ops.finishGitOperation(second);
    assert.equal(ops.getGitOperation(root), null);
  }],
  ['same-turn pull calls dispatch only one backend operation', async () => {
    const bar = createBar(); await bar.settle();
    const first = bar.ref.current.startPull();
    await bar.ref.current.startPull();
    assert.equal(bar.calls.pull, 1);
    await bar.settle();
    assert.equal(find(bar.tree, item => item.props.className === 'git-icon-btn commit').props.disabled, true);
    bar.pull.resolve({ command: 'git pull', output: 'done', updatedCommits: [] });
    await first; await bar.settle();
    assert.equal(bar.operations.getGitOperation(root), null); bar.dispose();
  }],
  ['closing and hiding a pull dialog retains running status and final output', async () => {
    const bar = createBar(); await bar.settle(); const task = bar.ref.current.startPull(); await bar.settle();
    find(bar.tree, item => item.type === 'PullDialog').props.onClose(); await bar.settle();
    assert.equal(find(bar.tree, item => item.type === 'PullDialog'), undefined);
    bar.setProps({ showToolbar: false }); await bar.settle();
    assert.equal(bar.operations.getGitOperation(root).action, 'pull');
    await bar.ref.current.startPull(); assert.equal(bar.calls.pull, 1);
    bar.ref.current.showOperationDialog(); await bar.settle();
    assert.equal(find(bar.tree, item => item.type === 'PullDialog').props.pullDialog.phase, 'running');
    bar.pull.resolve({ command: 'git pull', output: 'retained result', updatedCommits: [] });
    await task; await bar.settle();
    const dialog = find(bar.tree, item => item.type === 'PullDialog');
    assert.equal(dialog.props.status.repoRoot, root);
    assert.equal(dialog.props.pullDialog.output, 'retained result');
    assert.equal(dialog.props.pullDialog.phase, 'success'); bar.dispose();
  }],
  ['push acquires the mutex before asynchronous listener registration', async () => {
    const registration = deferred(); let registrations = 0;
    const bar = createBar(undefined, { listenGitPushOutput() { registrations++; return registration.promise; } });
    await bar.settle(); bar.ref.current.openPushDialog(); await bar.settle();
    const submit = find(bar.tree, item => item.type === 'PushDialog').props.submitPushDialog;
    const task = submit(); await submit();
    assert.equal(registrations, 1); assert.equal(bar.operations.getGitOperation(root).action, 'push');
    registration.resolve(() => {}); await bar.settle(); assert.equal(bar.calls.push, 1);
    bar.push.resolve({ output: 'pushed', command: 'git push', outgoingCommits: [] });
    await task; assert.equal(bar.operations.getGitOperation(root), null); bar.dispose();
  }],
  ['failed output registration releases the mutex and records the error', async () => {
    const bar = createBar(undefined, { async listenGitPushOutput() { throw new Error('listener failed'); } });
    await bar.settle(); bar.ref.current.openPushDialog(); await bar.settle();
    await find(bar.tree, item => item.type === 'PushDialog').props.submitPushDialog(); await bar.settle();
    assert.equal(bar.operations.getGitOperation(root), null); assert.equal(bar.calls.push, 0);
    const dialog = find(bar.tree, item => item.type === 'PushDialog');
    assert.equal(dialog.props.pushDialog.phase, 'error'); assert.match(dialog.props.pushDialog.output, /listener failed/);
    bar.dispose();
  }],
  ['closing push progress retains live output and unregisters once after completion', async () => {
    const bar = createBar(); await bar.settle(); bar.ref.current.openPushDialog(); await bar.settle();
    const task = find(bar.tree, item => item.type === 'PushDialog').props.submitPushDialog(); await bar.settle();
    find(bar.tree, item => item.type === 'PushDialog').props.onClose(); await bar.settle();
    bar.output('live output'); bar.setProps({ showToolbar: false }); await bar.settle();
    assert.equal(bar.calls.unlisten, 0);
    bar.ref.current.showOperationDialog(); await bar.settle();
    assert.match(find(bar.tree, item => item.type === 'PushDialog').props.pushDialog.output, /live output/);
    bar.push.resolve({ output: '', command: 'git push', outgoingCommits: [] }); await task; await bar.settle();
    assert.match(find(bar.tree, item => item.type === 'PushDialog').props.pushDialog.output, /live output/);
    assert.equal(bar.calls.unlisten, 1); assert.equal(bar.operations.getGitOperation(root), null); bar.dispose();
  }],
  ['a second controller cannot bypass another controller\'s repository lock', async () => {
    const ops = operationModule(); const first = createBar(ops), second = createBar(ops);
    await first.settle(); await second.settle(); const task = first.ref.current.startPull(); await second.settle();
    await second.ref.current.startPull(); second.ref.current.openCommitDialog();
    assert.equal(second.calls.pull, 0); assert.equal(find(second.tree, item => item.type === 'CommitDialog'), undefined);
    first.pull.reject(new Error('network failed')); await task; await first.settle(); await second.settle();
    assert.equal(ops.getGitOperation(root), null);
    assert.equal(find(first.tree, item => item.type === 'PullDialog').props.pullDialog.phase, 'error');
    first.dispose(); second.dispose();
  }],
  ['commit submit and branch checkout share the same mutation guard', async () => {
    const commit = deferred(); const bar = createBar(undefined, { gitCommitPaths() { bar.calls.commit++; return commit.promise; } });
    await bar.settle(); bar.ref.current.openCommitDialog(); await bar.settle();
    find(bar.tree, item => item.type === 'CommitDialog').props.setCommitMessage('message'); await bar.settle();
    const submit = find(bar.tree, item => item.type === 'CommitDialog').props.onSubmit;
    const event = { preventDefault() {} }; const task = submit(event); await submit(event);
    await bar.ref.current.startPull(); assert.equal(bar.calls.commit, 1); assert.equal(bar.calls.pull, 0);
    commit.resolve('committed'); await task; await bar.settle(); assert.equal(bar.operations.getGitOperation(root), null);
    bar.dispose();
  }],
  ['duplicate checkout calls remain serialized after closing the branch list', async () => {
    const checkout = deferred();
    const bar = createBar(undefined, { gitCheckoutBranch() { bar.calls.checkout++; return checkout.promise; } });
    await bar.settle(); await bar.ref.current.loadBranches(); await bar.settle();
    const branch = find(bar.tree, item => item.props.className === 'git-list-row ');
    assert.ok(branch);
    const task = branch.props.onClick(); await branch.props.onClick();
    await bar.ref.current.startPull(); assert.equal(bar.calls.checkout, 1); assert.equal(bar.calls.pull, 0);
    checkout.resolve('Switched'); await task; await bar.settle();
    assert.equal(bar.operations.getGitOperation(root), null); assert.equal(bar.alerts.length, 1);
    bar.dispose();
  }],
  ['file context menus observe repository busy state and dispatch their own root', async () => {
    const runner = hooks(), operations = operationModule();
    const fakeHost = () => null, fakeRoot = () => null, dispatched = [];
    const store = {
      currentDirectory: root, activeSessionId: 'a', activeSpecialTab: null,
      sessions: [{ id: 'a', terminalType: 'powershell' }], sessionDirectories: {},
      profiles: [], projects: [], fileRoots: [root, otherRoot], fileTreeVisible: true,
      fileSortBy: 'name', fileSortDir: 'asc', addFileRoot() {}, removeFileRoot() {}, setFileSort() {},
    };
    const useStore = selector => selector(store); useStore.getState = () => store;
    const entries = new Map([root, otherRoot].map(path => [path, { status: repository(path) }]));
    const cache = {
      getCachedGitRepositoryStatus: path => entries.get(path),
      subscribeGitRepositoryStatus: () => () => {},
      loadGitRepositoryStatus: async path => entries.get(path)?.status ?? null,
    };
    const Component = load('src/components/file-explorer/FileNav.tsx', {
      react: runner.react, 'react/jsx-runtime': jsx, 'lucide-react': {}, '@tauri-apps/plugin-dialog': {},
      '../../services/tauri': { getBackendAppSettings: async () => ({}) },
      '../../stores/appStore': { useAppStore: useStore },
      '../../hooks/useActiveTabProjectDirectory': { useActiveTabProjectDirectory: () => root },
      '../../utils/projectPath': {}, '../../utils/openTerminalInDir': {}, '../../utils/contextMenu': {},
      '../../utils/terminalResizeEvent': {}, '../../services/dialog': {},
      '../../services/gitOperationState': operations, '../../services/gitStatusCache': cache,
      '../git/GitOperationsHost': { GitOperationsHost: fakeHost }, './RemoteFileTree': {}, '../shared/Dialog': {},
      './ConfiguredFileRoot': { ConfiguredFileRoot: fakeRoot },
      './file-utils': load('src/components/file-explorer/file-utils.ts'),
    }).FileNav;
    const commit = tree => {
      const host = find(tree, item => item.type === fakeHost);
      host.props.ref.current = { runAction: (path, action) => dispatched.push({ path, action }) };
    };
    const event = { preventDefault() {}, stopPropagation() {}, clientX: 100, clientY: 100 };
    runner.mount(() => Component({ isSidebarMode: false }), commit); await runner.settle(commit);
    find(runner.tree, item => item.type === fakeRoot).props.onRootContextMenu(event, root); await runner.settle(commit);
    const token = operations.tryBeginGitOperation(root, 'pull'); await runner.settle(commit);
    assert.equal(find(runner.tree, item => item.props.children === '拉取最新代码').props.disabled, true);
    assert.equal(find(runner.tree, item => item.props.children === '提交变更…').props.disabled, true);
    assert.equal(find(runner.tree, item => item.props.children === '查看 Git 操作进度…').props.disabled, false);
    find(runner.tree, item => item.type === fakeRoot).props.onRootContextMenu(event, otherRoot); await runner.settle(commit);
    const pull = find(runner.tree, item => item.props.children === '拉取最新代码');
    assert.equal(pull.props.disabled, false); pull.props.onClick();
    assert.equal(dispatched.at(-1).path, otherRoot);
    store.fileTreeVisible = false; runner.mount(() => Component({ isSidebarMode: false }), commit); await runner.settle(commit);
    assert.ok(find(runner.tree, item => item.type === fakeHost));
    assert.equal(find(runner.tree, item => item.type === fakeHost).props.visible, false);
    operations.finishGitOperation(token); runner.dispose();
  }],
  ['a retained controller refuses a replacement parent repository identity', async () => {
    const bar = createBar(); await bar.settle();
    bar.updateRepositoryStatus(root, repository(otherRoot)); await bar.settle();
    await bar.ref.current.startPull(); bar.ref.current.openPushDialog();
    assert.equal(bar.calls.pull, 0); assert.equal(find(bar.tree, item => item.type === 'PushDialog'), undefined);
    bar.dispose();
  }],
  ['operation results retain their repository snapshot after repository removal', async () => {
    const bar = createBar(); await bar.settle(); const task = bar.ref.current.startPull(); await bar.settle();
    bar.updateRepositoryStatus(root, null); await bar.settle();
    assert.equal(find(bar.tree, item => item.type === 'PullDialog').props.status.repoRoot, root);
    bar.pull.resolve({ command: 'git pull', output: 'saved output', updatedCommits: [] }); await task; await bar.settle();
    assert.equal(find(bar.tree, item => item.type === 'PullDialog').props.pullDialog.output, 'saved output');
    assert.equal(bar.operations.getGitOperation(root), null); bar.dispose();
  }],
  ['host retains repository controllers across subdirectories, hide, SSH, and other repos', async () => {
    const runner = hooks(), cache = new Map(), handles = new Map(), dispatched = [], alerts = [];
    const fakeBar = () => null;
    cache.set(root, { status: repository(root) }); cache.set(`${root}\\src`, cache.get(root));
    cache.set(otherRoot, { status: repository(otherRoot) });
    let props = { currentDirectory: root, visible: true, onRepositoryChanged() {} };
    const ref = { current: null };
    const Host = load('src/components/git/GitOperationsHost.tsx', {
      react: runner.react, 'react/jsx-runtime': jsx, 'lucide-react': {},
      '../../services/gitStatusCache': { getCachedGitRepositoryStatus: path => cache.get(path), subscribeGitRepositoryStatus: () => () => {}, loadGitRepositoryStatus: async () => null },
      '../../services/gitOperationState': operationModule(),
      '../../services/dialog': { showAlert: async message => { alerts.push(message); } },
      './GitNavBar': { GitNavBar: fakeBar },
    }).GitOperationsHost;
    function commit(tree) {
      for (const item of elements(tree, element => element.type === fakeBar)) {
        if (!handles.has(item.key)) handles.set(item.key, {
          startPull: async () => { dispatched.push(item.props.currentDirectory); },
          loadHistory: async () => { dispatched.push(item.props.currentDirectory); },
        });
        item.props.ref(handles.get(item.key));
      }
    }
    runner.mount(() => Host(props, ref), commit); await runner.settle(commit);
    const firstKey = elements(runner.tree, item => item.type === fakeBar)[0].key;
    // Dispatch to a cached repository whose controller has never mounted.
    ref.current.runAction(otherRoot, 'history'); await runner.settle(commit);
    assert.equal(dispatched.at(-1), otherRoot); assert.equal(dispatched.length, 1);
    for (const next of [
      { currentDirectory: `${root}\\src` }, { visible: false },
      { currentDirectory: '', visible: false }, { currentDirectory: otherRoot, visible: true },
    ]) {
      props = { ...props, ...next }; runner.mount(() => Host(props, ref), commit); await runner.settle(commit);
      assert.ok(elements(runner.tree, item => item.type === fakeBar).some(item => item.key === firstKey));
    }
    ref.current.runAction(root, 'pull'); assert.equal(dispatched.at(-1), root);
    assert.equal(elements(runner.tree, item => item.type === fakeBar).length, 2);
    assert.equal(alerts.length, 0);
    cache.delete(root); ref.current.runAction(root, 'pull'); assert.equal(alerts.length, 1);
    runner.dispose();
  }],
];

for (const [label, run] of tests) {
  await run(); console.log(`PASS ${label}`);
}
console.log(`\n${tests.length} Git operation regression checks passed.`);
