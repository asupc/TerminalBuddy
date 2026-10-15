// 在个人服务的隔离工作区执行真实 HTTP/WebSocket 验证，不连接外部主机。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const option = name => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const base = new URL(option('--url') ?? 'http://127.0.0.1:9610');
assert(['127.0.0.1', 'localhost'].includes(base.hostname), '验证脚本仅允许本机隔离服务');
const workspace = await fs.realpath(option('--workspace') ?? path.resolve('server-data/preview-workspace'));
const comparablePath = value => {
  const normalized = path.resolve(value.startsWith('\\\\?\\') ? value.slice(4) : value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};
const passwordFile = option('--password-file') ?? path.resolve('server-data/preview-password.txt');
const username = option('--username') ?? 'admin';
const keepTerminal = process.argv.includes('--keep-terminal');
let token = '';
let terminalId;
let profileId;
let socket;
const suffix = crypto.randomUUID();
const filePath = path.join(workspace, `web-smoke-${suffix}.txt`);
const renamed = path.join(workspace, `web-smoke-${suffix}-renamed.txt`);

async function http(route, args, authenticated = true) {
  return fetch(new URL(route, base), {
    method: args === undefined ? 'GET' : 'POST',
    headers: { ...(args === undefined ? {} : { 'content-type': 'application/json' }), ...(authenticated && token ? { authorization: `Bearer ${token}` } : {}) },
    ...(args === undefined ? {} : { body: JSON.stringify(args) }),
  });
}
async function invoke(command, args = {}) {
  const response = await http(`/api/desktop/invoke/${command}`, args);
  const body = await response.json();
  assert(response.ok, `${command} 失败：${body?.message ?? response.status}`);
  if (body && typeof body === 'object' && '$jobId' in body) {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 200));
      const poll = await (await http(`/api/desktop/jobs/${body.$jobId}`)).json();
      if (poll.status === 'done') return poll.value;
      assert.notEqual(poll.status, 'failed', poll.message);
    }
    throw new Error('后台任务超时');
  }
  return body;
}

try {
  assert.equal((await http('/api/desktop/invoke/get_projects', {}, false)).status, 401);
  const login = await http('/api/auth/login', { username, password: (await fs.readFile(passwordFile, 'utf8')).trimEnd() }, false);
  assert(login.ok, '登录失败'); token = (await login.json()).token;
  const runtime = await (await http('/api/runtime')).json(); assert.equal(runtime.mode, 'server');
  const projects = await invoke('get_projects');
  assert(projects.some(project => comparablePath(project.path) === comparablePath(workspace)), '必须使用已登记的隔离工作区');

  await invoke('write_file_content', { path: filePath, content: '真实网页文件编辑验证\n' });
  assert.equal(await invoke('read_file_content', { path: filePath }), '真实网页文件编辑验证\n');
  assert.equal((await http('/api/desktop/invoke/rename_path', { path: filePath, newName: '../escape.txt' })).status, 400);
  await invoke('rename_path', { path: filePath, newName: path.basename(renamed) });
  assert.equal(await invoke('read_file_content', { path: renamed }), '真实网页文件编辑验证\n');
  assert.equal((await http('/api/desktop/invoke/read_file_content', { path: path.join(workspace, '..', 'outside.txt') })).status, 403);
  assert(await invoke('get_git_repository_status', { path: workspace }), '隔离工作区需先执行 git init');
  await invoke('delete_path', { path: renamed });

  const profile = await invoke('create_profile', { name: `加密验证-${suffix}`, group: '服务器工作区', terminalType: 'ssh' });
  profileId = profile.id;
  const secret = crypto.randomBytes(20).toString('hex');
  await invoke('update_profile', { profile: { ...profile, sshHost: '127.0.0.1', sshUser: 'preview', sshAuthType: 'password', sshPassword: secret } });
  const dataDir = await invoke('get_data_path');
  const saved = await fs.readFile(path.join(dataDir, 'Profiles', `${profileId}.json`), 'utf8');
  assert(!saved.includes(secret), '密码不得以明文保存');
  assert(JSON.parse(saved).sshPassword.startsWith('aesgcm:v1:'), '服务端必须使用自己的密文格式');
  assert.equal((await invoke('get_profile', { id: profileId })).sshPassword, secret);
  await invoke('delete_profile', { id: profileId }); profileId = undefined;

  terminalId = await invoke('start_blank_terminal', { terminalType: runtime.defaultTerminalType, displayName: '网页实测终端', initialRows: 30, initialCols: 100, startupPath: workspace });
  const wsUrl = new URL(`/ws/terminal/${terminalId}`, base); wsUrl.protocol = 'ws:'; wsUrl.searchParams.set('token', token);
  const marker = `TB_WEB_READY_${suffix.replaceAll('-', '')}`;
  const command = runtime.platform === 'windows'
    ? `Write-Output ('${marker.slice(0, 8)}' + '${marker.slice(8)}')\r`
    : `printf '%s%s\\n' '${marker.slice(0, 8)}' '${marker.slice(8)}'\r`;
  await new Promise((resolve, reject) => {
    socket = new WebSocket(wsUrl);
    let output = '';
    const timeout = setTimeout(() => reject(new Error('真实终端输出超时')), 30_000);
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'resize', rows: 30, cols: 100 }));
      // 等待 shell 启动命令接管，避免将验证命令先写入基础 shell。
      setTimeout(() => socket.send(JSON.stringify({ type: 'input', data: command })), 1500);
    });
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.type === 'error') { clearTimeout(timeout); reject(new Error(message.message)); }
      if (message.type === 'output') {
        output += message.data;
        const plain = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
        if (plain.includes(marker)) { clearTimeout(timeout); resolve(); }
      }
    });
    socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('终端 WebSocket 连接失败')); });
  });
  socket.close();
  assert((await invoke('list_terminals')).some(terminal => terminal.id === terminalId && terminal.owner === 'web'));
  console.log('验证通过：登录认证、文件读写与重命名、目录范围限制、Git 状态、密码加密、真实终端输入输出。');
  if (keepTerminal) console.log(`已保留预览终端：${terminalId}`);
} finally {
  socket?.close();
  if (token && terminalId && !keepTerminal) await invoke('close_terminal', { id: terminalId }).catch(() => {});
  if (token && profileId) await invoke('delete_profile', { id: profileId }).catch(() => {});
  // 仅清理本脚本创建的两个随机文件。
  await fs.rm(filePath, { force: true }); await fs.rm(renamed, { force: true });
}
