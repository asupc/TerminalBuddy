import {
  MOCK_PROFILES,
  MOCK_PROJECTS,
  MOCK_TERMINAL_OUTPUTS,
  MOCK_FILE_NODES,
  MOCK_FILE_CONTENTS,
  MOCK_GIT_STATUS,
  MOCK_GIT_COMMITS,
  MOCK_GIT_BRANCHES,
  MOCK_GIT_DIFF,
  MOCK_SERVER_STATS,
} from './mockData';
import { useAppStore } from '../stores/appStore';

// 如果已经在真实 Tauri 环境中，不执行 mock
if (import.meta.env.MODE === 'browser-demo' && typeof window !== 'undefined' && !(window as any).__TAURI_INTERNALS__) {
  console.log('⚡ [TerminalBuddy Mock] 正在安装浏览器端 1:1 Mock 运行时...');

  // 初始化 localStorage 配置，默认启用高颜值的 VSCode 侧边栏模式 (sidebar)
  try {
    const existingRaw = localStorage.getItem('appSettings');
    const existing = existingRaw ? JSON.parse(existingRaw) : {};
    existing.uiStyle = 'sidebar';
    existing.enableTabNavigation = false;
    existing.themeSkin = 'dark';
    existing.listSelectionStyle = 'idea';
    existing.terminalFollowAppTheme = true;
    localStorage.setItem('appSettings', JSON.stringify(existing));
  } catch (e) {
    console.warn('Failed to set mock default settings', e);
  }

  // 1. 回调函数管理器
  const callbackRegistry = new Map<number, Function>();
  let nextCallbackId = 1;

  // 2. 事件监听器系统
  const eventListeners = new Map<string, Set<{ id: number; callbackId: number }>>();
  let nextListenerId = 1;

  function triggerTauriEvent(event: string, payload: any) {
    const listeners = eventListeners.get(event);
    if (listeners) {
      listeners.forEach((item) => {
        const cb = callbackRegistry.get(item.callbackId);
        if (cb) {
          try {
            cb({ event, payload, id: item.id });
          } catch (e) {
            console.error(`Error in event listener for ${event}:`, e);
          }
        }
      });
    }
  }

  // 3. 模拟持久化 client_data
  const initialSavedTabs = JSON.stringify({
    tabs: [
      {
        profileId: 'prof-vue-admin',
        profileName: 'Vue3 电商管理后台',
        terminalType: 'powershell',
        colorTheme: { background: '#1E1E1E', foreground: '#CCCCCC' },
        tabColor: '#3b82f6',
        groupId: '前端工程/商城业务',
        groupName: '前端工程/商城业务',
        owner: 'pc',
        startupPath: 'D:\\Projects\\shop-admin',
        directory: 'D:\\Projects\\shop-admin',
      },
      {
        profileId: 'prof-centos-ssh',
        profileName: 'CentOS 7.9 生产跳板机',
        terminalType: 'ssh',
        colorTheme: { background: '#1E1E1E', foreground: '#CCCCCC' },
        tabColor: '#ec4899',
        groupId: '运维集群/云服务器',
        groupName: '运维集群/云服务器',
        owner: 'pc',
        startupPath: '',
        directory: '~',
      },
      {
        profileId: 'prof-k8s-prod',
        profileName: 'K8s 生产集群 (Prod-East-01)',
        terminalType: 'k8s',
        colorTheme: { background: '#1E1E1E', foreground: '#CCCCCC' },
        tabColor: '#8b5cf6',
        groupId: '运维集群/容器编排',
        groupName: '运维集群/容器编排',
        owner: 'pc',
        startupPath: '',
        directory: '',
      },
      {
        profileId: 'prof-spring-order',
        profileName: 'SpringCloud 订单中心',
        terminalType: 'cmd',
        colorTheme: { background: '#1E1E1E', foreground: '#CCCCCC' },
        tabColor: '#f59e0b',
        groupId: '后端架构/核心微服务',
        groupName: '后端架构/核心微服务',
        owner: 'pc',
        startupPath: 'D:\\Backend\\order-service',
        directory: 'D:\\Backend\\order-service',
      },
    ],
    activeIndex: 0,
  });

  const clientDataStorage: Record<string, string> = {
    saved_tabs: initialSavedTabs,
    settings: JSON.stringify({
      uiStyle: 'sidebar',
      restoreTabsOnStartup: true,
      configPanelAutoExpand: true,
      fileTreeAutoExpand: true,
      historyPanelAutoExpand: true,
      closeBehavior: 'exit',
      launchWindowMode: 'windowed',
      terminalLoadingMode: 'default',
      enableTabNavigation: false,
      singleInstance: true,
      themeSkin: 'dark',
      listSelectionStyle: 'idea',
      terminalFollowAppTheme: true,
      appOpacityBySkin: {
        cartoon: 0,
        starry: 0,
        cyber: 0,
        sakura: 0,
      },
    }),
  };

  // 4. 活跃终端管理
  const activeTerminals = new Map<string, any>();
  // 预注册 3 个初始终端
  activeTerminals.set('term-vue-admin', {
    id: 'term-vue-admin',
    profileId: 'prof-vue-admin',
    profileName: 'Vue3 电商管理后台',
    group: '前端工程/商城业务',
    terminalType: 'powershell',
    loadingMode: 'none',
    owner: 'pc',
  });
  activeTerminals.set('term-centos-ssh', {
    id: 'term-centos-ssh',
    profileId: 'prof-centos-ssh',
    profileName: 'CentOS 7.9 生产跳板机',
    group: '运维集群/云服务器',
    terminalType: 'ssh',
    loadingMode: 'none',
    owner: 'pc',
  });
  activeTerminals.set('term-k8s-prod', {
    id: 'term-k8s-prod',
    profileId: 'prof-k8s-prod',
    profileName: 'K8s 生产集群 (Prod-East-01)',
    group: '运维集群/容器编排',
    terminalType: 'k8s',
    loadingMode: 'none',
    owner: 'pc',
  });
  activeTerminals.set('term-spring-order', {
    id: 'term-spring-order',
    profileId: 'prof-spring-order',
    profileName: 'SpringCloud 订单中心',
    group: '后端架构/核心微服务',
    terminalType: 'cmd',
    loadingMode: 'none',
    owner: 'pc',
  });

  let termCounter = 1;

  // 5. 核心 Invoke 分发器
  async function mockInvoke(cmd: string, args: any = {}): Promise<any> {
    // console.log(`[Mock Invoke] ${cmd}`, args);

    switch (cmd) {
      // ===== Agent CLI =====
      case 'get_agent_cli_environment':
        return {
          claude: { status: 'installed', version: '2.1.10', message: null, update: null, updatedVersion: null },
          codex: { status: 'installed', version: '0.116.0', message: null, update: null, updatedVersion: null },
          antigravity: { status: 'installed', version: '1.5.10', message: null, update: null, updatedVersion: null },
        };
      case 'list_antigravity_models':
        return [
          { id: 'gemini-4-neon-high', name: 'Gemini 4 Neon (High)' },
          { id: 'gemini-pro-orchestrator-neon', name: 'Orchestrator (Neon)' },
          { id: 'claude-sonnet-5-5-medium', name: 'Claude Sonnet 5.5 (Medium)' },
        ];
      case 'get_antigravity_provider_config':
        return {
          defaultEffortLevel: 'high',
          availableModels: [
            { id: 'gemini-4-neon-high', name: 'Gemini 4 Neon (High)' },
            { id: 'gemini-pro-orchestrator-neon', name: 'Orchestrator (Neon)' },
            { id: 'claude-sonnet-5-5-medium', name: 'Claude Sonnet 5.5 (Medium)' },
          ],
          enabledModels: [
            { id: 'gemini-4-neon-high', name: 'Gemini 4 Neon (High)', effortLevel: '' },
          ],
        };
      case 'save_antigravity_provider_config':
        return args.config ?? null;
      case 'fetch_antigravity_provider_models':
        return {
          defaultEffortLevel: 'high',
          availableModels: [
            { id: 'gemini-4-neon-high', name: 'Gemini 4 Neon (High)' },
            { id: 'gemini-pro-orchestrator-neon', name: 'Orchestrator (Neon)' },
            { id: 'claude-sonnet-5-5-medium', name: 'Claude Sonnet 5.5 (Medium)' },
          ],
          enabledModels: [
            { id: 'gemini-4-neon-high', name: 'Gemini 4 Neon (High)', effortLevel: '' },
          ],
        };
      case 'save_agent_commands':
        return null;

      // ===== Profiles =====
      case 'get_all_profiles':
        return [...MOCK_PROFILES];
      case 'get_profile':
        return MOCK_PROFILES.find((p) => p.id === args.id) || MOCK_PROFILES[0];
      case 'create_profile': {
        const newProf = {
          id: `prof-new-${Date.now()}`,
          name: args.name,
          group: args.group,
          terminalType: args.terminalType,
          startupPath: '',
          startupCommands: [],
          environmentVariables: {},
          colorTheme: 'dark-default',
          tabColor: '#3b82f6',
          windowSize: null,
          createdAt: new Date().toISOString(),
          lastUsedAt: null,
        };
        MOCK_PROFILES.push(newProf);
        return newProf;
      }
      case 'update_profile': {
        const idx = MOCK_PROFILES.findIndex((p) => p.id === args.profile.id);
        if (idx !== -1) {
          MOCK_PROFILES[idx] = { ...args.profile };
        }
        return null;
      }
      case 'delete_profile': {
        const idx = MOCK_PROFILES.findIndex((p) => p.id === args.id);
        if (idx !== -1) MOCK_PROFILES.splice(idx, 1);
        return null;
      }
      case 'update_profile_last_used':
        return null;

      // ===== Projects =====
      case 'get_projects':
        return [...MOCK_PROJECTS];
      case 'save_projects':
        return null;

      // ===== Settings =====
      case 'get_app_settings':
      case 'get_backend_app_settings':
        return {
          closeBehavior: 'Tray',
          dataPath: null,
          tabSidebarWidth: 260,
          configNavWidth: 260,
          fileNavWidth: 260,
          enableTabNavigation: false,
          singleInstance: true,
          webApiEnabled: true,
          webApiPort: 1421,
          webApiUsername: 'admin',
          webApiPasswordHash: '$2b$12$abcdefg',
          sshDownloadDir: 'C:\\Users\\Administrator\\Downloads',
          serverMonitorInterval: 2,
          webApiShareSessions: false,
          defaultTerminalHandoffMode: 'none',
          splitFontSizeConfig: { off: 14, '2x1': 13, '2x2': 12 },
        };
      case 'save_app_settings':
        return null;

      // ===== Templates & History =====
      case 'get_command_templates':
      case 'init_command_templates':
        return [];
      case 'get_custom_commands':
        return [];
      case 'get_cmd_overrides':
        return {};
      case 'get_command_history':
        return [
          { command: 'pnpm run dev', note: '启动商城后台前端' },
          { command: 'git status', note: '查看变更' },
          { command: 'kubectl get pods -n production', note: '查看生产环境容器状态' },
          { command: 'docker ps', note: '列出本地容器' },
        ];

      // ===== Client Data =====
      case 'read_client_data':
        return clientDataStorage[args.key] || null;
      case 'write_client_data':
        clientDataStorage[args.key] = args.data;
        return null;

      // ===== Terminal =====
      case 'start_terminal': {
        const id = args.profileId === 'prof-centos-ssh' ? 'term-centos-ssh'
          : args.profileId === 'prof-k8s-prod' ? 'term-k8s-prod'
          : args.profileId === 'prof-spring-order' ? 'term-spring-order'
          : `term-mock-${termCounter++}`;
        const prof = MOCK_PROFILES.find((p) => p.id === args.profileId);
        activeTerminals.set(id, {
          id,
          profileId: args.profileId,
          profileName: prof?.name || '终端会话',
          group: prof?.group || '默认',
          terminalType: prof?.terminalType || 'powershell',
          loadingMode: 'none',
          owner: 'pc',
        });
        return id;
      }
      case 'start_blank_terminal': {
        const id = `term-blank-${termCounter++}`;
        activeTerminals.set(id, {
          id,
          profileId: '',
          profileName: args.displayName || 'PowerShell',
          group: '',
          terminalType: args.terminalType || 'powershell',
          loadingMode: 'none',
          owner: 'pc',
        });
        return id;
      }
      case 'list_terminals':
        return Array.from(activeTerminals.values());
      case 'close_terminal':
        activeTerminals.delete(args.id);
        return null;
      case 'drain_terminal_output':
        return MOCK_TERMINAL_OUTPUTS[args.id] || MOCK_TERMINAL_OUTPUTS['term-vue-admin'];
      case 'acknowledge_terminal_output':
      case 'resize_terminal':
      case 'update_terminal_display_name':
        return null;
      case 'write_to_terminal':
        // 回显简单的字符
        return null;
      case 'get_windows_build_number':
        return 22631;
      case 'get_claude_sessions_for_terminals':
        return {};
      case 'get_pending_claude_hook_decisions':
        return [];

      // Codex 演示模式没有本地转录；保持空列表，入口仍可正常切换。
      case 'codex_history_list':
      case 'codex_history_search':
        return [];
      case 'codex_history_rescan':
        return { scanned: 0, updated: 0, total: 0, pending: 0 };

      // Antigravity CLI 演示模式保持空列表，各命令均有兜底响应。
      case 'antigravity_history_list':
      case 'antigravity_history_search':
        return [];
      case 'antigravity_history_rescan':
        return { scanned: 0, updated: 0, total: 0, pending: 0 };
      case 'antigravity_history_get_replay':
        return { total: 0, messages: [], title: '', projectDir: '', model: null, inputTokens: 0, outputTokens: 0, startedAt: null, updatedAt: 0 };
      case 'antigravity_history_rename':
      case 'antigravity_history_set_flags':
      case 'antigravity_history_delete':
      case 'antigravity_history_delete_many':
      case 'antigravity_history_export':
        return null;

      // ===== Claude History =====
      case 'claude_history_list':
        return [
          {
            sessionId: 'claude-sess-01',
            projectDir: 'D:\\Projects\\shop-admin',
            filePath: 'C:\\Users\\Administrator\\.claude\\projects\\shop-admin\\sess-01.jsonl',
            title: '接入微信扫码支付与订单状态实时 Webhook 监听',
            customTitle: null,
            startedAt: Date.now() - 3600 * 1000 * 24,
            updatedAt: Date.now() - 3600 * 1000 * 2,
            messageCount: 42,
            inputTokens: 148500,
            outputTokens: 18600,
            model: 'claude-3-7-sonnet',
            starred: true,
            archived: false,
          },
          {
            sessionId: 'claude-sess-02',
            projectDir: 'D:\\Projects\\shop-admin',
            filePath: 'C:\\Users\\Administrator\\.claude\\projects\\shop-admin\\sess-02.jsonl',
            title: '重构权限中间件与双因子认证路由拦截',
            customTitle: null,
            startedAt: Date.now() - 3600 * 1000 * 48,
            updatedAt: Date.now() - 3600 * 1000 * 20,
            messageCount: 28,
            inputTokens: 96200,
            outputTokens: 11400,
            model: 'claude-3-7-sonnet',
            starred: false,
            archived: false,
          },
        ];
      case 'claude_history_rescan':
        return { total: 2, pending: 0 };
      case 'claude_history_search':
        return [];
      case 'claude_history_rename':
      case 'claude_history_set_flags':
      case 'claude_history_delete':
        return null;

      // ===== File System =====
      case 'list_directory': {
        const p = args.path || 'D:\\Projects\\shop-admin';
        return MOCK_FILE_NODES[p] || MOCK_FILE_NODES['D:\\Projects\\shop-admin'];
      }
      case 'read_file_content':
        return MOCK_FILE_CONTENTS[args.path] || MOCK_FILE_CONTENTS['D:\\Projects\\shop-admin\\src\\App.vue'];
      case 'write_file_content':
        return true;
      case 'get_file_meta':
        return { size: 1024, lastModified: Date.now() };
      case 'open_path':
      case 'open_in_explorer':
      case 'save_file_content':
        return null;

      // ===== Git =====
      case 'get_git_repository_status':
      case 'get_git_status':
        return MOCK_GIT_STATUS;
      case 'git_get_changed_files':
        return [
          { path: 'src/views/order/OrderList.vue', extension: '.vue', status: '已修改', additions: 12, deletions: 3, staged: true, untracked: false },
          { path: 'src/api/order.ts', extension: '.ts', status: '已修改', additions: 8, deletions: 1, staged: false, untracked: false },
          { path: 'docs/payment-flow.md', extension: '.md', status: '未版本控制', additions: 0, deletions: 0, staged: false, untracked: true },
        ];
      case 'git_get_worktree_file_diff':
        return {
          path: String(args.filePath ?? ''),
          oldPath: null,
          oldContent: '  const handlePay = async (row: OrderItem) => {\n    await api.payOrder(row.id);\n    ElMessage.success(\'支付成功\');\n  };',
          newContent: '  const handlePay = async (row: OrderItem) => {\n    const { qrcodeUrl, orderNo } = await api.createWechatPay(row.id);\n    openPayQrModal({ qrcodeUrl, orderNo });\n    listenPaymentStatus(orderNo);\n  };',
          binary: false,
        };
      case 'git_get_history':
      case 'get_git_commit_history':
        return {
          commits: MOCK_GIT_COMMITS,
          refs: [MOCK_GIT_COMMITS[0].refs[0]],
          currentRef: MOCK_GIT_COMMITS[0].refs[0],
          upstreamRef: null,
          baseRef: null,
          mergeBase: null,
          ahead: 2,
          behind: 0,
        };
      case 'git_get_history_files':
        return [
          {
            path: 'src/views/order/OrderList.vue',
            oldPath: null,
            extension: 'vue',
            status: 'modified',
            statusCode: 'M',
            additions: 12,
            deletions: 3,
            binary: false,
          },
          {
            path: 'src/api/order.ts',
            oldPath: null,
            extension: 'ts',
            status: 'modified',
            statusCode: 'M',
            additions: 8,
            deletions: 1,
            binary: false,
          },
        ];
      case 'git_get_history_file_diff':
        return {
          path: 'src/views/order/OrderList.vue',
          oldPath: null,
          status: 'modified',
          statusCode: 'M',
          oldRevision: '9c4f1d0',
          newRevision: '7f9a2e1',
          oldContent: `  const handlePay = async (row: OrderItem) => {\n    await api.payOrder(row.id);\n    ElMessage.success('支付成功');\n  };`,
          newContent: `  const handlePay = async (row: OrderItem) => {\n    const { qrcodeUrl, orderNo } = await api.createWechatPay(row.id);\n    openPayQrModal({ qrcodeUrl, orderNo });\n    listenPaymentStatus(orderNo);\n  };`,
          binary: false,
        };
      case 'git_get_diff':
      case 'get_git_diff':
        return MOCK_GIT_DIFF;
      case 'git_list_branches':
      case 'get_git_branches':
        return MOCK_GIT_BRANCHES;

      // ===== SSH & Server Monitor =====
      case 'connect_ssh_session':
        return null;
      case 'get_server_stats':
      case 'get_server_monitor_stats':
        return MOCK_SERVER_STATS;
      case 'get_downloads_directory':
        return 'C:\\Users\\Administrator\\Downloads';
      case 'remote_list_dir':
        return [
          { name: 'etc', path: '/etc', isDir: true, size: 4096, modified: Date.now(), permissions: 0o755, owner: 'root', group: 'root' },
          { name: 'var', path: '/var', isDir: true, size: 4096, modified: Date.now(), permissions: 0o755, owner: 'root', group: 'root' },
          { name: 'opt', path: '/opt', isDir: true, size: 4096, modified: Date.now(), permissions: 0o755, owner: 'root', group: 'root' },
          { name: 'docker-compose.yml', path: '/opt/docker-compose.yml', isDir: false, size: 2310, modified: Date.now(), permissions: 0o644, owner: 'ops-admin', group: 'ops-admin' },
          { name: 'nginx.conf', path: '/etc/nginx/nginx.conf', isDir: false, size: 4120, modified: Date.now(), permissions: 0o644, owner: 'root', group: 'root' },
        ];

      // ===== Web API & Management =====
      case 'get_system_resources': {
        const memoryTotal = 16 * 1024 ** 3;
        const memoryUsed = memoryTotal * (0.32 + Math.random() * 0.3);
        return {
          cpuUsage: 8 + Math.random() * 30,
          cpuCount: 8,
          memoryUsed,
          memoryTotal,
          memoryUsage: (memoryUsed / memoryTotal) * 100,
        };
      }
      case 'get_web_api_status':
        return {
          enabled: true,
          port: 9600,
          username: 'admin',
          hasPassword: true,
          pageTitle: '',
        };
      case 'get_web_server_address':
        return 'http://192.168.10.88:9600';
      case 'get_web_quick_access_url':
        return 'http://192.168.10.88:9600/#/connect?auth=tb_token_demo_984f';
      case 'save_web_api_settings':
      case 'restart_web_server':
        return null;

      // ===== Updates & System =====
      case 'check_app_update':
        return null;
      case 'window_minimize':
      case 'window_toggle_maximize':
      case 'window_close':
      case 'window_exit_app':
        console.log(`[Window Action] ${cmd}`);
        return null;

      // ===== Plugins =====
      case 'plugin:dialog|open':
        return 'D:\\Projects\\shop-admin';
      case 'plugin:dialog|save':
        return 'D:\\Projects\\shop-admin\\config.json';
      case 'plugin:global-shortcut|register':
      case 'plugin:global-shortcut|unregister':
        return null;
      case 'plugin:event|listen': {
        const { event, handler } = args;
        const listenerId = nextListenerId++;
        if (!eventListeners.has(event)) {
          eventListeners.set(event, new Set());
        }
        eventListeners.get(event)!.add({ id: listenerId, callbackId: handler });
        return listenerId;
      }
      case 'plugin:event|unlisten': {
        const { event, eventId } = args;
        const set = eventListeners.get(event);
        if (set) {
          for (const item of set) {
            if (item.id === eventId) {
              set.delete(item);
              break;
            }
          }
        }
        return null;
      }

      case 'get_terminal_task_summaries':
        return {
          enabled: false,
          summaries: {},
          activities: {},
          providers: {},
        };
      case 'terminal_agent_usage':
        return null;

      default:
        console.warn(`[Mock Unhandled Cmd] ${cmd}`, args);
        return null;
    }
  }

  // 6. 挂载 __TAURI_INTERNALS__
  (window as any).__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: 'main' },
      currentWebview: { label: 'main' },
    },
    transformCallback(callback: Function, once = false) {
      const id = nextCallbackId++;
      callbackRegistry.set(id, (...cbArgs: any[]) => {
        if (once) callbackRegistry.delete(id);
        return callback(...cbArgs);
      });
      return id;
    },
    unregisterCallback(id: number) {
      callbackRegistry.delete(id);
    },
    convertFileSrc(filePath: string) {
      return filePath;
    },
    invoke: mockInvoke,
  };

  // 7. 挂载 __TAURI_EVENT_PLUGIN_INTERNALS__
  (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener(event: string, eventId: number) {
      const set = eventListeners.get(event);
      if (set) {
        for (const item of set) {
          if (item.id === eventId) {
            set.delete(item);
            break;
          }
        }
      }
    },
  };

  // 8. 全局 Mock 控制器（供自动化测试 / Playwright 场景切换使用）
  (window as any).__MOCK_CONTROLLER__ = {
    triggerEvent: triggerTauriEvent,
    profiles: MOCK_PROFILES,
    projects: MOCK_PROJECTS,
    store: useAppStore,
    openEditor: (filePath = 'D:\\Projects\\shop-admin\\src\\App.vue') => {
      useAppStore.getState().openEditorSession(filePath);
    },
    openGitHistory: (repoRoot = 'D:\\Projects\\shop-admin', branch = 'main') => {
      useAppStore.getState().openGitHistoryTab({ repoRoot, branch });
    },
    cycleSplit: () => {
      useAppStore.getState().cycleSplitMode();
    },
    selectSession: (id: string) => {
      useAppStore.getState().setActiveSession(id);
    },
    openSettings: () => {
      useAppStore.getState().openSettingsDialog();
    },
    closeSettings: () => {
      useAppStore.getState().closeSettingsDialog();
    },
    sendTerminalOutput: (termId: string, text: string) => {
      triggerTauriEvent(`terminal_output_${termId}`, text);
    },
  };

  console.log('✅ [TerminalBuddy Mock] 1:1 Mock 运行时已就绪！');
}
export {};
