import { useEffect, useRef, useState } from 'react';

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

  // done only once the countdown is actively synced and reached zero —
  // avoids a one-frame flash of the resend button right after a click.
  return { remaining, done: synced && remaining === 0 };
}
