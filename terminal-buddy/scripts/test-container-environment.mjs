import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

function load(file, mocks) {
  const { outputText } = ts.transpileModule(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', outputText)(name => {
    assert.ok(name in mocks, `Unexpected dependency: ${name}`);
    return mocks[name];
  }, module, module.exports);
  return module.exports;
}

// 直接驱动组件的按钮和异步响应，用可控的请求顺序验证条目隔离与后台轮询。
function mount() {
  const hooks = [];
  const requests = [];
  const timers = new Map();
  let cursor = 0;
  let dirty = true;
  let active = true;
  let effects = [];
  let tree;
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial;
      return [hooks[index], value => { hooks[index] = typeof value === 'function' ? value(hooks[index]) : value; dirty = true; }];
    },
    useRef(initial) { return hooks[cursor++] ??= { current: initial }; },
    useCallback(fn, deps) {
      const index = cursor++;
      if (!same(hooks[index]?.deps, deps)) hooks[index] = { fn, deps };
      return hooks[index].fn;
    },
    useEffect(fn, deps) {
      const index = cursor++;
      if (!same(hooks[index]?.deps, deps)) {
        effects.push(() => { hooks[index]?.cleanup?.(); hooks[index] = { deps, cleanup: fn() }; });
      }
    },
  };
  const request = (kind, tool) => new Promise((resolve, reject) => requests.push({ kind, tool, resolve, reject }));
  const jsx = (type, props) => ({ type, props });
  const { ContainerEnvironmentSettings } = load('src/components/settings/ContainerEnvironmentSettings.tsx', {
    react,
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    'lucide-react': new Proxy({}, { get: (_, name) => name }),
    '../../services/browser/containerEnvironment': {
      getContainerEnvironment: () => request('environment'),
      getContainerCli: (tool, check = false) => request(check ? 'check' : 'status', tool),
      installContainerCli: tool => request('install', tool),
      updateContainerCli: tool => request('update', tool),
    },
    './ContainerEnvironmentSettings.css': {},
  });
  globalThis.window = {
    setInterval(callback) { const id = Symbol(); timers.set(id, callback); return id; },
    clearInterval(id) { timers.delete(id); },
  };
  function render() {
    for (let index = 0; dirty; index++) {
      assert.ok(index < 20, 'Unexpected render loop');
      dirty = false; cursor = 0; effects = [];
      tree = ContainerEnvironmentSettings({ active });
      effects.forEach(effect => effect());
    }
  }
  function text(node) {
    if (node == null || typeof node === 'boolean') return '';
    if (Array.isArray(node)) return node.map(text).join('');
    return typeof node === 'object' ? text(node.props?.children) : String(node);
  }
  function nodes(node) {
    if (!node || typeof node !== 'object') return [];
    return Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)];
  }
  function section(tool) {
    return nodes(tree).find(node => node.type === 'section' && node.props['aria-label'] === tool);
  }
  function button(tool) {
    const scope = tool ? section(tool) : tree;
    return nodes(scope).find(node => node.type === 'button');
  }
  function click(tool) {
    const element = button(tool);
    assert.ok(element, `Missing button: ${tool}`);
    assert.ok(!element.props.disabled, `Unexpected disabled button: ${tool}`);
    element.props.onClick(); render();
    return element;
  }
  async function settle(request, value, reject = false) {
    assert.ok(request, 'Missing request');
    (reject ? request.reject : request.resolve)(value);
    await new Promise(resolve => setImmediate(resolve));
    render();
  }
  render();
  return {
    requests, click, button, settle,
    text: tool => text(tool ? section(tool) : tree),
    poll() { assert.ok(timers.size, 'Missing background polling'); [...timers.values()].forEach(callback => callback()); render(); },
    deactivate() { active = false; dirty = true; render(); },
    timerCount: () => timers.size,
  };
}

