import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
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

export interface PluginRuntimeContext {
  userId?: string;
  workspaceId?: string;
  patientHash?: string;
  route?: string;
}

export interface PluginRuntimeEvents {
  on: (event: string, handler: (payload: unknown) => void) => () => void;
  emit: (event: string, payload: unknown) => void;
}

export interface PluginRuntimeStorage {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: unknown) => Promise<void>;
}

export interface PluginRuntimeUI {
  toast: (message: string, type?: 'info' | 'success' | 'error') => void;
  modal: (config: {
    title?: string;
    message: string;
    confirm?: string;
    cancel?: string;
  }) => Promise<boolean>;
  navigate: (path: string) => void;
}

export interface HeurionPluginRuntime {
  register: (
    extensionPointId: string,
    factory: (ctx: unknown) => HTMLElement | Promise<HTMLElement>,
  ) => void;
  api: PluginRuntimeAPI;
  context: PluginRuntimeContext;
  events: PluginRuntimeEvents;
  storage: PluginRuntimeStorage;
  ui: PluginRuntimeUI;
  __currentPluginId?: string;
}

export interface IframeFallbackEntry {
  pluginId: string;
  pluginName: string;
  extensionPointId: string;
  url: string;
}

export interface PluginUIRegistryState {
  loaded: boolean;
  registrations: PluginUIRegistration[];
  iframeFallbacks: IframeFallbackEntry[];
  register: (
    pluginId: string,
    extensionPointId: string,
    factory: PluginUIRegistration['factory'],
  ) => void;
  refresh: () => Promise<void>;
}

const PluginUIContext = createContext<PluginUIRegistryState | null>(null);

function decodeUserIdFromToken(token: string | null): string | undefined {
  if (!token) return undefined;
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return payload.userId || payload.sub;
  } catch {
    return undefined;
  }
}

function getStorageKey(pluginId: string, key: string): string {
  return `heurion-plugin:${pluginId}:${key}`;
}

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

