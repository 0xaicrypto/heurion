import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';
import './i18n';
import { initTheme } from './stores/theme';

initTheme();

// #fix 2026-09: 旧标签页跨部署失效自愈 — 部署替换了带 hash 的产物后,
// 仍在运行的旧会话懒加载已被删除的 chunk 会 404(用户视角即"页面打不开/
// 点不动")。Vite 官方信号: vite:preloadError 时 reload 一次拿新版本;
// sessionStorage 守卫防止新版本本身损坏时的无限刷新循环。
window.addEventListener('vite:preloadError', () => {
  const key = 'vitePreloadReloadAt';
  const last = Number(sessionStorage.getItem(key) || 0);
  if (Date.now() - last < 10_000) return;
  sessionStorage.setItem(key, String(Date.now()));
  window.location.reload();
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
