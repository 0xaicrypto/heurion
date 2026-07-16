import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Activity, ArrowRight, Brain, FlaskConical, Globe, MessageSquare, Plug, Server, Shield } from 'lucide-react';
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
      <nav className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur-lg">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-white text-sm font-bold">H</div>
            <span className="text-xl font-bold text-text-primary">{t('appName')}</span>
          </div>
          <div className="flex items-center gap-3">
            <button onClick={switchLang} className="text-sm text-text-secondary hover:text-text-primary transition-colors">
              {isZh ? 'English' : '中文'}
            </button>
            <Link to="/login">
              <Button variant="ghost" size="sm">{t('landing.navLogin')}</Button>
            </Link>
            <Link to="/login?mode=register">
              <Button size="sm">{t('landing.navGetStarted')}</Button>
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-b from-accent/5 via-transparent to-transparent" />
        <div className="absolute top-20 right-0 w-[600px] h-[600px] bg-accent/5 rounded-full blur-3xl -translate-y-1/2 translate-x-1/4" />
        <div className="relative mx-auto max-w-7xl px-4 py-24 sm:py-32">
          <div className="mx-auto max-w-3xl text-center">
            <div className="mb-8 inline-flex items-center gap-2 rounded-full border border-accent/20 bg-accent/5 px-4 py-1.5 text-sm font-medium text-accent">
              <span className="h-2 w-2 rounded-full bg-accent animate-pulse" />
              {isZh ? '多源 AI 插件市场 · 17+ 技能可用' : 'Multi-Source Plugin Marketplace · 17+ Skills Available'}
            </div>
            <h1 className="text-5xl font-extrabold tracking-tight text-text-primary sm:text-7xl">
              {isZh ? '临床智能' : 'Clinical Intelligence'}
              <br />
              <span className="bg-gradient-to-r from-accent to-blue-500 bg-clip-text text-transparent">
                {isZh ? '从对话开始积累' : 'That Accumulates'}
              </span>
            </h1>
            <p className="mx-auto mt-8 max-w-2xl text-lg leading-relaxed text-text-secondary">
              {isZh 
                ? 'Heurion 从每次问诊中学习，记住关键信息，并在您的授权下采取行动。接入 Anthropic、GitHub 等多源 AI 技能市场，云端部署，任何设备皆可访问。'
                : 'Heurion learns from every encounter, remembers what matters, and acts on your behalf. Connected to Anthropic, GitHub, and community AI skill marketplaces — cloud-native and accessible from any device.'}
            </p>
            <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Link to="/login?mode=register">
                <Button size="lg" className="px-8 text-base">
                  {isZh ? '免费开始使用' : 'Start Free'}
                  <ArrowRight size={18} className="ml-2" />
                </Button>
              </Link>
              <a href="https://github.com/0xaicrypto/heurion" target="_blank" rel="noreferrer">
                <Button variant="secondary" size="lg" className="px-8 text-base">
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" className="mr-2" aria-hidden="true">
                    <path d="M12 1C5.925 1 1 5.925 1 12c0 4.867 3.154 8.993 7.533 10.45.55.101.733-.238.733-.529 0-.262-.01-1.13-.015-2.05-3.065.665-3.71-1.47-3.71-1.47-.501-1.273-1.224-1.613-1.224-1.613-.999-.683.076-.669.076-.669 1.105.078 1.687 1.135 1.687 1.135.982 1.682 2.576 1.197 3.204.916.1-.712.384-1.197.698-1.472-2.448-.278-5.021-1.224-5.021-5.45 0-1.204.43-2.188 1.135-2.96-.114-.278-.492-1.397.108-2.912 0 0 .925-.297 3.03 1.13A10.56 10.56 0 0 1 12 6.843c.937.005 1.88.127 2.762.372 2.103-1.427 3.027-1.13 3.027-1.13.602 1.515.224 2.634.11 2.912.706.772 1.134 1.756 1.134 2.96 0 4.235-2.577 5.168-5.03 5.44.395.34.747 1.01.747 2.037 0 1.472-.014 2.657-.014 3.02 0 .293.182.633.74.526C19.85 20.99 23 16.866 23 12c0-6.075-4.925-11-11-11Z" />
                  </svg>
                  GitHub
                </Button>
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* Features Grid */}
      <section className="mx-auto max-w-7xl px-4 py-20">
        <div className="mb-12 text-center">
          <h2 className="text-3xl font-bold text-text-primary">
            {isZh ? '专为临床打造的一体化平台' : 'An Integrated Clinical Platform'}
          </h2>
          <p className="mt-3 text-text-secondary">
            {isZh ? '从患者管理到研究报告，从技能市场到记忆网络——全在云端' : 'From patient management to research reports, from skill marketplace to memory graph — all in the cloud'}
          </p>
        </div>
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          <FeatureCard
            icon={<Activity size={22} />}
            title={t('landing.feature1Title')}
            desc={t('landing.feature1Desc')}
          />
          <FeatureCard
            icon={<Brain size={22} />}
            title={t('landing.feature2Title')}
            desc={t('landing.feature2Desc')}
          />
          <FeatureCard
            icon={<Plug size={22} />}
            title={isZh ? '多源 AI 插件市场' : 'Multi-Source Plugin Market'}
            desc={isZh ? '接入 Anthropic、GitHub 等技能市场，一键安装运行 PDF、搜索、代码等技能。' : 'Connect to Anthropic, GitHub, and community skill catalogs — install and run PDF, search, code skills with one click.'}
          />
          <FeatureCard
            icon={<FlaskConical size={22} />}
            title={t('landing.feature3Title')}
            desc={t('landing.feature3Desc')}
          />
          <FeatureCard
            icon={<MessageSquare size={22} />}
            title={isZh ? '多模态对话问诊' : 'Multimodal Encounters'}
            desc={isZh ? '支持文本、文件、DICOM 影像输入，AI 实时推理、引用溯源、记忆自动更新。' : 'Text, file, and DICOM image input with real-time reasoning, citation tracking, and automatic memory updates.'}
          />
          <FeatureCard
            icon={<Server size={22} />}
            title={t('landing.feature4Title')}
            desc={t('landing.feature4Desc')}
          />
        </div>
      </section>

      {/* Stats strip */}
      <section className="border-y border-border bg-surface">
        <div className="mx-auto max-w-7xl px-4 py-12">
          <div className="grid grid-cols-2 gap-8 sm:grid-cols-4">
            <StatCard value="17+" label={isZh ? '官方技能' : 'Official Skills'} />
            <StatCard value="∞" label={isZh ? '社区插件' : 'Community Plugins'} />
            <StatCard value="SSE" label={isZh ? '实时流式对话' : 'Real-time Streaming'} />
            <StatCard value="4" label={isZh ? 'LLM 提供商' : 'LLM Providers'} />
          </div>
        </div>
      </section>

      {/* Trust */}
      <section className="mx-auto max-w-7xl px-4 py-16">
        <div className="flex flex-col items-center gap-8 md:flex-row md:justify-between">
          <div>
            <h2 className="text-2xl font-bold text-text-primary">{t('landing.trustTitle')}</h2>
            <p className="mt-2 text-text-secondary">{t('landing.trustDescription')}</p>
          </div>
          <ul className="space-y-3">
            <TrustItem text={t('landing.trust1')} />
            <TrustItem text={t('landing.trust2')} />
            <TrustItem text={t('landing.trust3')} />
          </ul>
        </div>
      </section>

      {/* CTA */}
      <section className="bg-surface border-t border-border">
        <div className="mx-auto max-w-7xl px-4 py-20 text-center">
          <h2 className="text-3xl font-bold text-text-primary">{t('landing.ctaTitle')}</h2>
          <p className="mx-auto mt-4 max-w-xl text-text-secondary">{t('landing.ctaSubtitle')}</p>
          <div className="mt-8 flex items-center justify-center gap-4">
            <Link to="/login?mode=register">
              <Button size="lg" className="px-8">{t('landing.ctaButton')}</Button>
            </Link>
            <a href="https://github.com/0xaicrypto/heurion" target="_blank" rel="noreferrer">
              <Button variant="secondary" size="lg" className="px-8">
                <Globe size={18} className="mr-2" />
                {isZh ? '自托管文档' : 'Self-Hosting Docs'}
              </Button>
            </a>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border bg-background py-10">
        <div className="mx-auto max-w-7xl px-4">
          <div className="flex flex-col items-center gap-4 sm:flex-row sm:justify-between">
            <div className="flex items-center gap-2 text-text-secondary">
              <div className="flex h-6 w-6 items-center justify-center rounded bg-accent text-xs font-bold text-white">H</div>
              <span className="font-medium">{t('appName')}</span>
            </div>
            <div className="flex gap-6 text-sm text-text-tertiary">
              <a href="https://github.com/0xaicrypto/heurion" target="_blank" rel="noreferrer" className="hover:text-text-primary transition-colors">GitHub</a>
              <Link to="/login" className="hover:text-text-primary transition-colors">{t('landing.navLogin')}</Link>
              <button onClick={switchLang} className="hover:text-text-primary transition-colors">{isZh ? 'English' : '中文'}</button>
            </div>
          </div>
          <p className="mt-6 text-center text-xs text-text-tertiary">
            {t('landing.footer', { year: new Date().getFullYear() })}
          </p>
        </div>
      </footer>
    </div>
  );
}

function FeatureCard({ icon, title, desc }: { icon: React.ReactNode; title: string; desc: string }) {
  return (
    <div className="group rounded-xl border border-border bg-surface-elevated p-6 shadow-sm transition-all hover:border-accent/30 hover:shadow-md">
      <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent transition-colors group-hover:bg-accent/15">
        {icon}
      </div>
      <h3 className="mb-2 font-semibold text-text-primary">{title}</h3>
      <p className="text-sm leading-relaxed text-text-secondary">{desc}</p>
    </div>
  );
}

function StatCard({ value, label }: { value: string; label: string }) {
  return (
    <div className="text-center">
      <p className="text-3xl font-bold text-accent">{value}</p>
      <p className="mt-1 text-sm text-text-tertiary">{label}</p>
    </div>
  );
}

function TrustItem({ text }: { text: string }) {
  return (
    <li className="flex items-center gap-2 text-text-secondary">
      <Shield size={16} className="text-success shrink-0" />
      <span>{text}</span>
    </li>
  );
}
