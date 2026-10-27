import type {
  Profile,
  Project,
  ExtraParamPreset,
  ServerStats,
} from '../types';
import type {
  GitRepositoryStatus,
  GitCommit,
  GitHistoryRef,
  GitBranch,
} from '../services/tauri/git';
import type { FileNode } from '../services/tauri/fs';

// ==================== 1. 终端配置 (Profiles) ====================
export const MOCK_PROFILES: Profile[] = [
  {
    id: 'prof-vue-admin',
    name: 'Vue3 电商管理后台',
    group: '前端工程/商城业务',
    terminalType: 'powershell',
    startupPath: 'D:\\Projects\\shop-admin',
    startupCommands: ['pnpm run dev'],
    environmentVariables: { NODE_ENV: 'development', PORT: '5173' },
    colorTheme: 'dark-default',
    tabColor: '#3b82f6', // 蓝色
    windowSize: null,
    pinned: true,
    createdAt: '2026-08-01T08:00:00Z',
    lastUsedAt: '2026-10-09T09:30:00Z',
  },
  {
    id: 'prof-mobile-h5',
    name: '移动端 H5 聚合应用',
    group: '前端工程/商城业务',
    terminalType: 'pwsh',
    startupPath: 'D:\\Projects\\shop-mobile',
    startupCommands: ['pnpm run dev:h5'],
    environmentVariables: { VITE_APP_API: 'http://api.staging.internal' },
    colorTheme: 'dark-default',
    tabColor: '#10b981', // 绿色
    windowSize: null,
    createdAt: '2026-08-05T08:00:00Z',
    lastUsedAt: '2026-10-08T15:20:00Z',
  },
  {
    id: 'prof-spring-order',
    name: 'SpringCloud 订单中心',
    group: '后端架构/核心微服务',
    terminalType: 'cmd',
    startupPath: 'D:\\Backend\\order-service',
    startupCommands: ['mvn spring-boot:run -Dspring-boot.run.profiles=dev'],
    environmentVariables: { JAVA_HOME: 'C:\\Program Files\\Java\\jdk-21' },
    colorTheme: 'dark-default',
    tabColor: '#f59e0b', // 橙色
    windowSize: null,
    pinned: true,
    createdAt: '2026-08-10T08:00:00Z',
    lastUsedAt: '2026-10-09T08:45:00Z',
  },
  {
    id: 'prof-spring-gateway',
    name: 'API 网关服务 (Gateway)',
    group: '后端架构/核心微服务',
    terminalType: 'cmd',
    startupPath: 'D:\\Backend\\api-gateway',
    startupCommands: ['mvn spring-boot:run'],
    environmentVariables: {},
    colorTheme: 'dark-default',
    tabColor: '#eab308', // 黄色
    windowSize: null,
    createdAt: '2026-08-12T08:00:00Z',
    lastUsedAt: '2026-10-07T11:10:00Z',
  },
  {
    id: 'prof-centos-ssh',
    name: 'CentOS 7.9 生产跳板机',
    group: '运维集群/云服务器',
    terminalType: 'ssh',
    startupPath: '',
    startupCommands: ['htop'],
    environmentVariables: {},
    colorTheme: 'dark-default',
    tabColor: '#ec4899', // 粉色
    windowSize: null,
    sshHost: '192.168.10.250',
    sshPort: 22,
    sshUser: 'ops-admin',
    sshAuthType: 'key',
    sshKeyPath: '~/.ssh/id_rsa_prod',
    createdAt: '2026-08-15T08:00:00Z',
    lastUsedAt: '2026-10-09T09:15:00Z',
  },
  {
    id: 'prof-k8s-prod',
    name: 'K8s 生产集群 (Prod-East-01)',
    group: '运维集群/容器编排',
    terminalType: 'k8s',
    startupPath: '',
    startupCommands: ['kubectl get pods -n production -w'],
    environmentVariables: {},
    colorTheme: 'dark-default',
    tabColor: '#8b5cf6', // 紫色
    windowSize: null,
    k8sNamespace: 'production',
    k8sPodName: 'order-service-deployment-7b9d5c898b-94k2l',
    k8sContainerName: 'app',
    createdAt: '2026-08-18T08:00:00Z',
    lastUsedAt: '2026-10-08T18:00:00Z',
  },
  {
    id: 'prof-docker-redis',
    name: 'Redis Sentinel 主从节点',
    group: '运维集群/容器编排',
    terminalType: 'docker',
    startupPath: '',
    startupCommands: ['redis-cli info replication'],
    environmentVariables: {},
    colorTheme: 'dark-default',
    tabColor: '#06b6d4', // 青色
    windowSize: null,
    dockerContainerName: 'redis-master-cluster',
    dockerContainerId: '74cbf982a10d',
    createdAt: '2026-08-20T08:00:00Z',
    lastUsedAt: '2026-10-06T14:30:00Z',
  },
  {
    id: 'prof-mstsc-bastion',
    name: 'Windows Server 2022 运维机',
    group: '远程桌面/专线跳板',
    terminalType: 'mstsc',
    startupPath: '',
    startupCommands: [],
    environmentVariables: {},
    colorTheme: 'dark-default',
    tabColor: '#64748b', // 灰色
    windowSize: null,
    mstscHost: '10.200.1.50',
    mstscPort: 3389,
    mstscUser: 'Administrator',
    mstscResolution: '1920x1080',
    createdAt: '2026-08-22T08:00:00Z',
    lastUsedAt: '2026-09-30T10:00:00Z',
  },
];

