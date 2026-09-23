import type { SuggestionItem } from './commandTemplates';

type SuggestionKind = NonNullable<SuggestionItem['kind']>;

type SuggestOption = {
  name: string | string[];
  desc: string;
};

type SuggestNode = {
  name: string | string[];
  desc: string;
  kind?: SuggestionKind;
  options?: SuggestOption[];
  subcommands?: SuggestNode[];
};

type TerminalSpec = SuggestNode & {
  name: string | string[];
};

const option = (name: string | string[], desc: string): SuggestOption => ({ name, desc });
const node = (name: string | string[], desc: string, subcommands?: SuggestNode[], options?: SuggestOption[], kind?: SuggestionKind): SuggestNode => ({
  name,
  desc,
  subcommands,
  options,
  kind,
});

const VS_CODE_STYLE_SPECS: TerminalSpec[] = [
  {
    name: 'claude',
    desc: 'Claude Code CLI',
    options: [
      option('--dangerously-skip-permissions', '跳过权限确认启动'),
      option('--continue', '继续最近的会话'),
      option('--resume', '恢复指定会话'),
      option('--print', '打印模式输出结果'),
      option(['-h', '--help'], '显示帮助'),
      option(['-v', '--version'], '显示版本'),
    ],
  },
  {
    name: 'git',
    desc: 'Git 版本控制',
    subcommands: [
      node('add', '添加文件到暂存区', undefined, [
        option(['-A', '--all'], '暂存所有变更'),
        option(['-p', '--patch'], '交互式选择变更块'),
      ]),
      node('branch', '列出、创建或删除分支', undefined, [
        option(['-a', '--all'], '显示本地和远程分支'),
        option(['-d', '--delete'], '删除已合并分支'),
        option(['-D'], '强制删除分支'),
        option(['-m', '--move'], '重命名分支'),
      ]),
      node('checkout', '切换分支或恢复文件', undefined, [
        option(['-b'], '创建并切换新分支'),
        option(['-B'], '重置创建并切换分支'),
        option(['--track'], '跟踪远程分支'),
        option(['--detach'], '分离 HEAD'),
      ]),
      node('clone', '克隆远程仓库', undefined, [
        option(['--depth'], '浅克隆深度'),
        option(['--branch', '-b'], '指定分支'),
        option(['--recurse-submodules'], '递归克隆子模块'),
      ]),
      node('commit', '提交暂存变更', undefined, [
        option(['-m', '--message'], '提交信息'),
        option(['-a', '--all'], '自动暂存已跟踪文件'),
        option(['--amend'], '修改上一次提交'),
        option(['--no-verify'], '跳过 hook'),
      ]),
      node('diff', '查看差异', undefined, [
        option(['--cached', '--staged'], '查看暂存区差异'),
        option(['--stat'], '显示统计摘要'),
        option(['--name-only'], '只显示文件名'),
      ]),
      node('fetch', '获取远程更新', undefined, [
        option(['--all'], '获取所有远程'),
        option(['--prune'], '清理已删除远程引用'),
        option(['--tags'], '获取标签'),
      ]),
      node('log', '查看提交历史', undefined, [
        option(['--oneline'], '单行显示'),
        option(['--graph'], '图形化显示'),
        option(['--all'], '显示所有引用'),
        option(['--decorate'], '显示引用名称'),
      ]),
      node('merge', '合并分支', undefined, [
        option(['--no-ff'], '禁用 fast-forward'),
        option(['--abort'], '终止合并'),
        option(['--continue'], '继续合并'),
      ]),
      node('pull', '拉取并合并远程更新', undefined, [
        option(['--rebase'], '使用 rebase'),
        option(['--ff-only'], '仅允许 fast-forward'),
        option(['--autostash'], '自动 stash 本地变更'),
      ]),
      node('push', '推送到远程', undefined, [
        option(['-u', '--set-upstream'], '设置上游分支'),
        option(['--force-with-lease'], '安全强推'),
        option(['--tags'], '推送标签'),
      ]),
      node('rebase', '变基', undefined, [
        option(['-i', '--interactive'], '交互式 rebase'),
        option(['--continue'], '继续 rebase'),
        option(['--abort'], '终止 rebase'),
      ]),
      node('remote', '管理远程仓库', [
        node('add', '添加远程'),
        node('remove', '删除远程'),
        node('rename', '重命名远程'),
        node('set-url', '设置远程地址'),
        node('-v', '显示远程地址', undefined, undefined, 'option'),
      ]),
      node('reset', '重置 HEAD', undefined, [
        option(['--soft'], '保留工作区和暂存区'),
        option(['--mixed'], '保留工作区'),
        option(['--hard'], '丢弃工作区变更'),
      ]),
      node('restore', '恢复工作区文件', undefined, [
        option(['--staged'], '从暂存区移除'),
        option(['--source'], '指定来源'),
      ]),
      node('stash', '临时保存工作区', [
        node('push', '保存当前工作区'),
        node('pop', '应用并删除最近 stash'),
        node('apply', '应用 stash'),
        node('list', '列出 stash'),
        node('drop', '删除 stash'),
      ]),
      node('status', '查看工作区状态', undefined, [
        option(['-s', '--short'], '短格式'),
        option(['-b', '--branch'], '显示分支信息'),
      ]),
      node('switch', '切换分支', undefined, [
        option(['-c', '--create'], '创建并切换分支'),
        option(['--detach'], '分离 HEAD'),
      ]),
      node('tag', '管理标签', undefined, [
        option(['-a', '--annotate'], '创建附注标签'),
        option(['-d', '--delete'], '删除标签'),
        option(['-l', '--list'], '列出标签'),
      ]),
      node('worktree', '管理多个工作树', [
        node('add', '新增 worktree'),
        node('list', '列出 worktree'),
        node('remove', '移除 worktree'),
        node('prune', '清理无效 worktree'),
      ]),
    ],
    options: [
      option(['-C'], '在指定目录运行 Git'),
      option(['--no-pager'], '禁用分页器'),
      option(['--version'], '显示版本'),
      option(['--help'], '显示帮助'),
    ],
  },
  {
    name: 'npm',
    desc: 'Node.js 包管理器',
    subcommands: [
      node(['install', 'i'], '安装依赖', undefined, [
        option(['-D', '--save-dev'], '保存为开发依赖'),
        option(['-g', '--global'], '全局安装'),
        option(['--force'], '强制安装'),
        option(['--legacy-peer-deps'], '忽略 peer 依赖冲突'),
      ]),
      node('run', '运行 package.json 脚本', [
        node('dev', '运行 dev 脚本', undefined, undefined, 'argument'),
        node('build', '运行 build 脚本', undefined, undefined, 'argument'),
        node('test', '运行 test 脚本', undefined, undefined, 'argument'),
        node('start', '运行 start 脚本', undefined, undefined, 'argument'),
        node('lint', '运行 lint 脚本', undefined, undefined, 'argument'),
        node('preview', '运行 preview 脚本', undefined, undefined, 'argument'),
      ]),
      node('init', '初始化 package.json', undefined, [option(['-y', '--yes'], '使用默认值')]),
      node('exec', '执行 npm 包命令'),
      node('list', '列出依赖', undefined, [option(['--depth=0'], '只显示顶层依赖')]),
      node('outdated', '检查过期依赖'),
      node('update', '更新依赖'),
      node('cache', '管理缓存', [node('clean', '清理缓存')]),
      node('publish', '发布包', undefined, [option(['--dry-run'], '试运行')]),
      node('version', '修改版本号'),
    ],
    options: [
      option(['-v', '--version'], '显示版本'),
      option(['-h', '--help'], '显示帮助'),
    ],
  },
  {
    name: 'npx',
    desc: '执行 npm 包',
    options: [
      option(['-y', '--yes'], '自动确认安装'),
      option(['--package'], '指定要安装的包'),
      option(['--no-install'], '不自动安装缺失包'),
    ],
  },
  {
    name: 'pnpm',
    desc: '快速包管理器',
    subcommands: [
      node(['install', 'i'], '安装依赖'),
      node('add', '添加依赖', undefined, [option(['-D', '--save-dev'], '保存为开发依赖')]),
      node('run', '运行脚本', [
        node('dev', '运行 dev 脚本', undefined, undefined, 'argument'),
        node('build', '运行 build 脚本', undefined, undefined, 'argument'),
        node('test', '运行 test 脚本', undefined, undefined, 'argument'),
        node('start', '运行 start 脚本', undefined, undefined, 'argument'),
      ]),
      node('remove', '移除依赖'),
      node('update', '更新依赖'),
      node('dlx', '下载并执行包'),
    ],
  },
  {
    name: 'yarn',
    desc: 'Yarn 包管理器',
    subcommands: [
      node('install', '安装依赖'),
      node('add', '添加依赖', undefined, [option(['-D', '--dev'], '保存为开发依赖')]),
      node('run', '运行脚本', [
        node('dev', '运行 dev 脚本', undefined, undefined, 'argument'),
        node('build', '运行 build 脚本', undefined, undefined, 'argument'),
        node('test', '运行 test 脚本', undefined, undefined, 'argument'),
      ]),
      node('remove', '移除依赖'),
      node('upgrade', '升级依赖'),
    ],
  },
  {
    name: 'code',
    desc: 'Visual Studio Code CLI',
    options: [
      option(['-d', '--diff'], '比较两个文件'),
      option(['-m', '--merge'], '三方合并'),
      option(['-a', '--add'], '添加文件夹到当前窗口'),
      option(['-g', '--goto'], '打开文件并跳转到行列'),
      option(['-n', '--new-window'], '打开新窗口'),
      option(['-r', '--reuse-window'], '复用已有窗口'),
      option(['-w', '--wait'], '等待文件关闭'),
      option(['--locale'], '设置界面语言'),
      option(['--user-data-dir'], '指定用户数据目录'),
      option(['--profile'], '使用指定配置文件'),
      option(['--list-extensions'], '列出已安装扩展'),
      option(['--install-extension'], '安装扩展'),
      option(['--uninstall-extension'], '卸载扩展'),
      option(['--add-mcp'], '添加 MCP 服务器定义'),
      option(['--locate-shell-integration-path'], '输出 shell integration 脚本路径'),
      option(['-h', '--help'], '显示帮助'),
      option(['-v', '--version'], '显示版本'),
    ],
  },
  {
    name: 'docker',
    desc: 'Docker CLI',
    subcommands: [
      node('build', '构建镜像', undefined, [option(['-t', '--tag'], '镜像标签'), option(['--no-cache'], '禁用缓存')]),
      node('compose', 'Docker Compose', [
        node('up', '启动服务', undefined, [option(['-d', '--detach'], '后台运行'), option(['--build'], '启动前构建')]),
        node('down', '停止并删除服务'),
        node('logs', '查看服务日志', undefined, [option(['-f', '--follow'], '持续输出')]),
        node('ps', '列出服务容器'),
        node('exec', '在服务容器中执行命令'),
        node('build', '构建服务镜像'),
      ]),
      node('exec', '在容器中执行命令', undefined, [option(['-it'], '交互式 TTY')]),
      node('images', '列出镜像'),
      node('logs', '查看容器日志', undefined, [option(['-f', '--follow'], '持续输出'), option(['--tail'], '显示尾部行数')]),
      node('ps', '列出容器', undefined, [option(['-a', '--all'], '显示所有容器')]),
      node('pull', '拉取镜像'),
      node('push', '推送镜像'),
      node('run', '运行容器', undefined, [option(['-d', '--detach'], '后台运行'), option(['-p', '--publish'], '端口映射'), option(['--name'], '容器名称'), option(['--rm'], '退出后删除容器')]),
      node('stop', '停止容器'),
      node('rm', '删除容器', undefined, [option(['-f', '--force'], '强制删除')]),
      node('rmi', '删除镜像'),
      node('system', '系统管理', [node('prune', '清理无用资源')]),
    ],
    options: [
      option(['--help'], '显示帮助'),
      option(['--version'], '显示版本'),
    ],
  },
  {
    name: 'dotnet',
    desc: '.NET CLI',
    subcommands: [
      node('new', '创建项目', [node('console', '控制台项目', undefined, undefined, 'argument'), node('webapi', 'Web API 项目', undefined, undefined, 'argument'), node('classlib', '类库项目', undefined, undefined, 'argument')]),
      node('build', '构建项目'),
      node('run', '运行项目'),
      node('test', '运行测试'),
      node('publish', '发布项目', undefined, [option(['-c', '--configuration'], '构建配置')]),
      node('restore', '还原依赖'),
      node('add', '添加引用或包', [node('package', '添加 NuGet 包'), node('reference', '添加项目引用')]),
      node('ef', 'Entity Framework 工具', [node('migrations', '管理迁移'), node('database', '管理数据库')]),
    ],
  },
  {
    name: ['python', 'python3', 'py'],
    desc: 'Python',
    subcommands: [
      node('-m', '运行模块', [
        node('venv', '创建虚拟环境', undefined, undefined, 'argument'),
        node('pip', '运行 pip', undefined, undefined, 'argument'),
        node('http.server', '启动简单 HTTP 服务', undefined, undefined, 'argument'),
      ], undefined, 'option'),
    ],
    options: [
      option(['--version', '-V'], '显示版本'),
      option(['-m'], '以模块方式运行'),
    ],
  },
  {
    name: 'pip',
    desc: 'Python 包管理器',
    subcommands: [
      node('install', '安装包', undefined, [option(['-r', '--requirement'], '从 requirements 文件安装'), option(['-U', '--upgrade'], '升级包')]),
      node('list', '列出已安装包'),
      node('freeze', '输出依赖锁定列表'),
      node('uninstall', '卸载包'),
      node('show', '显示包信息'),
    ],
  },
];

