import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
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