// ==================== 2. 注册项目 (Projects) ====================
export const MOCK_PROJECTS: Project[] = [
  {
    name: 'Vue3 电商管理后台',
    path: 'D:\\Projects\\shop-admin',
  },
  {
    name: 'SpringCloud 订单中心',
    path: 'D:\\Backend\\order-service',
  },
  {
    name: 'TerminalBuddy',
    path: 'D:\\gitee\\TerminalBuddy',
    enabledAgents: { claude: true, codex: false, pi: true },
  },
];

// ==================== 3. 启动参数预设 (Extra Param Presets) ====================
export const MOCK_EXTRA_PARAM_PRESETS: ExtraParamPreset[] = [
  {
    id: 'preset-dev',
    name: '开发环境 (Dev)',
    params: '--mode development --port 3000',
    mode: 'append',
    commandMatch: 'pnpm|npm|yarn|vite',
    tagColor: '#10b981',
    enabled: true,
  },
  {
    id: 'preset-staging',
    name: '预发布测试 (Staging)',
    params: '--mode staging --mock=false',
    mode: 'append',
    commandMatch: 'pnpm|npm|yarn|vite',
    tagColor: '#3b82f6',
    enabled: true,
  },
  {
    id: 'preset-debug',
    name: '调试模式 (Debug)',
    params: '-Xdebug -Xrunjdwp:transport=dt_socket,server=y,suspend=n,address=5005',
    mode: 'append',
    commandMatch: 'mvn|java|spring-boot',
    tagColor: '#ef4444',
    enabled: true,
  },
  {
    id: 'preset-k8s-watch',
    name: '实时监控 (Watch)',
    params: '--watch -o wide',
    mode: 'append',
    commandMatch: 'kubectl',
    tagColor: '#8b5cf6',
    enabled: true,
  },
];

