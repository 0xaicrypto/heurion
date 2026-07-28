import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { PluginUIProvider, usePluginRegistrations } from './PluginUIRegistry';
import { api } from '@/lib/api-client';
function TestConsumer({ point }: { point: string }) {
  const regs = usePluginRegistrations(point);
  return (
    <div data-testid="consumer">
      {regs.map((r) => (
        <span key={r.pluginId} data-testid="reg">
          {r.pluginId}:{r.extensionPointId}
        </span>
      ))}
    </div>
  );
}

describe('PluginUIRegistry', () => {
  beforeEach(() => {
    api.setToken('test-token');
  });

  afterEach(() => {
    delete (window as Window & { __HEURION_PLUGIN_RUNTIME__?: unknown }).__HEURION_PLUGIN_RUNTIME__;
    vi.restoreAllMocks();
    api.setToken(null);
  });

  it('exposes a global runtime that plugins can register into', () => {
    render(
      <PluginUIProvider>
        <TestConsumer point="dashboard_card" />
      </PluginUIProvider>,
    );

    const runtime = (window as Window & { __HEURION_PLUGIN_RUNTIME__?: { register: (point: string, factory: () => HTMLElement) => void } }).__HEURION_PLUGIN_RUNTIME__;
    expect(runtime).toBeDefined();

    act(() => {
      runtime!.register('dashboard_card', () => document.createElement('div'));
    });

    expect(screen.getAllByTestId('reg').length).toBe(1);
    expect(screen.getByTestId('reg').textContent).toBe('__unknown__:dashboard_card');
  });

  it('loads installed UI plugins on mount', async () => {
    vi.spyOn(api, 'listInstalledUIPlugins').mockResolvedValue({
      plugins: [
        {
          pluginId: 'demo/hello-card',
          name: 'Hello Card Demo',
          ui: {
            bundle_url: '/plugin-demos/hello-card/index.js',
            extension_points: [{ type: 'dashboard_card', id: 'dashboard_card', label: 'Dashboard Card' }],
          },
        },
      ],
    });

    render(
      <PluginUIProvider>
        <TestConsumer point="dashboard_card" />
      </PluginUIProvider>,
    );

    await waitFor(() => {
      expect(api.listInstalledUIPlugins).toHaveBeenCalled();
    });
  });
});
