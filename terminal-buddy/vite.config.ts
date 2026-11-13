import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig(({ mode }) => ({
  plugins: [react()],
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
  build: { cssMinify: false, outDir: mode === 'browser' ? 'dist-web' : 'dist' },
}));