// ==================== 4. 终端 ANSI 彩色输出数据 ====================
export const MOCK_TERMINAL_OUTPUTS: Record<string, string> = {
  'term-vue-admin': [
    '\x1b[2J\x1b[H', // 清屏并定位到左上角
    '\x1b[38;2;100;149;237mWindows PowerShell v7.4.5 [x64] (ConPTY)\x1b[0m\r\n',
    '\x1b[38;2;128;128;128mCopyright (C) Microsoft Corporation. All rights reserved.\x1b[0m\r\n\r\n',
    '\x1b[38;2;220;220;170m   __ _                     _       _       \r\n',
    '  / _\\ |__   ___  _ __     /_\\   __| |_ __ ___ (_)_ __  \r\n',
    '  \\ \\| \'_ \\ / _ \\| \'_ \\   //_\\\\ / _` | \'_ ` _ \\| | \'_ \\ \r\n',
    '  _\\ \\ | | | (_) | |_) | /  _  \\ (_| | | | | | | | | | |\r\n',
    '  \\__/_| |_|\\___/| .__/  \\_/ \\_/\\__,_|_| |_| |_|_|_| |_|\r\n',
    '                 |_|                                    \x1b[0m\r\n',
    '\x1b[38;2;156;220;254m  Platform: \x1b[0mNode.js v20.18.0 | pnpm v9.12.1 | Vite v5.4.8\r\n',
    '\x1b[38;2;156;220;254m  Directory:\x1b[0m D:\\Projects\\shop-admin\r\n\r\n',
    '\x1b[32m➜\x1b[0m  \x1b[38;2;86;156;214mshop-admin\x1b[0m \x1b[38;2;206;145;120mgit:(\x1b[38;2;78;201;176mmain\x1b[38;2;206;145;120m)\x1b[0m \x1b[33m✗\x1b[0m \x1b[38;2;220;220;170mpnpm run dev\x1b[0m\r\n\r\n',
    '  \x1b[38;2;78;201;176m▲\x1b[0m  \x1b[1;38;2;255;255;255mVITE v5.4.8\x1b[0m  \x1b[32mready in 340 ms\x1b[0m\r\n\r\n',
    '  \x1b[32m➜\x1b[0m  \x1b[1mLocal:\x1b[0m   \x1b[36mhttp://localhost:\x1b[1;36m5173\x1b[0m\x1b[36m/\x1b[0m\r\n',
    '  \x1b[32m➜\x1b[0m  \x1b[1mNetwork:\x1b[0m \x1b[36mhttp://192.168.10.88:\x1b[1;36m5173\x1b[0m\x1b[36m/\x1b[0m\r\n',
    '  \x1b[38;2;128;128;128m➜  press \x1b[1mh + enter\x1b[0m\x1b[38;2;128;128;128m to show help\x1b[0m\r\n\r\n',
    '\x1b[38;2;78;201;176m[HMR]\x1b[0m \x1b[38;2;128;128;128mWebSocket connected successfully.\x1b[0m\r\n',
    '\x1b[32m✓\x1b[0m \x1b[38;2;156;220;254msrc/views/dashboard/Analysis.vue\x1b[0m \x1b[38;2;128;128;128mhot updated in 12ms\x1b[0m\r\n',
    '\x1b[32m✓\x1b[0m \x1b[38;2;156;220;254msrc/store/modules/order.ts\x1b[0m \x1b[38;2;128;128;128mhot updated in 8ms\x1b[0m\r\n\r\n',
    '\x1b[32m➜\x1b[0m  \x1b[38;2;86;156;214mshop-admin\x1b[0m \x1b[38;2;206;145;120mgit:(\x1b[38;2;78;201;176mmain\x1b[38;2;206;145;120m)\x1b[0m \x1b[32m✔\x1b[0m ',
  ].join(''),

  'term-centos-ssh': [
    '\x1b[2J\x1b[H',
    '\x1b[38;2;156;220;254mConnecting to ops-admin@192.168.10.250:22...\x1b[0m\r\n',
    '\x1b[32mAuthenticated using key ~/.ssh/id_rsa_prod\x1b[0m\r\n',
    'Last login: Thu Oct  9 09:12:04 2026 from 192.168.10.88\r\n\r\n',
    '\x1b[38;2;220;220;170m   ___           _   ____   _____ \x1b[0m   \x1b[1mOS:\x1b[0m CentOS Linux 7.9.2009 (Core) x86_64\r\n',
    '\x1b[38;2;220;220;170m  / __|___ _ _ _| |_/ _ \\ / ____|\x1b[0m   \x1b[1mHost:\x1b[0m VMware Virtual Platform (1.0)\r\n',
    '\x1b[38;2;220;220;170m | (__/ -_) \' \\  _| (_) | \\___ \\ \x1b[0m   \x1b[1mKernel:\x1b[0m 5.4.241-1.el7.elrepo.x86_64\r\n',
    '\x1b[38;2;220;220;170m  \\___\\___|_||_\\__|\\___/| |____/ \x1b[0m   \x1b[1mUptime:\x1b[0m 142 days, 18 hours, 32 mins\r\n',
    '                                 \x1b[1mPackages:\x1b[0m 1420 (rpm)\r\n',
    '                                 \x1b[1mMemory:\x1b[0m 8.24 GiB / 16.00 GiB (51%)\r\n',
    '                                 \x1b[1mCPU:\x1b[0m Intel Xeon Gold 6248R (8 cores) @ 3.00GHz\r\n\r\n',
    ' \x1b[41m  \x1b[42m  \x1b[43m  \x1b[44m  \x1b[45m  \x1b[46m  \x1b[47m  \x1b[0m\r\n\r\n',
    '\x1b[32m[ops-admin@prod-bastion-01 ~]$\x1b[0m \x1b[38;2;220;220;170mdocker ps --format "table {{.Names}}\\t{{.Status}}\\t{{.Ports}}"\x1b[0m\r\n',
    'NAMES                    STATUS                  PORTS\r\n',
    '\x1b[36mnginx-ingress-gateway\x1b[0m    \x1b[32mUp 42 days (healthy)\x1b[0m    0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp\r\n',
    '\x1b[36mredis-sentinel-master\x1b[0m    \x1b[32mUp 98 days\x1b[0m              0.0.0.0:6379->6379/tcp, 26379/tcp\r\n',
    '\x1b[36morder-service-app\x1b[0m        \x1b[32mUp 6 hours\x1b[0m               0.0.0.0:8080->8080/tcp\r\n',
    '\x1b[36mprometheus-node-exporter\x1b[0m \x1b[32mUp 142 days\x1b[0m             0.0.0.0:9100->9100/tcp\r\n\r\n',
    '\x1b[32m[ops-admin@prod-bastion-01 ~]$\x1b[0m ',
  ].join(''),

  'term-k8s-prod': [
    '\x1b[2J\x1b[H',
    '\x1b[38;2;156;220;254mSwitched to context: prod-east-01 | namespace: production\x1b[0m\r\n\r\n',
    '\x1b[35m$ \x1b[0m\x1b[38;2;220;220;170mkubectl get pods -n production -o wide\x1b[0m\r\n',
    'NAME                                       READY   STATUS    RESTARTS   AGE    IP             NODE\r\n',
    '\x1b[36morder-service-7b9d5c898b-94k2l\x1b[0m             1/1     \x1b[32mRunning\x1b[0m   0          4d2h   10.244.2.145   k8s-worker-02\r\n',
    '\x1b[36morder-service-7b9d5c898b-w49pm\x1b[0m             1/1     \x1b[32mRunning\x1b[0m   0          4d2h   10.244.3.92    k8s-worker-03\r\n',
    '\x1b[36mpayment-gateway-698f9d454-g71xb\x1b[0m            1/1     \x1b[32mRunning\x1b[0m   0          18d    10.244.1.88    k8s-worker-01\r\n',
    '\x1b[36muser-auth-service-58dc7f6b98-5zrq2\x1b[0m         1/1     \x1b[32mRunning\x1b[0m   1 (9d ago) 28d    10.244.3.11    k8s-worker-03\r\n',
    '\x1b[36mproduct-catalog-849cfd547f-8m3x1\x1b[0m           1/1     \x1b[32mRunning\x1b[0m   0          12d    10.244.2.204   k8s-worker-02\r\n\r\n',
    '\x1b[35m$ \x1b[0m\x1b[38;2;220;220;170mkubectl top nodes\x1b[0m\r\n',
    'NAME            CPU(cores)   CPU%   MEMORY(bytes)   MEMORY%   \r\n',
    'k8s-master-01   380m         9%     4210Mi          26%       \r\n',
    'k8s-worker-01   1840m        46%    9820Mi          61%       \r\n',
    'k8s-worker-02   2150m        53%    11420Mi         71%       \r\n',
    'k8s-worker-03   1420m        35%    8740Mi          54%       \r\n\r\n',
    '\x1b[35m$ \x1b[0m',
  ].join(''),

  'term-spring-order': [
    '\x1b[2J\x1b[H',
    'Microsoft Windows [Version 10.0.26200.5050]\r\n(c) Microsoft Corporation. All rights reserved.\r\n\r\n',
    'D:\\Backend\\order-service> mvn spring-boot:run\r\n',
    '\x1b[38;2;128;128;128m[INFO] Scanning for projects...\x1b[0m\r\n',
    '\x1b[38;2;78;201;176m  .   ____          _            __ _ _\r\n',
    ' /\\\\ / ___ \'_ __ _ _(_)_ __  __ _ \\ \\ \\ \\\r\n',
    '( ( )\\___ | \'_ | \'_| | \'_ \\/ _` | \\ \\ \\ \\\r\n',
    ' \\\\/  ___)| |_)| | | | | || (_| |  ) ) ) )\r\n',
    '  \'  |____| .__|_| |_|_| |_\\__, | / / / /\r\n',
    ' =========|_|==============|___/=/_/_/_/\x1b[0m\r\n',
    '\x1b[38;2;86;156;214m :: Spring Boot ::        (v3.3.4)\x1b[0m\r\n\r\n',
    '2026-10-09T09:30:12.102+08:00  \x1b[32mINFO\x1b[0m 31408 --- [order-service] [main] \x1b[36mc.e.order.OrderServiceApplication\x1b[0m : Starting OrderServiceApplication using Java 21\r\n',
    '2026-10-09T09:30:13.418+08:00  \x1b[32mINFO\x1b[0m 31408 --- [order-service] [main] \x1b[36mo.s.b.w.e.tomcat.TomcatWebServer\x1b[0m : Tomcat initialized with port 8080 (http)\r\n',
    '2026-10-09T09:30:14.220+08:00  \x1b[32mINFO\x1b[0m 31408 --- [order-service] [main] \x1b[36mc.e.order.OrderServiceApplication\x1b[0m : Started OrderServiceApplication in 2.385 seconds\r\n',
    '2026-10-09T09:30:15.001+08:00  \x1b[32mINFO\x1b[0m 31408 --- [order-service] [main] \x1b[32mNacos Service registered: [order-service:192.168.10.88:8080] group: DEFAULT_GROUP\x1b[0m\r\n',
  ].join(''),
};

