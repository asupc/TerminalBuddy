import * as tauriService from '../services/tauri';
import { readClientData, writeClientData } from '../services/tauri';
import { getVSCodeStyleTerminalSuggestions } from './terminalSuggestions';

export interface CommandItem {
  name: string;
  command: string;
  desc: string;
}

export interface CommandTemplate {
  category: string;
  commands: CommandItem[];
}

export interface CmdOverride {
  desc?: string;
  hidden?: boolean;
}

let _cachedOverrides: Record<string, CmdOverride> | null = null;

export function getCmdOverrides(): Record<string, CmdOverride> {
  return _cachedOverrides || {};
}

export const initCmdOverrides = async (): Promise<void> => {
  try {
    const raw = await readClientData('cmd_overrides');
    if (raw) _cachedOverrides = JSON.parse(raw);
  } catch {}
};

export function saveCmdOverrides(overrides: Record<string, CmdOverride>) {
  _cachedOverrides = overrides;
  writeClientData('cmd_overrides', JSON.stringify(overrides)).catch(() => {});
  invalidateSuggestionsCache();
}

let _cachedCustomCommands: CommandItem[] | null = null;

export function getCustomCommands(): CommandItem[] {
  return _cachedCustomCommands || [];
}

export const initCustomCommands = async (): Promise<void> => {
  try {
    const raw = await readClientData('cmd_custom');
    if (raw) _cachedCustomCommands = JSON.parse(raw);
  } catch {}
};

export function saveCustomCommands(cmds: CommandItem[]) {
  _cachedCustomCommands = cmds;
  writeClientData('cmd_custom', JSON.stringify(cmds)).catch(() => {});
  invalidateSuggestionsCache();
}

export function getEffectiveTemplates(): CommandTemplate[] {
  const overrides = getCmdOverrides();
  const result: CommandTemplate[] = [];

  for (const cat of COMMAND_TEMPLATES) {
    const cmds = cat.commands
      .map(c => {
        const o = overrides[c.command.trim()];
        if (o?.hidden) return null;
        return {
          ...c,
          desc: o?.desc !== undefined ? o.desc : c.desc,
        };
      })
      .filter(Boolean) as CommandItem[];

    if (cmds.length > 0) {
      result.push({ category: cat.category, commands: cmds });
    }
  }

  const custom = getCustomCommands();
  if (custom.length > 0) {
    result.push({ category: '自定义', commands: custom });
  }

  return result;
}

export interface SuggestionItem {
  command: string;
  desc: string;
  kind?: 'command' | 'subcommand' | 'option' | 'argument' | 'template';
  source?: string;
}

const BUILTIN_COMMAND_SUGGESTIONS: SuggestionItem[] = [
  { command: 'claude --dangerously-skip-permissions', desc: 'Claude Code 跳过权限确认启动' },
  { command: 'git clean -fd', desc: '删除未跟踪的文件和目录(不可恢复)' },
  { command: 'git reset --hard HEAD', desc: '丢弃已跟踪文件的未提交变更(不可恢复)' },
];

let suggestionsCache: SuggestionItem[] | null = null;
let suggestionsDirty = true;

export function invalidateSuggestionsCache() {
  suggestionsDirty = true;
  suggestionsCache = null;
}

export function getAllSuggestions(): SuggestionItem[] {
  if (!suggestionsDirty && suggestionsCache) return suggestionsCache;

  const tplMap = new Map<string, SuggestionItem>();

  for (const suggestion of BUILTIN_COMMAND_SUGGESTIONS) {
    tplMap.set(suggestion.command, suggestion);
  }

  for (const cat of getEffectiveTemplates()) {
    for (const c of cat.commands) {
      const key = c.command.trim();
      if (!tplMap.has(key)) {
        tplMap.set(key, { command: key, desc: c.desc });
      }
    }
  }

  const result: SuggestionItem[] = [...tplMap.values()];

  suggestionsCache = result;
  suggestionsDirty = false;
  return result;
}

// 子序列模糊匹配：query 的每个字符按顺序出现在 text 中即可命中（如 ns 匹配 netstat）
const isSubsequence = (query: string, text: string): boolean => {
  let index = 0;
  for (const ch of text) {
    if (ch === query[index]) {
      index += 1;
      if (index === query.length) return true;
    }
  }
  return false;
};

