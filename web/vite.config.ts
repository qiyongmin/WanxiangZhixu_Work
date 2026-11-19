import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API_TARGET = 'http://127.0.0.1:8001';

// Build output goes to root app/ as a generated CI/local artifact; never commit it.
export default defineConfig({
  base: '/app/',
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('../app', import.meta.url)),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
  },
  server: {
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
        // 既有写入校验只接受 localhost / 127.0.0.1 的 Origin，开发服务器的 Origin 需要改写。
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.setHeader('Origin', API_TARGET);
          });
        },
      },
    },
  },
});
