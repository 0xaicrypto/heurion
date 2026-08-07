import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PluginUIProvider, usePluginRegistrations } from './PluginUIRegistry';
import { api } from '@/lib/api';

function createLocalStorageMock(): Storage {
  const store: Record<string, string> = {};
  return {
    get length() {
      return Object.keys(store).length;
    },
    key(index: number) {
      return Object.keys(store)[index] ?? null;
    },
    getItem(key: string) {
      return store[key] ?? null;
    },
    setItem(key: string, value: string) {
      store[key] = String(value);
    },
    removeItem(key: string) {
      delete store[key];
    },
    clear() {
      for (const k of Object.keys(store)) {
        delete store[k];
      }
    },
  } as Storage;
}

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

function renderWithRouter(ui: React.ReactNode) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

function clearPluginStorage() {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith('heurion-plugin:')) keys.push(key);
  }
  keys.forEach((k) => localStorage.removeItem(k));
}

describe('PluginUIRegistry', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createLocalStorageMock());
    vi.spyOn(api, 'listInstalledUIPlugins').mockResolvedValue({ plugins: [] });
  });

  afterEach(() => {
    delete (window as Window & { __HEURION_PLUGIN_RUNTIME__?: unknown }).__HEURION_PLUGIN_RUNTIME__;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    api.setToken(null);
    clearPluginStorage();
    document.getElementById('heurion-plugin-toasts')?.remove();
  });

  it('exposes a global runtime that plugins can register into', () => {
    renderWithRouter(
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
    api.setToken('test-token');
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

    renderWithRouter(
      <PluginUIProvider>
        <TestConsumer point="dashboard_card" />
      </PluginUIProvider>,
    );

    await waitFor(() => {
      expect(api.listInstalledUIPlugins).toHaveBeenCalled();
    });
  });

  it('runtime events support on/emit', () => {
    renderWithRouter(
      <PluginUIProvider>
        <div />
      </PluginUIProvider>,
    );

    const runtime = (window as Window & { __HEURION_PLUGIN_RUNTIME__?: { events: { on: (event: string, handler: (payload: unknown) => void) => () => void; emit: (event: string, payload: unknown) => void } } }).__HEURION_PLUGIN_RUNTIME__;
    expect(runtime).toBeDefined();

    const handler = vi.fn();
    const unsubscribe = runtime!.events.on('test-event', handler);
    runtime!.events.emit('test-event', { hello: 'world' });
    expect(handler).toHaveBeenCalledWith({ hello: 'world' });

    unsubscribe();
    runtime!.events.emit('test-event', { again: true });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('runtime storage is namespaced by plugin id', async () => {
    renderWithRouter(
      <PluginUIProvider>
        <div />
      </PluginUIProvider>,
    );

    const runtime = (window as Window & { __HEURION_PLUGIN_RUNTIME__?: { __currentPluginId?: string; storage: { get: (key: string) => Promise<unknown>; set: (key: string, value: unknown) => Promise<void> } } }).__HEURION_PLUGIN_RUNTIME__;
    expect(runtime).toBeDefined();

    runtime!.__currentPluginId = 'demo/plugin-a';
    await runtime!.storage.set('token', 'secret-a');
    expect(await runtime!.storage.get('token')).toBe('secret-a');

    runtime!.__currentPluginId = 'demo/plugin-b';
    expect(await runtime!.storage.get('token')).toBeUndefined();

    runtime!.__currentPluginId = 'demo/plugin-a';
    expect(await runtime!.storage.get('token')).toBe('secret-a');
  });

  it('runtime ui.toast renders a toast', () => {
    renderWithRouter(
      <PluginUIProvider>
        <div />
      </PluginUIProvider>,
    );

    const runtime = (window as Window & { __HEURION_PLUGIN_RUNTIME__?: { ui: { toast: (message: string, type?: string) => void } } }).__HEURION_PLUGIN_RUNTIME__;
    expect(runtime).toBeDefined();

    act(() => {
      runtime!.ui.toast('Hello from plugin', 'success');
    });

    expect(document.body.textContent).toContain('Hello from plugin');
  });

  it('runtime ui.navigate changes history', () => {
    renderWithRouter(
      <PluginUIProvider>
        <div />
      </PluginUIProvider>,
    );

    const runtime = (window as Window & { __HEURION_PLUGIN_RUNTIME__?: { ui: { navigate: (path: string) => void } } }).__HEURION_PLUGIN_RUNTIME__;
    expect(runtime).toBeDefined();

    const pushStateSpy = vi.spyOn(window.history, 'pushState');
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    runtime!.ui.navigate('/app/chat');

    expect(pushStateSpy).toHaveBeenCalledWith({}, '', '/app/chat');
    expect(dispatchSpy).toHaveBeenCalledWith(expect.any(PopStateEvent));
  });
});
