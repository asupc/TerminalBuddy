import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
function load(file, mocks, globals = {}) {
  const source = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', ...Object.keys(globals), outputText)(
    (name) => mocks[name] || require(name),
    module,
    module.exports,
    ...Object.values(globals),
  );
  return module.exports;
}
let profiles, projects, created, deleted, saveCalls, failUpdate, failSave;
const api = {
  createProfile: async (name, group, terminalType) => ({
    id: 'new-id',
    name,
    group,
    terminalType,
    createdAt: 'new-date',
    startupCommands: [],
  }),
  updateProfile: async (profile) => {
    if (profile.id === failUpdate) {
      failUpdate = null;
      throw new Error('保存配置失败');
    }
    profiles = profiles.filter((p) => p.id !== profile.id).concat(structuredClone(profile));
    created = profile;
  },
  deleteProfile: async (id) => {
    deleted.push(id);
  },
  saveProjects: async (value) => {
    saveCalls++;
    if (failSave) throw new Error('保存项目失败');
    projects = structuredClone(value);
  },
};
function reset() {
  profiles = [];
  projects = [];
  deleted = [];
  created = undefined;
  saveCalls = 0;
  failUpdate = null;
  failSave = false;
}
const utils = load('web/src/utils/projects.ts', { '../api': { api } });
const project = { name: '旧项目', path: 'C:\\Work', startupCommand: 'claude' };
assert.equal(
  utils.effectiveProfilePath({ group: project.name, startupPath: '' }, [project]),
  project.path,
);
assert.equal(
  utils.effectiveProfilePath({ group: project.name, startupPath: 'subdir' }, [project]),
  'C:\\Work/subdir',
);
assert.equal(
  utils.effectiveProfilePath({ group: project.name, startupPath: '/other' }, [project]),
  '/other',
);
assert.equal(utils.normalizePath('/Workspace/A/../B/', false), '/Workspace/B');
assert.equal(utils.normalizePath('C:\\Work\\A\\..', true), 'c:/work');
assert.equal(utils.normalizePath('/', false), '/');
assert.notEqual(utils.normalizePath('/Workspace', false), utils.normalizePath('/workspace', false));
const presets = [
  { id: 'all' },
  { id: 'match', commandMatch: 'CLAUDE' },
  { id: 'other', commandMatch: 'npm' },
  { id: 'disabled', enabled: false },
];
assert.deepEqual(
  utils.matchingPresets(presets, ['claude --verbose']).map((p) => p.id),
  ['all', 'match'],
);
assert.deepEqual(
  utils.matchingPresets(presets, []).map((p) => p.id),
  ['all'],
);
assert.equal(
  utils.modelCommand('provider', 'model', [
    'echo before',
    'claude --dangerously-skip-permissions --model old --settings="file path" --effort high --verbose; echo after',
  ]),
  '__TB_CLAUDE_REF__:provider:model --dangerously-skip-permissions --verbose',
);
assert.equal(
  utils.modelCommand('provider', 'model', ['claude.cmd --resume session']),
  '__TB_CLAUDE_REF__:provider:model --resume session',
);
reset();
const source = {
  id: 'old-id',
  name: 'SSH 副本',
  group: project.name,
  terminalType: 'ssh',
  sshPassword: 'test-only',
  sshKeyPath: '/test/key',
  dockerContainerId: 'container-id',
  tabColor: '#123456',
  windowSize: { width: 90, height: 30 },
  startupCommands: ['echo test'],
  environmentVariables: { TEST: 'value' },
  createdAt: 'old-date',
  lastUsedAt: 'old-use',
};
await utils.createProfileFrom(source);
assert.equal(created.id, 'new-id');
assert.equal(created.createdAt, 'new-date');
assert.equal(created.lastUsedAt, null);
for (const field of [
  'sshPassword',
  'sshKeyPath',
  'dockerContainerId',
  'tabColor',
  'windowSize',
  'startupCommands',
  'environmentVariables',
])
  assert.deepEqual(created[field], source[field]);
failUpdate = 'new-id';
await assert.rejects(utils.createProfileFrom(source), /保存配置失败/);
assert.deepEqual(deleted, ['new-id']);
console.log('PASS: 路径继承、预设筛选、模型参数与配置复制字段保留及失败清理');

