import { useTranslation } from 'react-i18next';
import { Link, NavLink } from 'react-router-dom';
import { Brain, FileText, BookOpen, Shield, Globe } from 'lucide-react';
import { Button } from '@/components/ui';
import { ThemeMenu } from '@/components/ThemeMenu';

const subpages = [
  { to: '/memory', labelKey: 'marketing.navMemory', icon: Brain },
  { to: '/sidecar', labelKey: 'marketing.navSidecar', icon: FileText },
  { to: '/knowledge', labelKey: 'marketing.navKnowledge', icon: BookOpen },
  { to: '/security', labelKey: 'marketing.navSecurity', icon: Shield },
];

/** #530-followup: /docs 是独立 VitePress 站点(server 静态服务),
 *  必须用整页跳转 <a>,React Router Link 会走 SPA 兜底。 */
const docLinks = [{ to: '/docs/', labelKey: 'marketing.navDocs', icon: BookOpen }];

export function MarketingShell({ children }: { children: React.ReactNode }) {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith('zh');

  const switchLang = () => {
    i18n.changeLanguage(isZh ? 'en' : 'zh-CN');
  };

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <nav className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur-lg">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4">
          <Link to="/" className="flex items-center gap-3">
            <img src="/heurion-logo.svg" alt="Heurion" className="h-8 w-auto dark:hidden" />
            <img src="/heurion-logo-dark.svg" alt="Heurion" className="hidden h-8 w-auto dark:block" />
          </Link>
          <div data-testid="marketing-nav" className="flex items-center gap-1 overflow-x-auto sm:flex">
            {subpages.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                    isActive ? 'text-accent' : 'text-text-secondary hover:text-text-primary'
                  }`
                }
              >
                <item.icon size={16} />
                {t(item.labelKey)}
              </NavLink>
            ))}
            {docLinks.map((item) => (
              <a
                key={item.to}
                href={item.to}
                className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-text-secondary transition-colors hover:text-text-primary"
              >
                <item.icon size={16} />
                {t(item.labelKey)}
              </a>
            ))}
          </div>
          <div className="flex items-center gap-2">
            {/* #517-followup: 营销页与应用内一致的主题切换。 */}
            <ThemeMenu placement="top-full" />
            <button
              onClick={switchLang}
              className="inline-flex items-center gap-1 rounded-lg p-2 text-sm text-text-secondary hover:bg-surface hover:text-text-primary transition-colors"
              aria-label={t('common.language')}
            >
              <Globe size={16} />
              <span className="hidden sm:inline">{isZh ? 'English' : '中文'}</span>
            </button>
            <Link to="/login" className="hidden sm:block">
              <Button variant="ghost" size="sm">{t('landing.navLogin')}</Button>
            </Link>
            <Link to="/login?mode=register">
              <Button size="sm">{t('landing.navGetStarted')}</Button>
            </Link>
          </div>
        </div>
      </nav>

      <main className="flex-1">{children}</main>

      <footer className="border-t border-border bg-surface py-10">
        <div className="mx-auto max-w-7xl px-4">
          <div className="flex flex-col items-center justify-between gap-4 sm:flex-row">
            <div className="flex items-center gap-2 text-text-secondary">
              <img src="/heurion-logo.svg" alt="Heurion" className="h-6 w-auto dark:hidden" />
              <img src="/heurion-logo-dark.svg" alt="Heurion" className="hidden h-6 w-auto dark:block" />
            </div>
            <div className="flex flex-wrap justify-center gap-4 text-sm text-text-tertiary">
              {subpages.map((item) => (
                <Link key={item.to} to={item.to} className="hover:text-text-primary transition-colors">
                  {t(item.labelKey)}
                </Link>
              ))}
              <a href="https://github.com/0xaicrypto/heurion" target="_blank" rel="noreferrer" className="hover:text-text-primary transition-colors">
                GitHub
              </a>
            </div>
          </div>
          <p className="mt-6 text-center text-xs text-text-tertiary">{t('landing.footer', { year: new Date().getFullYear() })}</p>
          {/* #518: 技术生态致谢。 */}
          <p className="mt-2 text-center text-xs text-text-tertiary">
            {t('landing.footerBuiltOn', 'Built on Cloudflare Workers · Vercel AI SDK · opencode.ai — thank you to our partners.')}
          </p>
        </div>
      </footer>
    </div>
  );
}
