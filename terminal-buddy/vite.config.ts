import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const MONACO_EMPTY_STUB = '\0monaco-empty-stub';

const KEPT_MONACO_LANGUAGES = new Set([
  'bat', 'clojure', 'coffee', 'cpp', 'csharp', 'css', 'dart', 'dockerfile',
  'elixir', 'fsharp', 'go', 'graphql', 'handlebars', 'hcl', 'html', 'ini',
  'java', 'javascript', 'julia', 'kotlin', 'less', 'lua', 'markdown', 'mdx',
  'mysql', 'objective-c', 'pascal', 'perl', 'pgsql', 'php', 'powershell',
  'protobuf', 'pug', 'python', 'r', 'razor', 'restructuredtext', 'ruby',
  'rust', 'scala', 'scheme', 'scss', 'shell', 'solidity', 'sql', 'swift',
  'typescript', 'vb', 'xml', 'yaml',
]);

const TAURI_BRIDGE_MAP: Record<string, string> = {
  '@tauri-apps/api/core': fileURLToPath(new URL('./src/services/runtimeBridge/core.ts', import.meta.url)),
  '@tauri-apps/api/event': fileURLToPath(new URL('./src/services/runtimeBridge/event.ts', import.meta.url)),
  '@tauri-apps/api/window': fileURLToPath(new URL('./src/services/runtimeBridge/window.ts', import.meta.url)),
  '@tauri-apps/api/webview': fileURLToPath(new URL('./src/services/runtimeBridge/webview.ts', import.meta.url)),
  '@tauri-apps/plugin-dialog': fileURLToPath(new URL('./src/services/runtimeBridge/dialog.ts', import.meta.url)),
  '@tauri-apps/plugin-global-shortcut': fileURLToPath(new URL('./src/services/runtimeBridge/globalShortcut.ts', import.meta.url)),
};

/** 非 browser 模式下把 @tauri-apps/* 路由到运行时桥接层，使 dist 同时兼容 Tauri 与网页端。 */
function unifiedTauriBridgePlugin(mode: string): Plugin {
  return {
    name: 'unified-tauri-bridge',
    enforce: 'pre',
    resolveId(source, importer) {
      if (mode === 'browser') return null;
      const target = TAURI_BRIDGE_MAP[source];
      if (!target) return null;
      const normalizedImporter = importer?.replace(/\\/g, '/') ?? '';
      if (
        normalizedImporter.includes('/src/services/runtimeBridge/')
        || normalizedImporter.includes('/node_modules/@tauri-apps/')
      ) {
        return null;
      }
      return target;
    },
  };
}

/** 裁剪 Monaco 重型语言服务 worker（保留 json）与冷门语法定义，保留语法高亮。 */
function trimMonacoPlugin(): Plugin {
  return {
    name: 'trim-monaco',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer) return null;
      const normalizedImporter = importer.replace(/\\/g, '/');
      if (!normalizedImporter.includes('/monaco-editor/')) return null;
      const normalizedSource = source.replace(/\\/g, '/');

      if (/(?:^|\/)languages\/features\/(?:typescript|css|html)\/register\.js$/.test(normalizedSource)) {
        return MONACO_EMPTY_STUB;
      }
      if (normalizedSource.includes('external/monaco-lsp-client/')) {
        return MONACO_EMPTY_STUB;
      }
      const defMatch = normalizedSource.match(/(?:^|\/)languages\/definitions\/([^/]+)\/register\.js$/);
      if (defMatch && !KEPT_MONACO_LANGUAGES.has(defMatch[1])) {
        return MONACO_EMPTY_STUB;
      }
      return null;
    },
    load(id) {
      if (id === MONACO_EMPTY_STUB) {
        return 'export {};';
      }
      return null;
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [unifiedTauriBridgePlugin(mode), trimMonacoPlugin(), react()],
  clearScreen: false,
  resolve: {
    alias: {
      // Monaco 0.57.0 内联了带漏洞的 DOMPurify 3.4.15，且 npm overrides 无法替换内联副本。
      // 它只通过这个模块路径引用 sanitizer；映射到顶层已修复版本，避免等待 Monaco 0.58。
      'monaco-editor/esm/vs/base/browser/dompurify/dompurify.js': 'dompurify',
      ...(mode === 'browser' ? Object.fromEntries([
        ['@tauri-apps/api/core', 'core'], ['@tauri-apps/api/event', 'event'],
        ['@tauri-apps/api/window', 'window'], ['@tauri-apps/api/webview', 'webview'],
        ['@tauri-apps/plugin-dialog', 'dialog'], ['@tauri-apps/plugin-global-shortcut', 'globalShortcut'],
      ].map(([name, file]) => [name, fileURLToPath(new URL(`./src/services/browser/${file}.ts`, import.meta.url))])) : {}),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 1450,
    strictPort: true,
    proxy: {
      '/api': { target: process.env.TERMINAL_BUDDY_BACKEND ?? 'http://127.0.0.1:9600', changeOrigin: true },
      '/ws': { target: process.env.TERMINAL_BUDDY_BACKEND ?? 'http://127.0.0.1:9600', ws: true, changeOrigin: true },
    },
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  // cssMinify：CSS 压缩后约省 20%，dist-web 会被 rust-embed 打进 exe。
  // reportCompressedSize：构建时逐个文件 gzip 统计，纯日志用途，关掉省时间。
  build: {
    cssMinify: true,
    reportCompressedSize: false,
    outDir: mode === 'browser' ? 'dist-web' : 'dist',
  },
}));