// ==================== 5. 工程文件树 (File Tree) ====================
export const MOCK_FILE_NODES: Record<string, FileNode[]> = {
  'D:\\Projects\\shop-admin': [
    { name: '.git', path: 'D:\\Projects\\shop-admin\\.git', is_directory: true, size: 0, lastModified: Date.now() },
    { name: 'public', path: 'D:\\Projects\\shop-admin\\public', is_directory: true, size: 0, lastModified: Date.now() },
    { name: 'src', path: 'D:\\Projects\\shop-admin\\src', is_directory: true, size: 0, lastModified: Date.now() },
    { name: '.env.development', path: 'D:\\Projects\\shop-admin\\.env.development', is_directory: false, size: 240, lastModified: Date.now() },
    { name: 'package.json', path: 'D:\\Projects\\shop-admin\\package.json', is_directory: false, size: 1850, lastModified: Date.now() },
    { name: 'pnpm-lock.yaml', path: 'D:\\Projects\\shop-admin\\pnpm-lock.yaml', is_directory: false, size: 98400, lastModified: Date.now() },
    { name: 'README.md', path: 'D:\\Projects\\shop-admin\\README.md', is_directory: false, size: 3420, lastModified: Date.now() },
    { name: 'tsconfig.json', path: 'D:\\Projects\\shop-admin\\tsconfig.json', is_directory: false, size: 680, lastModified: Date.now() },
    { name: 'vite.config.ts', path: 'D:\\Projects\\shop-admin\\vite.config.ts', is_directory: false, size: 1120, lastModified: Date.now() },
  ],
  'D:\\Projects\\shop-admin\\src': [
    { name: 'api', path: 'D:\\Projects\\shop-admin\\src\\api', is_directory: true, size: 0, lastModified: Date.now() },
    { name: 'assets', path: 'D:\\Projects\\shop-admin\\src\\assets', is_directory: true, size: 0, lastModified: Date.now() },
    { name: 'components', path: 'D:\\Projects\\shop-admin\\src\\components', is_directory: true, size: 0, lastModified: Date.now() },
    { name: 'router', path: 'D:\\Projects\\shop-admin\\src\\router', is_directory: true, size: 0, lastModified: Date.now() },
    { name: 'store', path: 'D:\\Projects\\shop-admin\\src\\store', is_directory: true, size: 0, lastModified: Date.now() },
    { name: 'views', path: 'D:\\Projects\\shop-admin\\src\\views', is_directory: true, size: 0, lastModified: Date.now() },
    { name: 'App.vue', path: 'D:\\Projects\\shop-admin\\src\\App.vue', is_directory: false, size: 1450, lastModified: Date.now() },
    { name: 'main.ts', path: 'D:\\Projects\\shop-admin\\src\\main.ts', is_directory: false, size: 840, lastModified: Date.now() },
  ],
};