reset();
profiles = [
  { ...source, id: 'inherited', startupPath: 'c:/work/', group: project.name },
  { ...source, id: 'relative', startupPath: 'subdir', group: project.name },
  { ...source, id: 'override', startupPath: 'D:\\Other', group: project.name },
  { ...source, id: 'unrelated', startupPath: 'C:\\Work', group: '其他项目' },
];
const originalProfiles = structuredClone(profiles);
const nextProject = { ...project, name: '新项目', path: 'D:\\New' };
await utils.saveProject(nextProject, project, [project], originalProfiles, true);
assert.deepEqual(projects, [nextProject]);
assert.equal(profiles.find((p) => p.id === 'inherited').startupPath, '');
assert.equal(profiles.find((p) => p.id === 'relative').startupPath, 'subdir');
assert.equal(profiles.find((p) => p.id === 'override').startupPath, 'D:\\Other');
assert.equal(profiles.find((p) => p.id === 'unrelated').group, '其他项目');
for (const p of profiles.filter((p) => p.id !== 'unrelated')) {
  assert.equal(p.group, '新项目');
  assert.equal(p.sshPassword, source.sshPassword);
}
profiles = structuredClone(originalProfiles);
projects = [project];
failUpdate = 'relative';
await assert.rejects(
  utils.saveProject(nextProject, project, [project], originalProfiles, true),
  /保存配置失败/,
);
assert.deepEqual(projects, [project]);
assert.deepEqual(
  [...profiles].sort((a, b) => a.id.localeCompare(b.id)),
  [...originalProfiles].sort((a, b) => a.id.localeCompare(b.id)),
);
reset();
failSave = true;
await assert.rejects(
  utils.saveProject(nextProject, project, [project], originalProfiles, true),
  /保存项目失败/,
);
assert.equal(saveCalls, 1, '项目未保存成功时不再写入旧数据');
console.log('PASS: 项目改名、继承路径迁移、显式目录保留与中途失败回退');

let effects = [],
  timers = new Map(),
  nextTimer = 0,
  opened = [];
const hook = load(
  'web/src/hooks/useLongPressMenu.ts',
  { react: { useRef: (value) => ({ current: value }), useEffect: (fn) => effects.push(fn()) } },
  {
    setTimeout: (fn) => {
      timers.set(++nextTimer, fn);
      return nextTimer;
    },
    clearTimeout: (id) => timers.delete(id),
  },
);
const bind = hook.useLongPressMenu((...args) => opened.push(args));
const props = bind('profile');
const pointer = (extra = {}) => ({
  isPrimary: true,
  pointerType: 'touch',
  pointerId: 1,
  clientX: 30,
  clientY: 40,
  target: { closest: () => null },
  ...extra,
});
const fireTimers = () => {
  const callbacks = [...timers.values()];
  timers.clear();
  callbacks.forEach((fn) => fn());
};
const click = () => {
  let blocked = false;
  props.onClickCapture({
    preventDefault: () => {
      blocked = true;
    },
    stopPropagation() {},
  });
  return blocked;
};
props.onPointerDown(pointer());
fireTimers();
props.onPointerUp();
assert.deepEqual(opened, [['profile', 30, 40]]);
assert.equal(click(), true, '长按松手后的 click 不启动终端');
props.onPointerDown(pointer());
props.onPointerUp();
fireTimers();
assert.equal(opened.length, 1);
assert.equal(click(), false, '下一次短按仍可正常启动');
props.onPointerDown(pointer());
props.onPointerMove(pointer({ clientY: 80 }));
fireTimers();
props.onPointerUp();
assert.equal(opened.length, 1);
assert.equal(click(), true, '滚动手势不会误启动');
props.onPointerDown(pointer());
props.onPointerCancel();
fireTimers();
assert.equal(opened.length, 1);
props.onPointerDown(pointer({ target: { closest: () => ({ tagName: 'BUTTON' }) } }));
fireTimers();
assert.equal(opened.length, 1, '属性展开/更多按钮不会触发父行长按');
props.onPointerDown(pointer({ pointerType: 'mouse' }));
fireTimers();
assert.equal(opened.length, 1);
props.onContextMenu({ clientX: 50, clientY: 60, preventDefault() {}, stopPropagation() {} });
assert.deepEqual(opened.at(-1), ['profile', 50, 60]);
props.onPointerDown(pointer());
effects.forEach((fn) => fn?.());
fireTimers();
assert.equal(opened.length, 2, '卸载清理长按定时器');
console.log('PASS: 长按/右键、松手点击抑制、短按、滚动、取消、嵌套按钮及卸载清理');
