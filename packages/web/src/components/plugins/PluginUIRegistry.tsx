import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api-client';

export interface PluginUIRegistration {
  pluginId: string;
  pluginName: string;
  extensionPointId: string;
  factory: (ctx: unknown) => HTMLElement | Promise<HTMLElement>;
}

export interface PluginRuntimeAPI {
  fetch: (path: string, init?: RequestInit) => Promise<unknown>;
  getPluginId: () => string | undefined;
}

export interface PluginUIRegistryState {
  loaded: boolean;
  registrations: PluginUIRegistration[];
  register: (pluginId: string, extensionPointId: string, factory: PluginUIRegistration['factory']) => void;
  refresh: () => Promise<void>;
}

const PluginUIContext = createContext<PluginUIRegistryState | null>(null);

function declareGlobalRuntime(
  register: (pluginId: string, extensionPointId: string, factory: PluginUIRegistration['factory']) => void,
  getApiForPlugin: (pluginId?: string) => PluginRuntimeAPI,
) {
  const runtime = {
    register: (extensionPointId: string, factory: PluginUIRegistration['factory']) => {
      const pluginId = runtime.__currentPluginId;
      register(pluginId || '__unknown__', extensionPointId, factory);
    },
    api: getApiForPlugin(),
    __currentPluginId: undefined as string | undefined,
  };
  (window as Window & { __HEURION_PLUGIN_RUNTIME__?: typeof runtime }).__HEURION_PLUGIN_RUNTIME__ = runtime;
}

export function PluginUIProvider({ children }: { children: React.ReactNode }) {
  const [registrations, setRegistrations] = useState<PluginUIRegistration[]>([]);
  const [loaded, setLoaded] = useState(false);
  const loadedBundles = useRef(new Set<string>());
  const isAuthenticated = api.hasToken();

  const register = useCallback(
    (pluginId: string, extensionPointId: string, factory: PluginUIRegistration['factory']) => {
      setRegistrations((prev) => {
        if (prev.some((r) => r.pluginId === pluginId && r.extensionPointId === extensionPointId)) {
          return prev;
        }
        return [...prev, { pluginId, pluginName: pluginId, extensionPointId, factory }];
      });
    },
    [],
  );

  const getApiForPlugin = useCallback(
    (pluginId?: string): PluginRuntimeAPI => ({
      fetch: async (path: string, init?: RequestInit) => {
        const r = await fetch(path, {
          ...init,
          headers: {
            ...(init?.headers || {}),
            Accept: 'application/json',
            'X-Nexus-Api-Version': String(api.getClientApiVersion?.() || 1),
            ...(api.getToken() ? { Authorization: `Bearer ${api.getToken()}` } : {}),
          },
        });
        if (!r.ok) throw new Error(`${path} -> ${r.status}`);
        if (r.status === 204) return undefined;
        return r.json();
      },
      getPluginId: () => pluginId,
    }),
    [],
  );

  useEffect(() => {
    declareGlobalRuntime(register, getApiForPlugin);
  }, [register, getApiForPlugin]);

  const refresh = useCallback(async () => {
    if (!isAuthenticated) {
      setRegistrations([]);
      setLoaded(true);
      return;
    }
    try {
      const { plugins } = await api.listInstalledUIPlugins();
      const runtime = (window as Window & { __HEURION_PLUGIN_RUNTIME__?: { __currentPluginId?: string } }).__HEURION_PLUGIN_RUNTIME__;
      for (const plugin of plugins) {
        const url = plugin.ui.bundle_url;
        if (loadedBundles.current.has(url)) continue;
        loadedBundles.current.add(url);
        if (runtime) {
          runtime.__currentPluginId = plugin.pluginId;
        }
        try {
          await import(/* @vite-ignore */ url);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(`Failed to load plugin UI bundle: ${url}`, err);
        } finally {
          if (runtime) {
            runtime.__currentPluginId = undefined;
          }
        }
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Failed to refresh plugin UI registry', err);
    } finally {
      setLoaded(true);
    }
  }, [isAuthenticated]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const value = useMemo(
    () => ({
      loaded,
      registrations,
      register,
      refresh,
    }),
    [loaded, registrations, register, refresh],
  );

  return <PluginUIContext.Provider value={value}>{children}</PluginUIContext.Provider>;
}

export function usePluginUIRegistry() {
  const ctx = useContext(PluginUIContext);
  if (!ctx) throw new Error('usePluginUIRegistry must be used within PluginUIProvider');
  return ctx;
}

export function usePluginRegistrations(extensionPointId: string): PluginUIRegistration[] {
  const { registrations } = usePluginUIRegistry();
  return useMemo(
    () => registrations.filter((r) => r.extensionPointId === extensionPointId),
    [registrations, extensionPointId],
  );
}