// ==================== 6. 文件编辑内容 ====================
export const MOCK_FILE_CONTENTS: Record<string, string> = {
  'D:\\Projects\\shop-admin\\src\\App.vue': `<template>
  <el-config-provider :locale="zhCn">
    <router-view v-slot="{ Component }">
      <transition name="fade-transform" mode="out-in">
        <component :is="Component" />
      </transition>
    </router-view>
  </el-config-provider>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import { useUserStore } from '@/store/modules/user';

const userStore = useUserStore();

onMounted(async () => {
  if (userStore.token) {
    await userStore.getUserInfo();
  }
});
</script>

<style>
html, body, #app {
  margin: 0;
  padding: 0;
  width: 100%;
  height: 100%;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}
</style>`,

  'D:\\Projects\\shop-admin\\README.md': `# 🛍️ ShopAdmin 商城全渠道管理平台

基于 Vue 3 + TypeScript + Vite + Pinia + Element Plus 的现代化多端电商中台系统。

## ✨ 核心特性
- ⚡ **超快热更新**：Vite 5 驱动，毫秒级冷启动与 HMR
- 🔐 **完备权限体系**：RBAC 动态权限菜单、按钮级指令拦截
- 📊 **数据大屏与看板**：ECharts 5 响应式大屏联动、销售漏斗分析
- 🎨 **暗黑主题无缝适配**：一键切换亮暗色调与主题色定制
`,
};

