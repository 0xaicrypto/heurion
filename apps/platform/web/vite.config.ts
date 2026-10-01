import { defineConfig } from 'vite'

// 页面开发服务器：/api、/collab 代理到平台 server（8787）
export default defineConfig({
  root: __dirname,
  build: { outDir: '../dist-web', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/collab': { target: 'ws://127.0.0.1:8787', ws: true },
    },
  },
})
