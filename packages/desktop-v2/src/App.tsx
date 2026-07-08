import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useAppState } from './store';
import { api } from './lib/api-client';
import { useT } from './lib/i18n';
import { useGlobalShortcuts } from './lib/keyboard';
import { GlobalHeader, PatientsSidebar, ModeTabs } from './components/layout';
import { CommandPalette, NewPatientDialog, ToastStrip, EmailComposerDialog } from './components/overlays';
import { ContextRailContent } from './components/memory-ui';
import {
  PractitionerHasLearnedView,
  SettingsDataView,
} from './components/full-screen-overlays';
import { LoginView } from './login';
import { BootGate } from './boot-gate';
import {
  TodayMode, PatientMode, EncounterMode,
  ImagingMode, LabsMode, MemoryMode, ReportMode,
} from './modes';
import { ResearchWorkspace } from './components/research-workspace';

function ActiveMode() {
  const mode = useAppState((s) => s.activeMode);
  switch (mode) {
    case 'today':     return <TodayMode />;
    case 'patient':   return <PatientMode />;
    case 'encounter': return <EncounterMode />;
    case 'imaging':   return <ImagingMode />;
    case 'labs':      return <LabsMode />;
    case 'memory':    return <MemoryMode />;
    case 'report':    return <ReportMode />;
    case 'research':  return <ResearchWorkspace />;
  }
}

function ContextRail() {
  const open = useAppState((s) => s.contextRailOpen);
  const content = useAppState((s) => s.contextRailContent);
  if (!open) return null;
  if (content.kind !== 'closed') {
    return <ContextRailContent />;
  }
  return (
    <aside className="flex h-full w-[320px] shrink-0 flex-col border-l border-border bg-bg p-4">
      <div className="mb-3 text-caption font-medium uppercase tracking-wider text-text-tertiary">
        Context
      </div>
      <div className="text-body text-text-secondary">
        Click a citation in any message to see its verbatim source +
        provenance trail here.
      </div>
    </aside>
  );
}

/**
 * Banner shown across the top of MainShell when the backend reports
 * that the active LLM provider has no API key. We probe once on login
 * and show the banner persistently until the medic either configures
 * a key (Settings · LLM writes it; refreshLlmStatus is called on save
 * and clears the advisory) or dismisses for the session.
 *
 * The user can't dismiss permanently — they'd lose track of why chat
 * is broken — but they can collapse the banner if they want to focus
 * on non-LLM features (patient roster, imaging upload).
 */
function LlmKeyReminderBanner() {
  const t              = useT();
  const status         = useAppState((s) => s.llmStatus);
  const checked        = useAppState((s) => s.llmStatusChecked);
  const openSettings   = useAppState((s) => s.openSettingsOverlay);

  if (!checked || !status || !status.advisory) return null;

  // The backend's advisory string is provider-specific ("Gemini API key
  // not set" / "OpenAI API key not set"). We surface it verbatim — that
  // text isn't part of the i18n dictionary because it's diagnostic data,
  // not UI chrome. The CTA + tail sentence ARE translated.
  return (
    <div className="flex items-center justify-between gap-3 border-b border-caution/40 bg-caution/10 px-5 py-2 text-caption text-caution">
      <div className="flex min-w-0 items-center gap-2">
        <AlertTriangle size={14} className="shrink-0" />
        <span className="truncate">
          {status.advisory}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button
          onClick={openSettings}
          className="rounded-sm border border-caution/40 px-2 py-0.5 hover:bg-caution/20"
        >
          {t('banner.llmCta')}
        </button>
      </div>
    </div>
  );
}

/**
 * Top-of-page 患者 | 研究 segmented control (decisions D1 + D14).
 * Defaults to 'research' on first launch. Tracks the visual mock at
 * docs/design/visual-mock/Research Workspace.dc.html.
 */
function WorkspaceSwitcher() {
  const ws    = useAppState((s) => s.activeWorkspace);
  const setWs = useAppState((s) => s.setActiveWorkspace);
  const btn = (key: 'patient' | 'research', label: string, sub: string) => (
    <button
      onClick={() => setWs(key)}
      title={sub}
      className={`px-3.5 py-1 text-sm rounded-md transition-colors ${
        ws === key
          ? 'bg-[#46C0D6] text-[#06252c] shadow-sm font-medium'
          : 'text-text-secondary hover:bg-gray-100 dark:hover:bg-gray-800'
      }`}
    >
      {label}
    </button>
  );
  return (
    <div className="border-b border-border bg-bg px-4 py-1.5 flex items-center gap-1">
      <span className="text-[10px] tracking-[0.18em] uppercase text-text-tertiary mr-2 font-mono">
        Workspace
      </span>
      <div className="inline-flex bg-surface border border-border rounded-lg p-0.5 gap-0.5">
        {btn('patient',  '患者', 'ad-hoc 单患者视角')}
        {btn('research', '研究', '研究优先工作台（默认）')}
      </div>
    </div>
  );
}

/**
 * Body switches between Patient layout (current PatientsSidebar / mode
 * tabs / ActiveMode / ContextRail) and the new ResearchWorkspace.
 */
function WorkspaceBody() {
  const ws = useAppState((s) => s.activeWorkspace);
  if (ws === 'research') {
    return <ResearchWorkspace />;
  }
  return (
    <>
      <PatientsSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <ModeTabs />
        <main className="min-h-0 flex-1 overflow-y-auto">
          <ActiveMode />
        </main>
      </div>
      <ContextRail />
    </>
  );
}

