/**
 * LoginView — centred single-form, Claude Desktop aesthetic.
 *
 * M0 auth model (matches packages/desktop's LoginViewModel):
 *   - Single field: display name
 *   - Sign-in = POST /api/v1/auth/register {display_name} → {jwt_token}
 *   - No password (passkey + persistent user_id ships U2+)
 *
 * The "Continue without server" escape hatch stays — if the sidecar
 * fails to start we still want the dev to be able to poke around the UI.
 */

import { useState, type FormEvent } from 'react';
import { Button, Input } from './components/ui';
import { useAppState } from './store';
import { api, ApiError } from './lib/api-client';
import { BUILD_ID } from './lib/build-info';

export function LoginView() {
  const setToken           = useAppState((s) => s.setToken);
  const setStoreDisplayName= useAppState((s) => s.setDisplayName);
  const storedName         = useAppState((s) => s.displayName);
  const showToast          = useAppState((s) => s.showToast);

  // Pre-fill from store so returning users see their name when they
  // re-launch (the cached user_id still works behind the scenes).
  const [displayName, setDisplayName] = useState(storedName ?? '');
  const [busy, setBusy]               = useState(false);
  const [error, setError]             = useState<string | null>(null);
  const [allowMock, setAllowMock]     = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const name = displayName.trim();
    if (!name) {
      setError('Please enter your name.');
      return;
    }
    setBusy(true);
    try {
      // M0: password is unused on the backend side; we pass '' explicitly
      // to make the contract obvious for future readers.
      const r = await api.login(name, '');
      setToken(r.access_token);
      setStoreDisplayName(name);  // persist for avatar pill + pre-fill on re-launch
      showToast('Signed in', 'success');
    } catch (err) {
      if (err instanceof ApiError) {
        setError(
          err.status === 400
            ? 'Registration failed. Please try a different name.'
            : `Server error (${err.status}). Is the backend running?`,
        );
        setAllowMock(true);
      } else if (err instanceof TypeError) {
        // Network / fetch failure — typical when backend isn't running
        setError('Cannot reach server. Is the backend running on port 8001?');
        setAllowMock(true);
      } else {
        setError(String(err));
        setAllowMock(true);
      }
    } finally {
      setBusy(false);
    }
  }

  function continueWithoutServer() {
    setToken('dev-mock-token');
    showToast('Continuing in offline / mock mode', 'info');
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg">
      <div className="w-full max-w-sm px-6 py-12">
        <div className="mb-10 text-center">
          <h1 className="font-display text-display text-text-primary">Nexus</h1>
          <p className="mt-2 text-body text-text-secondary">
            Clinical workflow agent
          </p>
        </div>

        <form onSubmit={onSubmit} className="space-y-4 selectable">
          <div>
            <label
              htmlFor="displayName"
              className="mb-1.5 block text-caption font-medium text-text-secondary"
            >
              Your name
            </label>
            <Input
              id="displayName"
              type="text"
              autoComplete="name"
              required
              autoFocus
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Dr. JZ"
              disabled={busy}
            />
            <p className="mt-1.5 text-caption text-text-tertiary">
              M0: no password — a fresh user_id is minted on every sign-in.
              Passkey support ships later.
            </p>
          </div>

          {error && (
            <div className="rounded-sm border border-retract/40 bg-retract/10 px-3 py-2 text-caption text-retract">
              {error}
            </div>
          )}

          <Button
            type="submit"
            variant="primary"
            disabled={busy}
            className="w-full"
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>

          {allowMock && (
            <button
              type="button"
              onClick={continueWithoutServer}
              className="w-full pt-2 text-caption text-text-tertiary underline-offset-2 hover:text-text-secondary hover:underline"
            >
              Continue without server (dev / mock mode)
            </button>
          )}
        </form>

        <p className="mt-10 text-center text-caption text-text-tertiary">
          By signing in you agree to use Nexus as decision-support only,
          not as a substitute for clinical judgement.
        </p>

        <p
          className="mt-4 text-center font-mono text-[10px] text-text-tertiary/60 selectable"
          title="build identifier — please include this when reporting issues"
        >
          v{BUILD_ID}
        </p>
      </div>
    </div>
  );
}
