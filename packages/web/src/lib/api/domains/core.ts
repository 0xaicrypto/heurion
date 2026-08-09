import type { PublicConfig } from '../../types';
import { useAuthStore } from '@/stores/auth';

export const CLIENT_API_VERSION = 1;

// #460: auth is single-sourced in the zustand persist store (nexus-auth).
// These keys are kept only for backward-compat reads by legacy call sites
// (labs.tsx / research-detail.tsx still read them directly).
const STORAGE_KEY_TOKEN = 'nexus.auth.token';
const STORAGE_KEY_USER_ID = 'nexus.auth.user_id';
const STORAGE_KEY_DISPLAY_NAME = 'nexus.auth.display_name';

function storageGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function storageSet(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
}
function storageRemove(key: string): void {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: string,
    public path: string,
  ) {
    super(`${path} → ${status}: ${body}`);
    this.name = 'ApiError';
  }

  get code(): string | null {
    try {
      const parsed = JSON.parse(this.body);
      return parsed.error?.code ?? parsed.code ?? null;
    } catch { return null; }
  }

  get messageText(): string {
    try {
      const parsed = JSON.parse(this.body);
      const err = parsed.error;
      if (typeof err === 'string') return err;
      return err?.message ?? parsed.message ?? parsed.detail ?? this.body;
    } catch { return this.body || this.statusText; }
  }

  private get statusText(): string {
    return `HTTP ${this.status}`;
  }
}

export class ApiCore {
  /** #460: token is read from the single auth store (zustand persist). */
  private getTokenFromStore(): string | null {
    return useAuthStore.getState().token;
  }

  /** #347: persist a fresh auth session (token + user identity). */
  protected storeSession(data: { jwt_token: string; user_id: string; display_name: string }) {
    storageSet(STORAGE_KEY_TOKEN, data.jwt_token);
    storageSet(STORAGE_KEY_USER_ID, data.user_id);
    storageSet(STORAGE_KEY_DISPLAY_NAME, data.display_name);
    useAuthStore.getState().setSession({
      token: data.jwt_token,
      userId: data.user_id,
      role: 'user',
      displayName: data.display_name,
      expiresInSeconds: 0,
    });
  }

  setToken(t: string | null) {
    if (t) {
      storageSet(STORAGE_KEY_TOKEN, t);
      useAuthStore.setState({ token: t, isAuthenticated: true });
    } else {
      storageRemove(STORAGE_KEY_TOKEN);
      useAuthStore.getState().clearSession();
    }
  }

  hasToken() { return this.getTokenFromStore() !== null; }
  getToken() { return this.getTokenFromStore() || storageGet(STORAGE_KEY_TOKEN); }
  getClientApiVersion() { return CLIENT_API_VERSION; }

  /** #460: clear everything (store + legacy keys) in ONE place. */
  logout() {
    storageRemove(STORAGE_KEY_TOKEN);
    storageRemove(STORAGE_KEY_USER_ID);
    storageRemove(STORAGE_KEY_DISPLAY_NAME);
    useAuthStore.getState().clearSession();
  }

  protected headers(extra?: HeadersInit): Headers {
    const h = new Headers(extra);
    h.set('Accept', 'application/json');
    h.set('X-Nexus-Api-Version', String(CLIENT_API_VERSION));
    const token = this.getTokenFromStore() || storageGet(STORAGE_KEY_TOKEN);
    if (token) h.set('Authorization', `Bearer ${token}`);
    return h;
  }

  protected async fetch<T>(path: string, init?: RequestInit): Promise<T> {
    const h = this.headers(init?.headers);
    if (init?.body && !h.has('Content-Type')) h.set('Content-Type', 'application/json');

    const r = await fetch(path, { ...init, headers: h });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      const err = new ApiError(r.status, text || r.statusText, path);
      if (r.status === 401 && !path.startsWith('/api/v1/auth/')) {
        this.logout();
        window.dispatchEvent(new CustomEvent('nexus:auth-expired'));
      }
      throw err;
    }
    if (r.status === 204) return undefined as unknown as T;
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('json')) {
      const text = await r.text().catch(() => '');
      throw new ApiError(r.status, `Expected JSON but got ${ct}: ${text.slice(0, 200)}`, path);
    }
    return r.json() as Promise<T>;
  }

  /* ────────────────────────── health / config ────────────────────────── */

  async health(): Promise<'ok' | 'unreachable' | 'unhealthy'> {
    try {
      const r = await fetch('/healthz', {
        method: 'GET',
        signal: AbortSignal.timeout(2500),
      });
      return r.ok ? 'ok' : 'unhealthy';
    } catch {
      return 'unreachable';
    }
  }

  async getPublicConfig(): Promise<PublicConfig> {
    return this.fetch<PublicConfig>('/api/v1/config');
  }

}
