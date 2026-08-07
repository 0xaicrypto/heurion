import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCountdown } from '../hooks/useCountdown';

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