export function getTerminalSuggestions(input: string): SuggestionItem[] {
  const query = input.trimStart().toLowerCase();
  if (!query) return [];

  const ranked = new Map<string, { item: SuggestionItem; score: number; order: number }>();
  let order = 0;

  const add = (item: SuggestionItem, score: number) => {
    const key = item.command.trim();
    const existing = ranked.get(key);
    if (!existing || score < existing.score) {
      ranked.set(key, { item, score, order: existing?.order ?? order++ });
    }
  };

  for (const suggestion of getVSCodeStyleTerminalSuggestions(input)) {
    add(suggestion, 0);
  }

  for (const suggestion of getAllSuggestions()) {
    const command = suggestion.command.toLowerCase();
    const desc = suggestion.desc.toLowerCase();
    if (command === query) continue;
    // 命令与说明均支持子序列模糊匹配；命令命中（10）优先于说明命中（30）
    if (isSubsequence(query, command)) {
      add({ ...suggestion, kind: suggestion.kind ?? 'template' }, 10);
    } else if (isSubsequence(query, desc)) {
      add({ ...suggestion, kind: suggestion.kind ?? 'template' }, 30);
    }
  }

  return [...ranked.values()]
    .sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      if (a.item.command.length !== b.item.command.length) {
        return a.item.command.length - b.item.command.length;
      }
      return a.order - b.order;
    })
    .map(({ item }) => item);
}

export async function initPersistedTemplates(): Promise<void> {
  const defaultContent = JSON.stringify(COMMAND_TEMPLATES, null, 2);
  const isNew = await tauriService.initCommandTemplates(defaultContent);
  if (!isNew) {
    try {
      const content = await tauriService.getCommandTemplates();
      const persisted: CommandTemplate[] = JSON.parse(content);
      if (persisted.length > 0) {
        COMMAND_TEMPLATES.length = 0;
        persisted.forEach(t => COMMAND_TEMPLATES.push(t));
      }
    } catch {}
  }
  invalidateSuggestionsCache();
}

