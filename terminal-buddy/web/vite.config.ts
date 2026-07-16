import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    // web/ has its own dependency tree. Keep parent-resolved packages on this React instance.
    dedupe: ['react', 'react-dom'],
  },
  server: {
    // host:true 让同一局域网的手机可直接连 vite dev server (http://<电脑IP>:5173)
    host: true,
    port: 5173,
    proxy: {
      '/api': 'http://localhost:9600',
      '/ws': { target: 'ws://localhost:9600', ws: true },
    },
  },
  build: {
    outDir: 'dist',
  },
});
