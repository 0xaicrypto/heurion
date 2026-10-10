import { resolve } from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  root: import.meta.dirname,
  build: {
    outDir: '../dist-web',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, 'index.html'),
      },
    },
  },
  server: {
    port: 5188,
    proxy: {
      '/api': 'http://127.0.0.1:8888',
      '/collab': { target: 'ws://127.0.0.1:8888', ws: true },
      '/mcp': 'http://127.0.0.1:8888',
    },
  },
})