export const COMMAND_TEMPLATES: CommandTemplate[] = [
  {
    category: '网络与端口',
    commands: [
      { name: 'netstat -ano', command: 'netstat -ano', desc: '查看所有端口占用和PID' },
      { name: 'netstat -ano | findstr', command: 'netstat -ano | findstr ', desc: '查找指定端口占用' },
      { name: 'taskkill /PID /F', command: 'taskkill /PID  /F', desc: '强制终止指定进程' },
      { name: 'taskkill /IM /F', command: 'taskkill /IM  /F', desc: '按进程名强制终止' },
      { name: 'tasklist', command: 'tasklist', desc: '列出所有运行进程' },
      { name: 'tasklist | findstr', command: 'tasklist | findstr ', desc: '查找指定进程' },
      { name: 'ping', command: 'ping ', desc: '测试网络连通性' },
      { name: 'tracert', command: 'tracert ', desc: '跟踪路由路径' },
      { name: 'nslookup', command: 'nslookup ', desc: 'DNS查询' },
      { name: 'ipconfig /all', command: 'ipconfig /all', desc: '查看完整网络配置' },
      { name: 'ipconfig /flushdns', command: 'ipconfig /flushdns', desc: '清除DNS缓存' },
      { name: 'netsh advfirewall', command: 'netsh advfirewall ', desc: '管理防火墙规则' },
      { name: 'net use', command: 'net use ', desc: '管理网络驱动器映射' },
      { name: 'net user', command: 'net user ', desc: '管理用户账户' },
      { name: 'net share', command: 'net share', desc: '查看共享资源' },
      { name: 'arp -a', command: 'arp -a', desc: '查看ARP缓存表' },
      { name: 'pathping', command: 'pathping ', desc: '网络路径诊断' },
    ],
  },
  {
    category: '进程与服务',
    commands: [
      { name: 'sc query', command: 'sc query ', desc: '查询Windows服务状态' },
      { name: 'sc start', command: 'sc start ', desc: '启动服务' },
      { name: 'sc stop', command: 'sc stop ', desc: '停止服务' },
      { name: 'sc config', command: 'sc config ', desc: '修改服务配置' },
      { name: 'Get-Service', command: 'Get-Service', desc: 'PowerShell查询服务' },
      { name: 'Get-Process', command: 'Get-Process', desc: 'PowerShell查询进程' },
      { name: 'Stop-Process', command: 'Stop-Process -Id  -Force', desc: 'PowerShell终止进程' },
      { name: 'Start-Service', command: 'Start-Service ', desc: 'PowerShell启动服务' },
      { name: 'Restart-Service', command: 'Restart-Service ', desc: 'PowerShell重启服务' },
      { name: 'wmic process', command: 'wmic process get name,processid', desc: 'WMI查询进程详情' },
      { name: 'wmic product', command: 'wmic product get name', desc: 'WMI查询已安装软件' },
    ],
  },
  {
    category: '文件与目录',
    commands: [
      { name: 'dir /s', command: 'dir /s', desc: '递归列出文件' },
      { name: 'dir /s /b', command: 'dir /s /b ', desc: '递归列出文件(仅路径)' },
      { name: 'cd /d', command: 'cd /d ', desc: '切换驱动器和目录' },
      { name: 'mkdir', command: 'mkdir ', desc: '创建目录' },
      { name: 'rmdir /s /q', command: 'rmdir /s /q ', desc: '递归强制删除目录' },
      { name: 'robocopy', command: 'robocopy ', desc: '高级文件复制工具' },
      { name: 'xcopy', command: 'xcopy ', desc: '复制文件和目录树' },
      { name: 'del /f /s /q', command: 'del /f /s /q ', desc: '强制递归删除文件' },
      { name: 'move', command: 'move ', desc: '移动/重命名文件' },
      { name: 'rename', command: 'rename ', desc: '重命名文件' },
      { name: 'type', command: 'type ', desc: '显示文件内容' },
      { name: 'findstr', command: 'findstr ', desc: '在文件中搜索文本' },
      { name: 'findstr /s /i', command: 'findstr /s /i ', desc: '递归搜索(忽略大小写)' },
      { name: 'fc', command: 'fc ', desc: '比较两个文件' },
      { name: 'attrib', command: 'attrib ', desc: '查看/修改文件属性' },
      { name: 'icacls', command: 'icacls ', desc: '管理文件权限(ACL)' },
      { name: 'takeown', command: 'takeown /f ', desc: '获取文件所有权' },
      { name: 'where', command: 'where ', desc: '查找可执行文件路径' },
      { name: 'tree', command: 'tree /f', desc: '以树形结构显示目录' },
      { name: 'forfiles', command: 'forfiles /p ', desc: '批量处理文件' },
    ],
  },
  {
    category: '系统管理',
    commands: [
      { name: 'systeminfo', command: 'systeminfo', desc: '查看系统详细信息' },
      { name: 'hostname', command: 'hostname', desc: '查看计算机名' },
      { name: 'whoami', command: 'whoami', desc: '查看当前用户' },
      { name: 'whoami /all', command: 'whoami /all', desc: '查看用户全部信息' },
      { name: 'set', command: 'set', desc: '查看环境变量' },
      { name: 'setx', command: 'setx ', desc: '永久设置环境变量' },
      { name: 'echo %PATH%', command: 'echo %PATH%', desc: '查看PATH变量' },
      { name: 'schtasks', command: 'schtasks /query', desc: '管理计划任务' },
      { name: 'shutdown /r /t 0', command: 'shutdown /r /t 0', desc: '立即重启' },
      { name: 'shutdown /s /t 0', command: 'shutdown /s /t 0', desc: '立即关机' },
      { name: 'sfc /scannow', command: 'sfc /scannow', desc: '扫描修复系统文件' },
      { name: 'chkdsk /f', command: 'chkdsk /f ', desc: '检查修复磁盘' },
      { name: 'diskpart', command: 'diskpart', desc: '磁盘分区管理' },
      { name: 'wmic logicaldisk', command: 'wmic logicaldisk get caption,freespace,size', desc: '查看磁盘空间' },
      { name: 'driverquery', command: 'driverquery', desc: '列出已安装驱动' },
      { name: 'reg query', command: 'reg query ', desc: '查询注册表' },
      { name: 'msinfo32', command: 'msinfo32', desc: '打开系统信息' },
      { name: 'eventvwr', command: 'eventvwr', desc: '打开事件查看器' },
      { name: 'compmgmt', command: 'compmgmt', desc: '打开计算机管理' },
      { name: 'taskschd.msc', command: 'taskschd.msc', desc: '打开任务计划程序' },
      { name: 'services.msc', command: 'services.msc', desc: '打开服务管理器' },
      { name: 'devmgmt.msc', command: 'devmgmt.msc', desc: '打开设备管理器' },
      { name: 'diskmgmt.msc', command: 'diskmgmt.msc', desc: '打开磁盘管理' },
      { name: 'certmgr.msc', command: 'certmgr.msc', desc: '打开证书管理器' },
      { name: 'gpedit.msc', command: 'gpedit.msc', desc: '打开组策略编辑器' },
      { name: 'regedit', command: 'regedit', desc: '打开注册表编辑器' },
    ],
  },
  {
    category: 'PowerShell',
    commands: [
      { name: 'Get-ChildItem', command: 'Get-ChildItem', desc: '列出目录内容(ls/dir)' },
      { name: 'Set-Location', command: 'Set-Location ', desc: '切换目录(cd)' },
      { name: 'Get-Content', command: 'Get-Content ', desc: '读取文件内容(cat)' },
      { name: 'Select-String', command: 'Select-String -Pattern ', desc: '搜索文本(grep)' },
      { name: 'Test-Connection', command: 'Test-Connection ', desc: '测试网络连通(ping)' },
      { name: 'Invoke-WebRequest', command: 'Invoke-WebRequest ', desc: 'HTTP请求(curl)' },
      { name: 'ConvertTo-Json', command: 'ConvertTo-Json', desc: '输出为JSON格式' },
      { name: 'Get-WmiObject', command: 'Get-WmiObject ', desc: '查询WMI信息' },
      { name: 'Get-EventLog', command: 'Get-EventLog -Newest 20', desc: '查看事件日志' },
      { name: 'Set-ExecutionPolicy', command: 'Set-ExecutionPolicy RemoteSigned', desc: '设置脚本执行策略' },
      { name: 'Get-Help', command: 'Get-Help ', desc: '查看命令帮助' },
      { name: 'Out-File', command: 'Out-File ', desc: '输出到文件' },
      { name: 'Export-Csv', command: 'Export-Csv ', desc: '导出为CSV' },
      { name: 'Get-Member', command: 'Get-Member', desc: '查看对象属性和方法' },
      { name: 'Where-Object', command: 'Where-Object {  }', desc: '过滤对象(Where)' },
      { name: 'ForEach-Object', command: 'ForEach-Object {  }', desc: '遍历对象(Foreach)' },
      { name: 'Measure-Object', command: 'Measure-Object', desc: '统计计算' },
      { name: 'Sort-Object', command: 'Sort-Object ', desc: '排序' },
      { name: 'Get-History', command: 'Get-History', desc: '查看命令历史' },
      { name: 'Invoke-History', command: 'Invoke-History ', desc: '执行历史命令' },
    ],
  },
  {
    category: 'Git',
    commands: [
      { name: 'git status', command: 'git status', desc: '查看工作区状态' },
      { name: 'git add .', command: 'git add .', desc: '暂存所有变更' },
      { name: 'git commit -m', command: 'git commit -m ', desc: '提交暂存变更' },
      { name: 'git pull', command: 'git pull', desc: '拉取远程更新' },
      { name: 'git push', command: 'git push', desc: '推送到远程仓库' },
      { name: 'git push -u origin', command: 'git push -u origin ', desc: '推送并设置上游' },
      { name: 'git clone', command: 'git clone ', desc: '克隆远程仓库' },
      { name: 'git checkout', command: 'git checkout ', desc: '切换分支' },
      { name: 'git checkout -b', command: 'git checkout -b ', desc: '创建并切换分支' },
      { name: 'git branch', command: 'git branch', desc: '列出分支' },
      { name: 'git branch -a', command: 'git branch -a', desc: '列出所有分支(含远程)' },
      { name: 'git merge', command: 'git merge ', desc: '合并分支' },
      { name: 'git rebase', command: 'git rebase ', desc: '变基' },
      { name: 'git log --oneline', command: 'git log --oneline -20', desc: '查看最近提交历史' },
      { name: 'git log --graph', command: 'git log --oneline --graph --all', desc: '图形化提交历史' },
      { name: 'git diff', command: 'git diff', desc: '查看未暂存变更' },
      { name: 'git diff --cached', command: 'git diff --cached', desc: '查看已暂存变更' },
      { name: 'git stash', command: 'git stash', desc: '暂存工作区' },
      { name: 'git stash pop', command: 'git stash pop', desc: '恢复暂存工作区' },
      { name: 'git reset --soft', command: 'git reset --soft HEAD~1', desc: '撤销上次提交(保留变更)' },
      { name: 'git reset --hard', command: 'git reset --hard HEAD~1', desc: '撤销上次提交(丢弃变更)' },
      { name: 'git clean -fd', command: 'git clean -fd', desc: '删除未跟踪的文件和目录(不可恢复)' },
      { name: 'git reset --hard HEAD', command: 'git reset --hard HEAD', desc: '丢弃已跟踪文件的未提交变更(不可恢复)' },
      { name: 'git fetch', command: 'git fetch --all', desc: '获取远程更新(不合并)' },
      { name: 'git remote -v', command: 'git remote -v', desc: '查看远程仓库地址' },
      { name: 'git tag', command: 'git tag ', desc: '创建标签' },
      { name: 'git cherry-pick', command: 'git cherry-pick ', desc: '挑选提交应用' },
      { name: 'git revert', command: 'git revert ', desc: '撤销指定提交' },
    ],
  },
  {
    category: 'AI 助手',
    commands: [
      { name: 'claude --dangerously-skip-permissions', command: 'claude --dangerously-skip-permissions', desc: 'Claude Code 跳过权限确认启动' },
    ],
  },
  {
    category: 'Node.js',
    commands: [
      { name: 'npm install', command: 'npm install', desc: '安装依赖' },
      { name: 'npm run dev', command: 'npm run dev', desc: '启动开发服务器' },
      { name: 'npm run build', command: 'npm run build', desc: '构建项目' },
      { name: 'npm run start', command: 'npm run start', desc: '启动项目' },
      { name: 'npm run test', command: 'npm run test', desc: '运行测试' },
      { name: 'npm run lint', command: 'npm run lint', desc: '代码检查' },
      { name: 'npm init -y', command: 'npm init -y', desc: '初始化项目' },
      { name: 'npm list', command: 'npm list --depth=0', desc: '查看已安装依赖' },
      { name: 'npm outdated', command: 'npm outdated', desc: '检查过期依赖' },
      { name: 'npm update', command: 'npm update', desc: '更新依赖' },
      { name: 'npm cache clean', command: 'npm cache clean --force', desc: '清除npm缓存' },
      { name: 'npx', command: 'npx ', desc: '执行npm包命令' },
      { name: 'yarn install', command: 'yarn install', desc: '安装依赖(yarn)' },
      { name: 'pnpm install', command: 'pnpm install', desc: '安装依赖(pnpm)' },
      { name: 'node -v', command: 'node -v', desc: '查看Node.js版本' },
      { name: 'npm -v', command: 'npm -v', desc: '查看npm版本' },
    ],
  },
  {
    category: 'Docker',
    commands: [
      { name: 'docker ps', command: 'docker ps', desc: '列出运行中容器' },
      { name: 'docker ps -a', command: 'docker ps -a', desc: '列出所有容器' },
      { name: 'docker images', command: 'docker images', desc: '列出镜像' },
      { name: 'docker build', command: 'docker build -t  .', desc: '构建镜像' },
      { name: 'docker run', command: 'docker run -d -p ', desc: '运行容器' },
      { name: 'docker stop', command: 'docker stop ', desc: '停止容器' },
      { name: 'docker rm', command: 'docker rm ', desc: '删除容器' },
      { name: 'docker rmi', command: 'docker rmi ', desc: '删除镜像' },
      { name: 'docker logs', command: 'docker logs ', desc: '查看容器日志' },
      { name: 'docker exec -it', command: 'docker exec -it ', desc: '进入容器终端' },
      { name: 'docker-compose up', command: 'docker-compose up -d', desc: '启动compose服务' },
      { name: 'docker-compose down', command: 'docker-compose down', desc: '停止compose服务' },
      { name: 'docker system prune', command: 'docker system prune -f', desc: '清理无用资源' },
    ],
  },
  {
    category: 'Python',
    commands: [
      { name: 'python --version', command: 'python --version', desc: '查看Python版本' },
      { name: 'pip install', command: 'pip install ', desc: '安装包' },
      { name: 'pip list', command: 'pip list', desc: '列出已安装包' },
      { name: 'pip freeze', command: 'pip freeze > requirements.txt', desc: '导出依赖列表' },
      { name: 'pip install -r', command: 'pip install -r requirements.txt', desc: '从文件安装依赖' },
      { name: 'python -m venv', command: 'python -m venv ', desc: '创建虚拟环境' },
      { name: 'conda activate', command: 'conda activate ', desc: '激活conda环境' },
      { name: 'python main.py', command: 'python main.py', desc: '运行Python脚本' },
    ],
  },
  {
    category: 'dotnet',
    commands: [
      { name: 'dotnet new', command: 'dotnet new console', desc: '创建新项目' },
      { name: 'dotnet build', command: 'dotnet build', desc: '构建项目' },
      { name: 'dotnet run', command: 'dotnet run', desc: '运行项目' },
      { name: 'dotnet test', command: 'dotnet test', desc: '运行测试' },
      { name: 'dotnet publish', command: 'dotnet publish -c Release', desc: '发布项目' },
      { name: 'dotnet add package', command: 'dotnet add package ', desc: '添加NuGet包' },
      { name: 'dotnet restore', command: 'dotnet restore', desc: '还原依赖' },
      { name: 'dotnet ef migrations', command: 'dotnet ef migrations add ', desc: '添加EF迁移' },
    ],
  },
];
