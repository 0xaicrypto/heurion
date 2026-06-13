/**
 * Global keyboard shortcut hook.
 *
 * Per docs/design/nexus-ux-redesign.md §3 ("keyboard-first for the senior
 * persona") and §5 (⌘. for context rail, ⌘K for command palette).
 *
 * Intentionally tiny — listen on window keydown, dispatch on match.
 * No external library; key-binding state lives in the store.
 */

import { useEffect } from 'react';
import { useAppState } from '../store';

export interface KeyBinding {
  key: string;          // KeyboardEvent.key (e.g. 'k', '.', 'b', 'Escape')
  meta?: boolean;       // ⌘ on macOS, ⊞ on Windows / Linux Super
  shift?: boolean;
  alt?: boolean;
  action: () => void;
  description: string;  // surfaced in the help overlay (future)
}

/**
 * Wire the app-wide shortcuts. Call once from App.tsx.
 *
 * Shortcuts:
 *   ⌘K  → toggle command palette
 *   ⌘.  → toggle context rail
 *   ⌘B  → toggle patients sidebar
 *   ⌘N  → new patient dialog
 *   Esc → close any open overlay
 */
export function useGlobalShortcuts() {
  const openCommandPalette  = useAppState((s) => s.openCommandPalette);
  const closeCommandPalette = useAppState((s) => s.closeCommandPalette);
  const toggleContextRail   = useAppState((s) => s.toggleContextRail);
  const toggleSidebar       = useAppState((s) => s.toggleSidebar);
  const openNewPatientDialog  = useAppState((s) => s.openNewPatientDialog);
  const closeNewPatientDialog = useAppState((s) => s.closeNewPatientDialog);

  useEffect(() => {
    function isTypingInForm(e: KeyboardEvent): boolean {
      const t = e.target as HTMLElement | null;
      if (!t) return false;
      const tag = t.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || t.isContentEditable) {
        // Allow Escape and ⌘K to pass through even while typing
        return !(e.key === 'Escape' || (e.metaKey && e.key === 'k'));
      }
      return false;
    }

    function onKey(e: KeyboardEvent) {
      if (isTypingInForm(e)) return;

      const meta = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();

      if (meta && k === 'k') {
        e.preventDefault();
        const open = useAppState.getState().commandPaletteOpen;
        if (open) closeCommandPalette();
        else openCommandPalette();
        return;
      }

      if (meta && k === '.') {
        e.preventDefault();
        toggleContextRail();
        return;
      }

      if (meta && k === 'b') {
        e.preventDefault();
        toggleSidebar();
        return;
      }

      if (meta && k === 'n') {
        e.preventDefault();
        openNewPatientDialog();
        return;
      }

      if (e.key === 'Escape') {
        const s = useAppState.getState();
        if (s.commandPaletteOpen) closeCommandPalette();
        else if (s.newPatientDialogOpen) closeNewPatientDialog();
      }
    }

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openCommandPalette, closeCommandPalette, toggleContextRail, toggleSidebar, openNewPatientDialog, closeNewPatientDialog]);
}
