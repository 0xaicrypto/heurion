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

  const from = (location.state as { from?: { pathname: string } })?.from?.pathname || '/app/today';

  const { isAuthenticated, setSession } = useAuthStore();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-md space-y-6 rounded-2xl border border-border bg-surface-elevated p-8 shadow-lg">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-text-primary">
            {isRegister ? t('auth.createAccount') : t('auth.welcomeBack')}
          </h1>
          <p className="mt-2 text-sm text-text-secondary">
            {isRegister ? t('auth.signUpPrompt') : t('auth.signInPrompt')}
          </p>
        </div>

        {error && <Alert variant="error">{error}</Alert>}

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

        <p className="text-center text-sm text-text-secondary">
          {isRegister ? t('auth.alreadyHaveAccount') : t('auth.noAccount')}{' '}
          <button type="button" onClick={toggleMode} className="font-medium text-accent hover:underline">
            {isRegister ? t('common.login') : t('common.register')}
          </button>
        </p>

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