const installed = version => ({ status: 'installed', version, message: null, update: null, updatedVersion: null });
const available = latestVersion => ({ latestVersion, state: 'available', message: null });
const current = latestVersion => ({ latestVersion, state: 'upToDate', message: null });
const base = { claude: installed('2.1.301'), codex: installed('0.162.0') };
const previousWindow = globalThis.window;
try {
  const ui = mount();
  await ui.settle(ui.requests[0], base);
  assert.ok(ui.text('Claude Code').includes('当前版本：2.1.301'));
  assert.ok(ui.text('Codex CLI').includes('当前版本：0.162.0'));
  const firstCheck = ui.click('Claude Code');
  firstCheck.props.onClick();
  assert.equal(ui.requests.length, 2, 'Double clicks must not start a second check');
  assert.equal(ui.requests[1].kind, 'check');
  assert.equal(ui.requests[1].tool, 'claude');
  assert.ok(!ui.button('Codex CLI').props.disabled, 'A check must not block the other tool');
  ui.click('Codex CLI');
  await ui.settle(ui.requests[2], new Error('网络不可用'), true);
  assert.ok(ui.text('Codex CLI').includes('检查更新失败：网络不可用'));
  const claude = { ...base.claude, update: available('2.1.302') };
  await ui.settle(ui.requests[1], claude);
  assert.equal(ui.button('Claude Code').props.children.at(-1), '更新');
  assert.ok(!ui.text('Claude Code').includes('网络不可用'));
  ui.click('Codex CLI');
  const codex = { ...base.codex, update: available('0.163.0') };
  await ui.settle(ui.requests[3], codex);

  ui.click(); // 故意让整体重新检测的旧响应晚于更新启动返回。
  const staleRefresh = ui.requests[4];
  ui.click('Claude Code');
  assert.equal(ui.requests[5].kind, 'update');
  assert.equal(ui.requests[5].tool, 'claude');
  ui.click('Codex CLI');
  assert.equal(ui.requests[6].tool, 'codex');
  const claudeRunning = { ...claude, status: 'updating' };
  const codexRunning = { ...codex, status: 'updating' };
  await ui.settle(ui.requests[5], claudeRunning);
  await ui.settle(ui.requests[6], codexRunning);
  await ui.settle(staleRefresh, base);
  assert.ok(ui.text('Claude Code').includes('正在更新…'));
  assert.ok(ui.text('Codex CLI').includes('正在更新…'));
  assert.ok(ui.text('Claude Code').includes('当前版本：2.1.301'));
  assert.ok(ui.button('Claude Code').props.disabled);

  ui.deactivate();
  ui.poll();
  const claudeDone = { ...installed('2.1.302'), update: current('2.1.302'), updatedVersion: '2.1.302' };
  await ui.settle(ui.requests[7], { claude: claudeDone, codex: codexRunning });
  assert.ok(ui.text('Claude Code').includes('当前版本：2.1.302'));
  assert.ok(ui.text('Claude Code').includes('更新成功，当前版本 2.1.302'));
  assert.equal(ui.button('Claude Code').props.children.at(-1), '检查更新');
  assert.ok(ui.button('Codex CLI').props.disabled, 'The other update must remain running');
  ui.poll();
  await ui.settle(ui.requests[8], { claude: claudeDone, codex: { ...codex, message: '更新失败：下载失败' } });
  assert.ok(ui.text('Codex CLI').includes('当前版本：0.162.0'));
  assert.ok(ui.text('Codex CLI').includes('更新失败：下载失败'));
  assert.ok(!ui.text('Codex CLI').includes('更新成功'));
  assert.equal(ui.button('Codex CLI').props.children.at(-1), '更新');
  ui.click('Codex CLI');
  assert.ok(!ui.text('Codex CLI').includes('更新失败'));
  const codexDone = { ...installed('0.163.0'), update: current('0.163.0'), updatedVersion: '0.163.0' };
  await ui.settle(ui.requests[9], codexDone);
  assert.ok(ui.text('Codex CLI').includes('更新成功，当前版本 0.163.0'));
  assert.equal(ui.timerCount(), 0, 'Polling must stop after both operations complete');

  const installUi = mount();
  await installUi.settle(installUi.requests[0], { claude: { ...installed(null), status: 'notInstalled' }, codex: base.codex });
  installUi.click('Claude Code');
  assert.equal(installUi.requests[1].kind, 'install');
  await installUi.settle(installUi.requests[1], { ...installed(null), status: 'installing' });
  installUi.poll();
  await installUi.settle(installUi.requests[2], { claude: installed('2.1.302'), codex: base.codex });
  assert.ok(installUi.text('Claude Code').includes('当前版本：2.1.302'));
  assert.equal(installUi.button('Claude Code').props.children.at(-1), '检查更新');

  const calls = [];
  const api = load('src/services/browser/containerEnvironment.ts', {
    './connection': { request: (path, init) => { calls.push({ path, method: init?.method ?? 'GET' }); return Promise.resolve({}); } },
  });
  await api.getContainerCli('claude', true);
  await api.getContainerCli('codex', true);
  await api.updateContainerCli('claude');
  await api.installContainerCli('codex');
  assert.deepEqual(calls, [
    { path: '/api/container/environment/claude?checkUpdates=true', method: 'GET' },
    { path: '/api/container/environment/codex?checkUpdates=true', method: 'GET' },
    { path: '/api/container/environment/claude/update', method: 'POST' },
    { path: '/api/container/environment/codex/install', method: 'POST' },
  ]);
  console.log('PASS: 按条目检查与更新、并行操作、重复点击防护、旧响应隔离、后台轮询、成功显示实际版本、失败重试与初次安装');
} finally {
  if (previousWindow === undefined) delete globalThis.window;
  else globalThis.window = previousWindow;
}
