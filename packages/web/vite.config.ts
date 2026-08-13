import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API_TARGET = process.env.SOOYA_API_TARGET ?? 'http://127.0.0.1:8788';
const coreRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../core/src');
const coreAppEntry = path.join(coreRoot, 'app/index.ts');

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // @sooya/core ships TypeScript sources; compile them with the web build.
      '@sooya/core/app': coreAppEntry,
      '@sooya/core/platform': path.join(coreRoot, 'platform/index.ts')
    }
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    target: 'es2020',
    rollupOptions: {
      output: {
        manualChunks: { react: ['react', 'react-dom'] }
      }
    }
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true, ws: false },
      '/health': { target: API_TARGET, changeOrigin: true }
    }
  }
});
