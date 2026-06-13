import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Tauri 2.0 sets TAURI_DEV_HOST when running on a physical device for mobile.
// Honoring it keeps the same config working for desktop + later iOS/Android.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },

  // Tauri expects a fixed port — don't auto-bump on conflict.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,

    // Dev-only: proxy /api/v1/* to the local FastAPI backend so the
    // frontend can use relative URLs in both dev and prod (in prod
    // we point ApiClient.baseUrl at the bundled server URL).
    proxy: {
      '/api': {
        target: 'http://localhost:8001',
        changeOrigin: true,
      },
    },

    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },

  envPrefix: ['VITE_', 'TAURI_'],

  build: {
    target: ['es2021', 'chrome105', 'safari15'],
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
}));