function showToast(message: string, type: 'info' | 'success' | 'error' = 'info') {
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

function showModal(config: {
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

function navigate(path: string) {
  window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

async function verifyIntegrity(text: string, integrity: string): Promise<boolean> {
  if (!integrity) return true;
  if (!crypto.subtle) {
    // Non-secure contexts (e.g. some test environments) cannot verify.
    console.warn('crypto.subtle unavailable; skipping UI plugin integrity verification');
    return true;
  }
  const [algo, expectedBase64] = integrity.split('-');
  const algorithm = algo === 'sha256' ? 'SHA-256' : algo === 'sha384' ? 'SHA-384' : algo === 'sha512' ? 'SHA-512' : null;
  if (!algorithm) return false;
  try {
    const encoder = new TextEncoder();
    const hashBuffer = await crypto.subtle.digest(algorithm, encoder.encode(text));
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const actualBase64 = btoa(hashArray.map((b) => String.fromCharCode(b)).join(''));
    return actualBase64 === expectedBase64;
  } catch {
    return false;
  }
}

function declareGlobalRuntime(
  register: (pluginId: string, extensionPointId: string, factory: PluginUIRegistration['factory']) => void,
  getApiForPlugin: (pluginId?: string) => PluginRuntimeAPI,
  context: PluginRuntimeContext,
  events: PluginRuntimeEvents,
  storage: PluginRuntimeStorage,
  ui: PluginRuntimeUI,
) {
  const runtime: HeurionPluginRuntime = {
    register: (extensionPointId, factory) => {
      const pluginId = runtime.__currentPluginId;
      register(pluginId || '__unknown__', extensionPointId, factory);
    },
    api: getApiForPlugin(),
    context,
    events,
    storage,
    ui,
    __currentPluginId: undefined,
  };
  (window as Window & { __HEURION_PLUGIN_RUNTIME__?: HeurionPluginRuntime }).__HEURION_PLUGIN_RUNTIME__ = runtime;
}

export function PluginUIProvider({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const [registrations, setRegistrations] = useState<PluginUIRegistration[]>([]);
  const [iframeFallbacks, setIframeFallbacks] = useState<IframeFallbackEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const loadedBundles = useRef(new Set<string>());
  const isAuthenticated = api.hasToken();

  const eventListeners = useRef(new Map<string, Set<(payload: unknown) => void>>());

  const context = useMemo<PluginRuntimeContext>(() => {
    const token = api.getToken();
    return {
      userId: decodeUserIdFromToken(token),
      route: location.pathname,
    };
  }, [location.pathname]);

  const events = useMemo<PluginRuntimeEvents>(
    () => ({
      on: (event, handler) => {
        let set = eventListeners.current.get(event);
        if (!set) {
          set = new Set();
          eventListeners.current.set(event, set);
        }
        set.add(handler);
        return () => set?.delete(handler);
      },
      emit: (event, payload) => {
        eventListeners.current.get(event)?.forEach((handler) => {
          try {
            handler(payload);
          } catch (err) {
            console.error(`Plugin event handler error for ${event}`, err);
          }
        });
      },
    }),
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

  const storage = useMemo<PluginRuntimeStorage>(
    () => ({
      get: async (key: string) => {
        const pluginId = (window as Window & { __HEURION_PLUGIN_RUNTIME__?: HeurionPluginRuntime }).__HEURION_PLUGIN_RUNTIME__?.__currentPluginId;
        if (!pluginId) return undefined;
        try {
          const raw = localStorage.getItem(getStorageKey(pluginId, key));
          return raw === null ? undefined : JSON.parse(raw);
        } catch {
          return undefined;
        }
      },
      set: async (key: string, value: unknown) => {
        const pluginId = (window as Window & { __HEURION_PLUGIN_RUNTIME__?: HeurionPluginRuntime }).__HEURION_PLUGIN_RUNTIME__?.__currentPluginId;
        if (!pluginId) return;
        try {
          localStorage.setItem(getStorageKey(pluginId, key), JSON.stringify(value));
        } catch {
          // ignore
        }
      },
    }),
    [],
  );

  const ui = useMemo<PluginRuntimeUI>(
    () => ({
      toast: showToast,
      modal: showModal,
      navigate,
    }),
    [],
  );

  useEffect(() => {
    declareGlobalRuntime(
      (pluginId, extensionPointId, factory) => {
        setRegistrations((prev) => {
          if (prev.some((r) => r.pluginId === pluginId && r.extensionPointId === extensionPointId)) {
            return prev;
          }
          return [...prev, { pluginId, pluginName: pluginId, extensionPointId, factory }];
        });
      },
      getApiForPlugin,
      context,
      events,
      storage,
      ui,
    );
  }, [context, events, getApiForPlugin, storage, ui]);

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

  const refresh = useCallback(async () => {
    if (!isAuthenticated) {
      setRegistrations([]);
      setIframeFallbacks([]);
      setLoaded(true);
      return;
    }
    try {
      const { plugins } = await api.listInstalledUIPlugins();
      const runtime = (
        window as Window & { __HEURION_PLUGIN_RUNTIME__?: HeurionPluginRuntime }
      ).__HEURION_PLUGIN_RUNTIME__;

      const newFallbacks: IframeFallbackEntry[] = [];

      for (const plugin of plugins) {
        const url = plugin.ui.bundle_url;
        if (loadedBundles.current.has(url)) continue;
        loadedBundles.current.add(url);

        if (plugin.ui.integrity) {
          try {
            const res = await fetch(url);
            const text = await res.text();
            const ok = await verifyIntegrity(text, plugin.ui.integrity);
            if (!ok) {
              console.error(`UI plugin ${plugin.pluginId} integrity mismatch; falling back to iframe`);
              for (const point of plugin.ui.extension_points) {
                newFallbacks.push({
                  pluginId: plugin.pluginId,
                  pluginName: plugin.name,
                  extensionPointId: point.id,
                  url,
                });
              }
              continue;
            }
            const blob = new Blob([text], { type: 'application/javascript' });
            const blobUrl = URL.createObjectURL(blob);
            if (runtime) runtime.__currentPluginId = plugin.pluginId;
            try {
              await import(/* @vite-ignore */ blobUrl);
            } catch (err) {
              console.error(`Failed to load verified UI plugin bundle: ${url}`, err);
            } finally {
              if (runtime) runtime.__currentPluginId = undefined;
              URL.revokeObjectURL(blobUrl);
            }
          } catch (err) {
            console.error(`Failed to verify UI plugin bundle: ${url}`, err);
          }
          continue;
        }

        if (runtime) runtime.__currentPluginId = plugin.pluginId;
        try {
          await import(/* @vite-ignore */ url);
        } catch (err) {
          console.error(`Failed to load plugin UI bundle: ${url}`, err);
        } finally {
          if (runtime) runtime.__currentPluginId = undefined;
        }
      }

      if (newFallbacks.length > 0) {
        setIframeFallbacks((prev) => [...prev, ...newFallbacks]);
      }
    } catch (err) {
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
      iframeFallbacks,
      register,
      refresh,
    }),
    [loaded, registrations, iframeFallbacks, register, refresh],
  );

  return <PluginUIContext.Provider value={value}>{children}</PluginUIContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function usePluginUIRegistry() {
  const ctx = useContext(PluginUIContext);
  if (!ctx) throw new Error('usePluginUIRegistry must be used within PluginUIProvider');
  return ctx;
}

// eslint-disable-next-line react-refresh/only-export-components
export function usePluginRegistrations(extensionPointId: string): PluginUIRegistration[] {
  const { registrations } = usePluginUIRegistry();
  return useMemo(
    () => registrations.filter((r) => r.extensionPointId === extensionPointId),
    [registrations, extensionPointId],
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function usePluginIframeFallbacks(extensionPointId: string): IframeFallbackEntry[] {
  const { iframeFallbacks } = usePluginUIRegistry();
  return useMemo(
    () => iframeFallbacks.filter((f) => f.extensionPointId === extensionPointId),
    [iframeFallbacks, extensionPointId],
  );
}