const normalizeName = (name: string | string[]) => Array.isArray(name) ? name : [name];

function parseInput(input: string) {
  const normalized = input.trimStart();
  const endsWithSpace = /\s$/.test(normalized);
  const tokens = normalized.length > 0 ? normalized.split(/\s+/) : [];
  return {
    normalized,
    tokens,
    currentToken: endsWithSpace ? '' : tokens[tokens.length - 1] ?? '',
    completedTokens: endsWithSpace ? tokens : tokens.slice(0, -1),
  };
}

function findSpec(rootToken: string): { spec: TerminalSpec; rootName: string } | null {
  const lower = rootToken.toLowerCase();
  for (const spec of VS_CODE_STYLE_SPECS) {
    for (const name of normalizeName(spec.name)) {
      if (name.toLowerCase() === lower) {
        return { spec, rootName: name };
      }
    }
  }
  return null;
}

function resolveNode(spec: TerminalSpec, pathTokens: string[]): SuggestNode {
  let current: SuggestNode = spec;
  for (const token of pathTokens) {
    const next = current.subcommands?.find(candidate =>
      normalizeName(candidate.name).some(name => name.toLowerCase() === token.toLowerCase())
    );
    if (!next) break;
    current = next;
  }
  return current;
}

function addSuggestion(
  result: Map<string, SuggestionItem>,
  command: string,
  desc: string,
  kind: SuggestionKind,
): void {
  if (!result.has(command)) {
    result.set(command, { command, desc, kind, source: 'VS Code terminal-suggest' });
  }
}