// ==================== 7. Git 状态与提交历史图谱 ====================
export const MOCK_GIT_STATUS: GitRepositoryStatus = {
  repoRoot: 'D:\\Projects\\shop-admin',
  branch: 'main',
  upstream: 'origin/main',
  ahead: 2,
  behind: 0,
  changedCount: 3,
  stagedCount: 1,
  unstagedCount: 2,
  untrackedCount: 0,
  hasRemote: true,
};

const MOCK_REFS_HEAD: GitHistoryRef = {
  name: 'main',
  fullName: 'refs/heads/main',
  revision: '7f9a2e1',
  kind: 'head',
  isCurrent: true,
  isUpstream: false,
  isBase: false,
};

const MOCK_REFS_REMOTE: GitHistoryRef = {
  name: 'origin/main',
  fullName: 'refs/remotes/origin/main',
  revision: '3b81ca4',
  kind: 'remote',
  isCurrent: false,
  isUpstream: true,
  isBase: false,
};

export const MOCK_GIT_COMMITS: GitCommit[] = [
  {
    hash: '7f9a2e185c4900da1234567890abcdef12345678',
    shortHash: '7f9a2e1',
    parents: ['9c4f1d0'],
    refs: [MOCK_REFS_HEAD],
    author: 'huangmaoqiu <huang@dev.com>',
    date: '2026-10-09 09:15:20',
    subject: 'feat(order): 接入微信扫码支付与订单状态实时 Webhook 监听',
  },
  {
    hash: '9c4f1d061ab89201fedcba0987654321fedcba09',
    shortHash: '9c4f1d0',
    parents: ['3b81ca4', 'e12da89'],
    refs: [],
    author: 'huangmaoqiu <huang@dev.com>',
    date: '2026-10-08 17:30:10',
    subject: 'merge: 合并分支 feature/order-split 到 main',
  },
  {
    hash: 'e12da8954bf81203948576102938475610293847',
    shortHash: 'e12da89',
    parents: ['3b81ca4'],
    refs: [],
    author: 'zhangsan <zhang@dev.com>',
    date: '2026-10-08 15:45:00',
    subject: 'feat(split): 支持多仓库跨区拆单算法与库存锁定机制',
  },
  {
    hash: '3b81ca49081234ef01234567890abcdef12345678',
    shortHash: '3b81ca4',
    parents: ['8a7b6c5'],
    refs: [MOCK_REFS_REMOTE],
    author: 'huangmaoqiu <huang@dev.com>',
    date: '2026-10-07 14:20:00',
    subject: 'perf(dashboard): 接入虚拟列表滚动，大列表数据加载流畅度提升 80%',
  },
  {
    hash: '8a7b6c543210fedcba9876543210fedcba987654',
    shortHash: '8a7b6c5',
    parents: ['5d4c3b2'],
    refs: [],
    author: 'lisi <li@dev.com>',
    date: '2026-10-06 11:10:00',
    subject: 'fix(auth): 修复双因子登录认证令牌自动刷新时并发竞态 bug',
  },
  {
    hash: '5d4c3b2109876543210fedcba9876543210fedcb',
    shortHash: '5d4c3b2',
    parents: ['1a2b3c4'],
    refs: [],
    author: 'huangmaoqiu <huang@dev.com>',
    date: '2026-10-05 16:00:00',
    subject: 'chore(deps): 升级 Vite 5.4 与 TypeScript 5.6 编译构建工具链',
  },
];

