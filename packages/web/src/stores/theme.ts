import { create } from 'zustand';
import { persist } from 'zustand/middleware';

type ThemeMode = 'light' | 'dark' | 'system';

interface ThemeState {
  mode: ThemeMode;
  resolved: 'light' | 'dark';
  setMode: (mode: ThemeMode) => void;
  toggle: () => void;
}

function resolve(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'system') {
    if (typeof window === 'undefined') return 'light';
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return mode;
}

function apply(mode: 'light' | 'dark') {
  const root = document.documentElement;
  if (mode === 'dark') root.classList.add('dark');
  else root.classList.remove('dark');
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      mode: 'system',
      resolved: resolve('system'),
      setMode: (mode) => {
        const resolved = resolve(mode);
        apply(resolved);
        set({ mode, resolved });
      },
      toggle: () => {
        const next = get().resolved === 'dark' ? 'light' : 'dark';
        apply(next);
        set({ mode: next, resolved: next });
      },
    }),
    {
      name: 'nexus-theme',
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        const resolved = resolve(state.mode);
        apply(resolved);
        state.resolved = resolved;
      },
    },
  ),
);

export function initTheme() {
  const state = useThemeStore.getState();
  const resolved = resolve(state.mode);
  apply(resolved);
  state.resolved = resolved;
}
