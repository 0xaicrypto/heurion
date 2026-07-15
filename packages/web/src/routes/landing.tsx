import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Activity, Brain, FileText, Server, Shield } from 'lucide-react';
import { Button } from '@/components/ui';

export function LandingPage() {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith('zh');

  const switchLang = () => {
    i18n.changeLanguage(isZh ? 'en' : 'zh-CN');
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Navigation */}
      <nav className="sticky top-0 z-50 border-b border-border bg-surface/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
          <div className="flex items-center gap-2">
            <div className="h-7 w-7 rounded-lg bg-accent" />
            <span className="text-lg font-bold text-text-primary">{t('appName')}</span>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={switchLang}
              className="text-sm text-text-secondary hover:text-text-primary"
            >
              {isZh ? 'English' : '中文'}
            </button>
            <Link to="/login">
              <Button variant="ghost" size="sm">
                {t('landing.navLogin')}
              </Button>
            </Link>
            <Link to="/login?mode=register">
              <Button size="sm">{t('landing.navGetStarted')}</Button>
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="relative overflow-hidden bg-surface">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-accent/10 via-transparent to-transparent" />
        <div className="relative mx-auto max-w-6xl px-4 py-20 sm:py-28">
          <div className="mx-auto max-w-3xl text-center">
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-surface-elevated px-3 py-1 text-xs font-medium text-text-secondary">
              <span className="h-2 w-2 rounded-full bg-success" />
              {isZh ? 'Clinical AI Twin v0.1' : 'Clinical AI Twin v0.1'}
            </div>
            <h1 className="text-4xl font-extrabold tracking-tight text-text-primary sm:text-6xl">
              {t('landing.heroTitle')}
              <br />
              <span className="text-accent">{t('landing.heroHighlight')}</span>
            </h1>
            <p className="mx-auto mt-6 max-w-2xl text-lg text-text-secondary">
              {t('landing.heroSubtitle')}
            </p>
            <div className="mt-10 flex flex-col justify-center gap-3 sm:flex-row">
              <Link to="/login?mode=register">
                <Button size="lg" className="w-full sm:w-auto">
                  {t('landing.heroCtaPrimary')}
                </Button>
              </Link>
              <a
                href="https://github.com/0xaicrypto/nexus"
                target="_blank"
                rel="noreferrer"
              >
                <Button variant="secondary" size="lg" className="w-full sm:w-auto">
                  <svg
                    viewBox="0 0 24 24"
                    width="18"
                    height="18"
                    fill="currentColor"
                    className="mr-2"
                    aria-hidden="true"
                  >
                    <path d="M12 1C5.925 1 1 5.925 1 12c0 4.867 3.154 8.993 7.533 10.45.55.101.733-.238.733-.529 0-.262-.01-1.13-.015-2.05-3.065.665-3.71-1.47-3.71-1.47-.501-1.273-1.224-1.613-1.224-1.613-.999-.683.076-.669.076-.669 1.105.078 1.687 1.135 1.687 1.135.982 1.682 2.576 1.197 3.204.916.1-.712.384-1.197.698-1.472-2.448-.278-5.021-1.224-5.021-5.45 0-1.204.43-2.188 1.135-2.96-.114-.278-.492-1.397.108-2.912 0 0 .925-.297 3.03 1.13A10.56 10.56 0 0 1 12 6.843c.937.005 1.88.127 2.762.372 2.103-1.427 3.027-1.13 3.027-1.13.602 1.515.224 2.634.11 2.912.706.772 1.134 1.756 1.134 2.96 0 4.235-2.577 5.168-5.03 5.44.395.34.747 1.01.747 2.037 0 1.472-.014 2.657-.014 3.02 0 .293.182.633.74.526C19.85 20.99 23 16.866 23 12c0-6.075-4.925-11-11-11Z" />
                  </svg>
                  {t('landing.heroCtaSecondary')}
                </Button>
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="mx-auto max-w-6xl px-4 py-20">
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          <FeatureCard
            icon={<Activity size={24} />}
            title={t('landing.feature1Title')}
            desc={t('landing.feature1Desc')}
          />
          <FeatureCard
            icon={<Brain size={24} />}
            title={t('landing.feature2Title')}
            desc={t('landing.feature2Desc')}
          />
          <FeatureCard
            icon={<FileText size={24} />}
            title={t('landing.feature3Title')}
            desc={t('landing.feature3Desc')}
          />
          <FeatureCard
            icon={<Server size={24} />}
            title={t('landing.feature4Title')}
            desc={t('landing.feature4Desc')}
          />
        </div>
      </section>

      {/* Trust */}
      <section className="border-y border-border bg-surface">
        <div className="mx-auto max-w-6xl px-4 py-16">
          <div className="flex flex-col items-center gap-8 md:flex-row md:justify-between">
            <div>
              <h2 className="text-2xl font-bold text-text-primary">{t('landing.trustTitle')}</h2>
              <p className="mt-2 text-text-secondary">
                {isZh
                  ? '安全、可解释、可审计——为医疗场景设计的 AI 基础设施。'
                  : 'Secure, explainable, and auditable AI infrastructure for healthcare.'}
              </p>
            </div>
            <ul className="space-y-3">
              <TrustItem text={t('landing.trust1')} />
              <TrustItem text={t('landing.trust2')} />
              <TrustItem text={t('landing.trust3')} />
            </ul>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="mx-auto max-w-6xl px-4 py-20 text-center">
        <h2 className="text-3xl font-bold text-text-primary">{t('landing.ctaTitle')}</h2>
        <p className="mx-auto mt-4 max-w-xl text-text-secondary">{t('landing.ctaSubtitle')}</p>
        <Link to="/login?mode=register" className="mt-8 inline-block">
          <Button size="lg">{t('landing.ctaButton')}</Button>
        </Link>
      </section>

      {/* Footer */}
      <footer className="border-t border-border bg-surface py-8">
        <div className="mx-auto max-w-6xl px-4 text-center text-sm text-text-tertiary">
          {t('landing.footer', { year: new Date().getFullYear() })}
        </div>
      </footer>
    </div>
  );
}

function FeatureCard({
  icon,
  title,
  desc,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface-elevated p-6 shadow-sm transition-colors hover:border-accent/30">
      <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-accent/10 text-accent">
        {icon}
      </div>
      <h3 className="mb-2 font-semibold text-text-primary">{title}</h3>
      <p className="text-sm leading-relaxed text-text-secondary">{desc}</p>
    </div>
  );
}

function TrustItem({ text }: { text: string }) {
  return (
    <li className="flex items-center gap-2 text-text-secondary">
      <Shield size={16} className="text-success" />
      <span>{text}</span>
    </li>
  );
}