export const MOCK_GIT_BRANCHES: GitBranch[] = [
  { name: 'main', isCurrent: true, isRemote: false, upstream: 'origin/main' },
  { name: 'feature/order-split', isCurrent: false, isRemote: false, upstream: null },
  { name: 'hotfix/v1.4.1', isCurrent: false, isRemote: false, upstream: null },
  { name: 'origin/main', isCurrent: false, isRemote: true, upstream: null },
];

export const MOCK_GIT_DIFF = `diff --git a/src/views/order/OrderList.vue b/src/views/order/OrderList.vue
index e83b12a..94cf21b 100644
--- a/src/views/order/OrderList.vue
+++ b/src/views/order/OrderList.vue
@@ -45,7 +45,9 @@
-  const handlePay = async (row: OrderItem) => {
-    await api.payOrder(row.id);
-    ElMessage.success('支付成功');
+  const handlePay = async (row: OrderItem) => {
+    const { qrcodeUrl, orderNo } = await api.createWechatPay(row.id);
+    openPayQrModal({ qrcodeUrl, orderNo });
+    listenPaymentStatus(orderNo);
   };
`;

// ==================== 8. 服务器监控指标 (Server Stats) ====================
export const MOCK_SERVER_STATS: ServerStats = {
  uptime: '142 天 18 小时 32 分',
  cpuUsage: 28.5,
  memory: {
    total: 16 * 1024 * 1024 * 1024,
    used: 8.8 * 1024 * 1024 * 1024,
    available: 7.2 * 1024 * 1024 * 1024,
    usagePercent: 55.0,
    swapTotal: 4 * 1024 * 1024 * 1024,
    swapUsed: 0.4 * 1024 * 1024 * 1024,
  },
  disk: [
    {
      mount: '/',
      total: 120 * 1024 * 1024 * 1024,
      used: 48 * 1024 * 1024 * 1024,
      available: 72 * 1024 * 1024 * 1024,
      usagePercent: 40.0,
    },
    {
      mount: '/data',
      total: 500 * 1024 * 1024 * 1024,
      used: 215 * 1024 * 1024 * 1024,
      available: 285 * 1024 * 1024 * 1024,
      usagePercent: 43.0,
    },
  ],
  network: {
    rxBytes: 104857600,
    txBytes: 52428800,
    rxSpeed: 1024 * 450, // 450 KB/s
    txSpeed: 1024 * 180, // 180 KB/s
  },
  timestamp: Date.now(),
};
