import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Mail, X, Check } from 'lucide-react';
import { api } from '@/lib/api-client';
import { Button, Input } from '@/components/ui';

/**
 * #285: bind an email address — used both as a non-blocking first-login
 * banner and as a persistent settings-page entry. Code-based verification.
 */
export function EmailBindCard({ compact = false, onBound }: { compact?: boolean; onBound?: (email: string) => void }) {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [step, setStep] = useState<'input' | 'code'>('input');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const handleSend = async () => {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError(t('auth.invalidEmail', '邮箱格式不正确'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.sendVerificationCode(email, 'bind');
      setSent(true);
      setStep('code');
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleConfirm = async (code: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.bindEmail(email, code);
      onBound?.(res.email);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={compact ? 'flex flex-wrap items-center gap-2' : 'space-y-3'}>
      <div className="flex flex-wrap items-center gap-2">
        <Mail size={14} className="shrink-0 text-text-tertiary" />
        <Input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={t('auth.emailPlaceholder', 'you@example.com')}
          className="min-w-[200px] flex-1"
          disabled={step === 'code'}
          aria-label={t('auth.emailPlaceholder', 'you@example.com')}
        />
        {step === 'input' ? (
          <Button size="sm" onClick={handleSend} disabled={busy || !email}>
            {busy ? t('common.loading') : t('auth.sendCode', '发送验证码')}
          </Button>
        ) : (
          <CodeInput onConfirm={handleConfirm} busy={busy} />
        )}
      </div>
      {sent && step === 'input' && (
        <p className="text-xs text-text-tertiary">{t('auth.codeSent', '验证码已发送（10 分钟内有效）')}</p>
      )}
      {error && <p className="text-xs text-error">{error}</p>}
    </div>
  );
}

function CodeInput({ onConfirm, busy }: { onConfirm: (code: string) => void; busy: boolean }) {
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  return (
    <>
      <Input
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
        placeholder={t('auth.codePlaceholder', '6 位验证码')}
        className="w-32"
        aria-label={t('auth.codePlaceholder', '6 位验证码')}
      />
      <Button size="sm" onClick={() => onConfirm(code)} disabled={busy || code.length !== 6}>
        <Check size={13} className="mr-1" />
        {t('auth.confirm', '确认绑定')}
      </Button>
    </>
  );
}

/** Non-blocking first-login banner — dismissible. */
export function EmailBindBanner({ onBound, onDismiss }: { onBound?: (email: string) => void; onDismiss?: () => void }) {
  const { t } = useTranslation();
  const [bound, setBound] = useState(false);
  if (bound) return null;
  return (
    <div className="flex items-start gap-3 rounded-lg border border-accent/30 bg-accent/5 px-4 py-3">
      <Mail size={15} className="mt-0.5 shrink-0 text-accent" />
      <div className="min-w-0 flex-1">
        <p className="text-sm text-text-primary">{t('auth.bindBanner', '绑定邮箱后可以找回密码')}</p>
        <p className="mb-2 text-xs text-text-tertiary">{t('auth.bindBannerHint', '非必填，随时可以在设置中完成')}</p>
        <EmailBindCard compact onBound={(email) => { setBound(true); onBound?.(email); }} />
      </div>
      <button onClick={onDismiss} aria-label="Dismiss" className="text-text-tertiary hover:text-text-primary">
        <X size={14} />
      </button>
    </div>
  );
}