function addNamedSuggestions(
  result: Map<string, SuggestionItem>,
  prefix: string,
  currentToken: string,
  items: (SuggestNode | SuggestOption)[] | undefined,
  fallbackKind: SuggestionKind,
): void {
  const query = currentToken.toLowerCase();
  for (const item of items ?? []) {
    for (const name of normalizeName(item.name)) {
      if (query && !name.toLowerCase().startsWith(query)) continue;
      const kind = 'kind' in item && item.kind ? item.kind : fallbackKind;
      addSuggestion(result, `${prefix}${name}`, item.desc, kind);
    }
  }
}

export function getVSCodeStyleTerminalSuggestions(input: string): SuggestionItem[] {
  const parsed = parseInput(input);
  if (!parsed.normalized) return [];

  const result = new Map<string, SuggestionItem>();

  if (parsed.completedTokens.length === 0) {
    const query = parsed.currentToken.toLowerCase();
    const exactRoot = findSpec(parsed.currentToken);
    if (exactRoot) {
      const prefix = `${parsed.currentToken} `;
      addNamedSuggestions(result, prefix, '', exactRoot.spec.subcommands, 'subcommand');
      addNamedSuggestions(result, prefix, '', exactRoot.spec.options, 'option');
      if (result.size > 0) return [...result.values()];
    }

    for (const spec of VS_CODE_STYLE_SPECS) {
      for (const name of normalizeName(spec.name)) {
        if (query && !name.toLowerCase().startsWith(query)) continue;
        if (name.toLowerCase() === query) continue;
        addSuggestion(result, name, spec.desc, 'command');
      }
    }
    return [...result.values()];
  }

  const root = findSpec(parsed.completedTokens[0]);
  if (!root) return [];

  const pathTokens = parsed.completedTokens.slice(1);
  const currentNode = resolveNode(root.spec, pathTokens);
  const prefix = `${parsed.completedTokens.join(' ')} `;
  const optionSources = currentNode === root.spec
    ? root.spec.options
    : [...(currentNode.options ?? []), ...(root.spec.options ?? [])];

  addNamedSuggestions(result, prefix, parsed.currentToken, currentNode.subcommands, 'subcommand');
  addNamedSuggestions(result, prefix, parsed.currentToken, optionSources, 'option');

  return [...result.values()];
}