function MainShell() {
  const token            = useAppState((s) => s.token);
  const refreshLlmStatus = useAppState((s) => s.refreshLlmStatus);

  // Probe the LLM settings once we have a token. This is the "on
  // startup, if there's no API key, remind the user" hook the medic
  // asked for. Re-probe whenever the token changes (sign-in flow).
  useEffect(() => {
    if (token) refreshLlmStatus();
  }, [token, refreshLlmStatus]);

  return (
    <div className="flex h-screen flex-col bg-bg text-text-primary">
      <GlobalHeader />
      <WorkspaceSwitcher />
      <LlmKeyReminderBanner />
      <div className="flex min-h-0 flex-1">
        <WorkspaceBody />
      </div>

      {/* Overlays — rendered outside the layout flow */}
      <CommandPalette />
      <NewPatientDialog />
      <PractitionerHasLearnedView />
      <SettingsDataView />
      <EmailComposerDialog />
      <ToastStrip />
    </div>
  );
}

export default function App() {
  const token         = useAppState((s) => s.token);
  const setToken      = useAppState((s) => s.setToken);
  const setActiveUserId = useAppState((s) => s.setActiveUserId);
  const setIdentities   = useAppState((s) => s.setIdentities);
  const bootHydrated  = useAppState((s) => s.bootHydrated);
  const logout        = useAppState((s) => s.logout);
  const showToast     = useAppState((s) => s.showToast);
  const [autoLoginAttempted, setAutoLoginAttempted] = useState(false);
  const [autoLoginFailed, setAutoLoginFailed] = useState(false);

  useGlobalShortcuts();

  // The api-client fires this when a 401 fails to recover via the
  // cached user_id (e.g. server's user table got reset, or first
  // sign-in on a new machine). Wiping the token bounces us to the
  // LoginView via the conditional render below.
  useEffect(() => {
    const handler = () => logout();
    window.addEventListener('nexus:auth-expired', handler);
    return () => window.removeEventListener('nexus:auth-expired', handler);
  }, [logout]);

  // F22 (Path C) — silent auto-login on app boot. Reads user_id from
  // the OS keychain (or legacy localStorage) and POSTs /auth/login;
  // if no credential exists yet, mints a fresh account via
  // /auth/register and stores the new user_id in keychain.
  //
  // On a healthy install the medic NEVER sees the LoginView — they
  // launch the app, the sidecar boots, the auto-login fires, the
  // workspace renders. The LoginView only shows if auto-login fails
  // (sidecar unreachable / network / keychain hang) so the medic
  // can troubleshoot or fall back to the manual passkey flow.
  //
  // F23 — DEADLINE. The very first build that observed a blank
  // window had Rust's keyring crate either panicking or blocking on
  // a macOS Keychain access prompt. tauriInvoke didn't time out, the
  // promise never settled, and the inner conditional rendered
  // ``null`` forever. We now race autoLogin against a 10 s deadline
  // and treat the deadline as a failure that falls through to
  // LoginView — the medic always gets SOME interactive surface.
  useEffect(() => {
    if (token) return;                  // already signed in
    if (autoLoginAttempted) return;     // try once per mount

    let cancelled = false;
    setAutoLoginAttempted(true);

    const DEADLINE_MS = 10_000;
    const deadline = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`auto-login deadline (${DEADLINE_MS}ms)`)),
        DEADLINE_MS,
      ),
    );

    Promise.race([api.autoLogin(), deadline]).then(
      (r) => {
        if (cancelled) return;
        setToken(r.access_token);
        // F26.2 — populate picker state from bootstrap response so
        // the avatar dropdown is ready the moment the medic clicks it.
        setActiveUserId(r.activeUserId);
        setIdentities(r.identities);
        if (r.isNewAccount) {
          showToast('Welcome to Nexus — a fresh account was created on this device.', 'info');
        } else if (r.recoveredFromDb) {
          // §4.4.5 — banner explaining the rebuild so the medic
          // understands "all data is back" rather than panicking.
          showToast(
            `Nexus 检测到 identity.json 异常（已从数据库重建）。恢复了 ${r.identities.length} 个身份。`,
            'info',
          );
        }
      },
      (e) => {
        if (cancelled) return;
        console.warn('[auto-login] failed; falling back to LoginView:', e);
        setAutoLoginFailed(true);
      },
    );
    return () => { cancelled = true; };
  }, [token, autoLoginAttempted, setToken, setActiveUserId, setIdentities, showToast]);

  // F23 — second safety net. The useEffect above sets autoLoginFailed
  // on its own deadline, but if THAT mechanism somehow also fails
  // (e.g. setTimeout starved by main-thread block), this dumb timer
  // bounces the user to the LoginView after 12 s of black screen.
  // Belt + braces.
  useEffect(() => {
    if (token || autoLoginFailed) return;
    const t = setTimeout(() => {
      if (!token && !autoLoginFailed) {
        console.warn('[auto-login] hard fallback: 12 s elapsed with no token — forcing LoginView');
        setAutoLoginFailed(true);
      }
    }, 12_000);
    return () => clearTimeout(t);
  }, [token, autoLoginFailed]);

  // Avoid a one-frame login flicker before hydrate completes.
  if (!bootHydrated) return null;

  // BootGate blocks the LoginView/MainShell render until the FastAPI
  // sidecar's /healthz returns 200. Without this, the user could fill
  // in the login form during the 3–15 s Alembic-migration window and
  // see a "Cannot reach server" error fired against a half-booted
  // process.
  //
  // F23 — NEVER render ``null`` as the inner child. A black window
  // with no UI is the worst possible state for the medic; if we
  // can't tell which view to show, default to LoginView so they at
  // least have a recover surface (passkey, display-name auth,
  // diagnostics panel). The auto-login still races and will swap
  // in MainShell the moment it returns a token.
  return (
    <BootGate>
      {token ? <MainShell /> : <LoginView />}
    </BootGate>
  );
}
