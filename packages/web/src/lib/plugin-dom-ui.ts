/**
 * #688 — bare-DOM toast/modal/navigate used by the plugin runtime bridge.
 * Extracted from PluginUIRegistry.tsx so the registry file only owns
 * loading/registration; kept DOM-based on purpose (the bridge runs outside
 * React event flows and must work before/independent of the component tree).
 */

function createToastContainer(): HTMLDivElement {
  const existing = document.getElementById('heurion-plugin-toasts');
  if (existing) return existing as HTMLDivElement;
  const container = document.createElement('div');
  container.id = 'heurion-plugin-toasts';
  container.style.cssText =
    'position:fixed;top:16px;right:16px;z-index:9999;display:flex;flex-direction:column;gap:8px;pointer-events:none;';
  document.body.appendChild(container);
  return container;
}

export function showToast(message: string, type: 'info' | 'success' | 'error' = 'info') {
  const container = createToastContainer();
  const el = document.createElement('div');
  const colors = {
    info: 'bg-surface-elevated text-text-primary border-border',
    success: 'bg-success/10 text-success border-success/20',
    error: 'bg-error/10 text-error border-error/20',
  };
  el.className = `rounded-lg border px-4 py-2 text-sm shadow-lg pointer-events-auto ${colors[type]}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 300ms';
    setTimeout(() => el.remove(), 300);
  }, 3000);
}

export function showModal(config: {
  title?: string;
  message: string;
  confirm?: string;
  cancel?: string;
}): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText =
      'position:fixed;inset:0;z-[9998];display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.4);';

    const box = document.createElement('div');
    box.className = 'rounded-xl border border-border bg-surface-elevated p-6 shadow-xl max-w-sm w-full mx-4';

    if (config.title) {
      const title = document.createElement('h3');
      title.className = 'mb-2 text-lg font-semibold text-text-primary';
      title.textContent = config.title;
      box.appendChild(title);
    }

    const msg = document.createElement('p');
    msg.className = 'mb-6 text-sm text-text-secondary';
    msg.textContent = config.message;
    box.appendChild(msg);

    const actions = document.createElement('div');
    actions.className = 'flex justify-end gap-2';

    const cancelBtn = document.createElement('button');
    cancelBtn.className =
      'rounded-lg px-4 py-2 text-sm font-medium text-text-secondary hover:bg-surface';
    cancelBtn.textContent = config.cancel || 'Cancel';
    cancelBtn.onclick = () => {
      cleanup();
      resolve(false);
    };

    const confirmBtn = document.createElement('button');
    confirmBtn.className =
      'rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover';
    confirmBtn.textContent = config.confirm || 'OK';
    confirmBtn.onclick = () => {
      cleanup();
      resolve(true);
    };

    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    box.appendChild(actions);
    overlay.appendChild(box);

    const cleanup = () => overlay.remove();
    overlay.onclick = (e) => {
      if (e.target === overlay) {
        cleanup();
        resolve(false);
      }
    };

    document.body.appendChild(overlay);
  });
}

export function navigate(path: string) {
  window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
