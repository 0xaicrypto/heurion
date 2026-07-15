import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '@/lib/api-client';
import { useAuthStore } from '@/stores/auth';
import { Button, Input } from '@/components/ui';

export function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const isRegister = searchParams.get('mode') === 'register';

  const { isAuthenticated, setSession } = useAuthStore();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (isAuthenticated) navigate('/app/today', { replace: true });
  }, [isAuthenticated, navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const session = isRegister
        ? await api.register({ username, password, displayName })
        : await api.login(username, password);
      setSession(session);
      navigate('/app/today', { replace: true });
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

        {error && (
          <div className="rounded-lg bg-error/10 px-4 py-3 text-sm text-error">{error}</div>
        )}

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

        <p className="text-center text-sm">
          <Link to="/" className="text-text-tertiary hover:text-text-secondary">
            ← {t('common.back')}
          </Link>
        </p>
      </div>
    </div>
  );
}
