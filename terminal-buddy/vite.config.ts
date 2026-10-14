import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  clearScreen: false,
  resolve: {
    alias: mode === 'browser' ? Object.fromEntries([
      ['@tauri-apps/api/core', 'core'], ['@tauri-apps/api/event', 'event'],
      ['@tauri-apps/api/window', 'window'], ['@tauri-apps/api/webview', 'webview'],
      ['@tauri-apps/plugin-dialog', 'dialog'], ['@tauri-apps/plugin-global-shortcut', 'globalShortcut'],
    ].map(([name, file]) => [name, fileURLToPath(new URL(`./src/services/browser/${file}.ts`, import.meta.url))])) : {},
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
  build: { cssMinify: false },
}));
