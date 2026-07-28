const runtime = window.__HEURION_PLUGIN_RUNTIME__;

if (runtime && typeof runtime.register === 'function') {
  runtime.register('dashboard_card', () => {
    const el = document.createElement('div');
    el.className = 'p-4 space-y-2';
    el.innerHTML = `
      <h3 class="text-lg font-bold text-text-primary">Hello from UI Plugin</h3>
      <p class="text-sm text-text-secondary">This card is rendered by the <code>demo/hello-card</code> plugin via Shadow DOM.</p>
      <div class="text-xs text-text-tertiary">Extension point: dashboard_card</div>
    `;
    return el;
  });
} else {
  // eslint-disable-next-line no-console
  console.warn('demo/hello-card: Heurion plugin runtime not available');
}
