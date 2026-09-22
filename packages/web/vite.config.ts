import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      // #1101: pptx-react-viewer 的 Node 侧按需依赖（服务端 EMF 光栅化）—
      // 浏览器端从不加载，但 rollup 构建时要能解析（src/canvas-stub.js 空实现）。
      '@napi-rs/canvas': resolve(__dirname, 'src/canvas-stub.js'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_API_PROXY || 'http://localhost:8001',
        changeOrigin: true,
      },
      '/auth': {
        target: process.env.VITE_API_PROXY || 'http://localhost:8001',
        changeOrigin: true,
      },
      '/healthz': {
        target: process.env.VITE_API_PROXY || 'http://localhost:8001',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
