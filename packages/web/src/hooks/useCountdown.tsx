import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * #352: countdown keyed by a nonce — bumping the nonce restarts the timer.
 * `nonce <= 0` means idle (resend button shown). `done` becomes true only
 * after the countdown is actively synced and reached zero, so there is no
 * one-frame flash of the resend button right after a restart.
 */
export function useCountdown(seconds: number, nonce: number) {
  const [remaining, setRemaining] = useState(nonce > 0 ? seconds : 0);
  const [synced, setSynced] = useState(nonce > 0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (nonce <= 0) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      setRemaining(0);
      setSynced(false);
      return;
    }
    setRemaining(seconds);
    setSynced(true);
    intervalRef.current = setInterval(() => {
      setRemaining((r) => Math.max(0, r - 1));
    }, 1000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [nonce, seconds]);

  return { remaining, done: synced && remaining === 0 };
}

/** #352: resend control — countdown + button. */
export function ResendControl({ seconds = 60, onResend, busy }: { seconds?: number; onResend: () => void; busy?: boolean }) {
  const { t } = useTranslation();
  const [nonce, setNonce] = useState(1);
  const { remaining, done } = useCountdown(seconds, nonce);

  return done ? (
    <button
      type="button"
      onClick={() => {
        onResend();
        setNonce((n) => n + 1);
      }}
      disabled={busy}
      className="text-xs font-medium text-accent hover:underline disabled:opacity-50"
    >
      {busy ? '…' : t('auth.resendCode', '重新发送验证码')}
    </button>
  ) : (
    <span className="text-xs text-text-tertiary">
      {t('auth.resendIn', '重新发送（{{s}}s）', { s: remaining })}
    </span>
  );
}
