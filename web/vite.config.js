import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';

// BASE_PATH must match the server's BASE_PATH when reverse-proxied under a sub-path.
const base = process.env.BASE_PATH ? process.env.BASE_PATH.replace(/\/+$/, '') + '/' : '/';

export default defineConfig({
  base,
  plugins: [vue()],
  build: {
    // Build straight into ../public so the Node server serves it in production.
    outDir: fileURLToPath(new URL('../public', import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/healthz': 'http://127.0.0.1:8787',
    },
  },
});
