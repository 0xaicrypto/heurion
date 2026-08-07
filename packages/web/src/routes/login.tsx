import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '@/lib/api-client';
import { useAuthStore } from '@/stores/auth';
import { Alert, Button, Input } from '@/components/ui';

export function LoginPage() {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith('zh');
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const isRegister = searchParams.get('mode') === 'register';
  const isReset = searchParams.get('mode') === 'reset';

  const from = (location.state as { from?: { pathname: string } })?.from?.pathname || '/app/today';

  const { isAuthenticated, setSession } = useAuthStore();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // ── reset-password flow (mode=reset) ──────────────────────────────
  const [resetEmail, setResetEmail] = useState('');
  const [resetCode, setResetCode] = useState('');
  const [resetPassword, setResetPassword] = useState('');
  const [resetStep, setResetStep] = useState<'input' | 'code'>('input');
  const [resetDone, setResetDone] = useState(false);

  useEffect(() => {
    if (isAuthenticated) navigate(from, { replace: true });
  }, [isAuthenticated, navigate, from]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const session = isRegister
        ? await api.register({ username, password, displayName })
        : await api.login(username, password);
      setSession(session);
      navigate(from, { replace: true });
    } catch (err) {
      if (err instanceof ApiError) setError(err.messageText);
      else if (err instanceof Error) setError(err.message);
      else setError(t('auth.unexpectedError'));
    } finally {
      setLoading(false);
    }
  };

  const toggleMode = () => {
    setSearchParams(isRegister ? {} : { mode: 'register' });
    setError(null);
  };

  const handleSendReset = async () => {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(resetEmail)) {
      setError(t('auth.invalidEmail', '邮箱格式不正确'));
      return;
    }
    setError(null);
    setLoading(true);
    try {
      await api.sendVerificationCode(resetEmail, 'reset');
      setResetStep('code');
    } catch (err) {
      if (err instanceof ApiError) setError(err.messageText);
      else if (err instanceof Error) setError(err.message);
      else setError(t('auth.unexpectedError'));
    } finally {
      setLoading(false);
    }
  };

  const handleResetPassword = async () => {
    if (resetPassword.length < 8) {
      setError(t('auth.passwordTooShort', '密码至少 8 位'));
      return;
    }
    setError(null);
    setLoading(true);
    try {
      await api.resetPassword(resetEmail, resetCode, resetPassword);
      setResetDone(true);
    } catch (err) {
      if (err instanceof ApiError) setError(err.messageText);
      else if (err instanceof Error) setError(err.message);
      else setError(t('auth.unexpectedError'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-md space-y-6 rounded-lg border border-border bg-surface-elevated p-8 shadow-lg">
        <div className="text-center">
          <img src="/heurion-logo.svg" alt="Heurion" className="mx-auto mb-4 h-12 w-auto dark:hidden" />
          <img src="/heurion-logo-dark.svg" alt="Heurion" className="mx-auto mb-4 hidden h-12 w-auto dark:block" />
          <h1 className="text-2xl font-bold text-text-primary">
            {isRegister ? t('auth.createAccount') : t('auth.welcomeBack')}
          </h1>
          <p className="mt-2 text-sm text-text-secondary">
            {isRegister ? t('auth.signUpPrompt') : t('auth.signInPrompt')}
          </p>
        </div>

        {error && <Alert variant="error">{error}</Alert>}

        {isReset ? (
          <div className="space-y-4">
            {resetDone ? (
              <div className="space-y-4">
                <div className="rounded-lg border border-success/30 bg-success/5 px-4 py-3 text-sm text-text-primary">
                  {t('auth.resetDone', '密码已重置，请使用新密码登录。')}
                </div>
                <Button className="w-full" onClick={() => { setSearchParams({}); setResetDone(false); }}>
                  {t('common.login')}
                </Button>
              </div>
            ) : (
              <>
                <div>
                  <label className="block text-sm font-medium text-text-secondary">{t('auth.resetEmailLabel', '绑定邮箱')}</label>
                  <Input
                    type="email"
                    required
                    value={resetEmail}
                    onChange={(e) => setResetEmail(e.target.value)}
                    disabled={resetStep === 'code'}
                    placeholder="you@example.com"
                  />
                </div>
                {resetStep === 'input' ? (
                  <Button className="w-full" onClick={handleSendReset} isLoading={loading}>
                    {t('auth.sendCode', '发送验证码')}
                  </Button>
                ) : (
                  <>
                    <div>
                      <label className="block text-sm font-medium text-text-secondary">{t('auth.codePlaceholder', '6 位验证码')}</label>
                      <Input
                        value={resetCode}
                        onChange={(e) => setResetCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                        placeholder={t('auth.codePlaceholder', '6 位验证码')}
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-text-secondary">{t('auth.newPassword', '新密码')}</label>
                      <Input
                        type="password"
                        required
                        value={resetPassword}
                        onChange={(e) => setResetPassword(e.target.value)}
                        placeholder={t('auth.passwordMinHint', '至少 8 位')}
                      />
                    </div>
                    <Button className="w-full" onClick={handleResetPassword} isLoading={loading}>
                      {t('auth.resetPassword', '重置密码')}
                    </Button>
                  </>
                )}
                <p className="text-center text-sm">
                  <button type="button" onClick={() => setSearchParams({})} className="text-text-tertiary hover:text-text-secondary">
                    ← {t('auth.backToLogin', '返回登录')}
                  </button>
                </p>
              </>
            )}
          </div>
        ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          {isRegister && (
            <div>
              <label className="block text-sm font-medium text-text-secondary">{t('auth.displayName')}</label>
              <Input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder={t('auth.displayNamePlaceholder')}
              />
            </div>
          )}
          <div>
            <label className="block text-sm font-medium text-text-secondary">{t('auth.username')}</label>
            <Input type="text" required value={username} onChange={(e) => setUsername(e.target.value)} />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-secondary">{t('auth.password')}</label>
            <Input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <Button type="submit" isLoading={loading} className="w-full">
            {isRegister ? t('common.register') : t('common.login')}
          </Button>
        </form>
        )}

        {!isReset && (
        <p className="text-center text-sm text-text-secondary">
          {isRegister ? t('auth.alreadyHaveAccount') : t('auth.noAccount')}{' '}
          <button type="button" onClick={toggleMode} className="font-medium text-accent hover:underline">
            {isRegister ? t('common.login') : t('common.register')}
          </button>
        </p>
        )}

        {!isRegister && !isReset && (
          <p className="text-center text-sm">
            <button
              type="button"
              onClick={() => { setSearchParams({ mode: 'reset' }); setError(null); }}
              className="text-text-tertiary hover:text-text-secondary"
            >
              {t('auth.forgotPassword', '忘记密码？')}
            </button>
          </p>
        )}

        {isRegister && (
          <p className="text-center text-xs text-text-tertiary">
            {isZh ? '首个注册账户将自动获得管理员权限。' : 'The first registered account gets administrator privileges.'}
          </p>
        )}

        <p className="text-center text-sm">
          <Link to="/" className="text-text-tertiary hover:text-text-secondary">
            ← {t('common.back')}
          </Link>
        </p>
      </div>
    </div>
  );
}
