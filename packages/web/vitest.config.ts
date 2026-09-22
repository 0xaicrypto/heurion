import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      // #1101: pptx-react-viewer 的 Node 侧按需依赖 — 测试环境同样 stub
      // （动态 import 在构建时仍要可解析，同 vite.config.ts）。
      '@napi-rs/canvas': resolve(__dirname, 'src/canvas-stub.js'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    // #1101: deck 富编辑真实挂载用例 — pptx-react-viewer 的 CJS 依赖
    // （opentype.js 等）需要内联转换才能提供命名导出（否则 ESM 互操作失败）。
    server: {
      deps: {
        inline: ['pptx-react-viewer'],
      },
    },
  },
});
