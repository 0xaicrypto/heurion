import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowRight, Brain, FileText, BookOpen, Shield, Activity, MessageSquare, Layers } from 'lucide-react';
import { Button, Card } from '@/components/ui';
import { MarketingShell } from '@/components/marketing/MarketingShell';

export function LandingPage() {
  const { i18n } = useTranslation();
  const isZh = i18n.language.startsWith('zh');

  const T = {
    tagline: isZh ? '运行时短暂，进化永恒' : 'Runtime is temporary. Evolution is eternal.',
    title: isZh ? '自我进化的临床 AI 工作站' : 'Self-Evolving Clinical AI Workstation',
    subtitle: isZh
      ? 'Heurion 为肿瘤研究者打造。每次问诊、文件与确认都会沉淀为可版本化、可传播、可导出的统一记忆图；异步进化引擎自动提取事实、合成知识，让 AI 真正“记得”并随你一起成长。'
      : 'Built for oncology researchers. Every encounter, file, and confirmation becomes a versioned, propagating, exportable Memory Graph. An asynchronous Evolution Engine extracts facts and synthesizes knowledge — so the AI remembers and grows with you.',
    startFree: isZh ? '免费开始使用' : 'Start Free',
    github: 'GitHub',

    pillarsTitle: isZh ? '三大核心能力' : 'Three core capabilities',
    pillars: [
      {
        to: '/memory-graph',
        icon: <Brain size={28} />,
        title: isZh ? '统一记忆图' : 'Unified Memory Graph',
        desc: isZh
          ? 'Facts、Articles、Gaps、Skills、Entities、Documents 作为节点与关系共存；版本化、可审计、可导出。'
          : 'Facts, Articles, Gaps, Skills, Entities, and Documents live as nodes and relations; versioned, auditable, and exportable.',
      },
      {
        to: '/sidecar',
        icon: <FileText size={28} />,
        title: isZh ? '智能报告助手' : 'Smart Report Assistant',
        desc: isZh
          ? '一句话生成病例总结 DOCX、学术汇报 PPTX、基线表格与统计图，文件链接刷新不丢。'
          : 'Generate case-summary DOCX, academic PPTX, baseline tables, and plots from one sentence — with refresh-safe file links.',
      },
      {
        to: '/knowledge',
        icon: <BookOpen size={28} />,
        title: isZh ? '可进化知识库' : 'Evolving knowledge base',
        desc: isZh
          ? 'Articles 自动标记 stale、可重新生成；Facts 编辑会级联传播；支持版本历史与影响范围查看。'
          : 'Articles auto-mark stale and can be regenerated; fact edits cascade; version history and impact views included.',
      },
    ],

    whyTitle: isZh ? '为什么临床 AI 不能“无状态”？' : 'Why clinical AI cannot be stateless',
    whyBody: isZh
      ? '传统聊天机器人在每次对话后重置。医生不得不反复提供患者背景、研究偏好和既往结论。Heurion 把原始输入提炼成结构化记忆，并在下一轮自动引用，减少重复劳动，降低幻觉风险。'
      : 'Traditional chatbots reset after every conversation. Doctors repeatedly provide patient background, research preferences, and prior conclusions. Heurion distills raw inputs into structured memory and recalls it automatically in the next turn, cutting repetition and reducing hallucinations.',

    loopTitle: isZh ? '异步进化管线' : 'Async evolution pipeline',
    loopSteps: [
      { n: '01', title: 'INGEST', desc: isZh ? '追加到不可变事件日志' : 'Append to immutable event log' },
      { n: '02', title: 'EXTRACT', desc: isZh ? 'LLM 提取事实与洞察' : 'LLM extracts facts & insights' },
      { n: '03', title: 'LINK', desc: isZh ? '去重并链接文档/实体' : 'Deduplicate and link documents/entities' },
      { n: '04', title: 'SYNTHESIZE', desc: isZh ? '相关事实合成 Article' : 'Synthesize articles from related facts' },
      { n: '05', title: 'CURATE', desc: isZh ? '用户编辑自动传播' : 'Propagate user edits to dependents' },
      { n: '06', title: 'RETRIEVE', desc: isZh ? '语义 + 图混合检索' : 'Semantic + graph hybrid retrieval' },
    ],

    routerTitle: isZh ? '先路由，再混合检索' : 'Route first, then retrieve',
    routerBody: isZh
      ? 'Query Router 在 <1ms 内判定意图，随后通过 Embedding 召回 + 图关系扩展 + RRF 重排，把最相关的 Facts、Articles 与 Gaps 注入上下文，避免把所有历史塞进 LLM。'
      : 'The Query Router classifies intent in <1ms, then retrieves the most relevant facts, articles, and gaps via embedding recall, graph expansion, and RRF reranking — without dumping all history into the LLM.',

    securityTitle: isZh ? '安全与隔离' : 'Security & isolation',
    securityBody: isZh
      ? '控制面与执行面分离，对象存储按租户隔离，插件无法访问主数据库。患者上下文始终注入当前对话，事实与知识版本化、可审计、可导出。'
      : 'Control and execution planes are separated, object storage is tenant-isolated, and plugins cannot access the main database. Patient context is always injected, and facts/knowledge are versioned, auditable, and exportable.',
    securityCta: isZh ? '了解安全架构' : 'Explore security',

    ctaTitle: isZh ? '让 AI 从您的每一次诊疗中学习' : 'Let AI learn from every case',
    ctaSubtitle: isZh
      ? '免费开始，或在您的服务器上自托管完整平台。'
      : 'Start free or self-host the full platform on your own servers.',
  };

  return (
    <MarketingShell>
      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-b from-accent/5 via-transparent to-transparent" />
        <div className="absolute -top-40 -right-40 h-[600px] w-[600px] rounded-full bg-accent/5 blur-3xl" />
        <div className="absolute top-40 -left-40 h-[400px] w-[400px] rounded-full bg-blue-500/5 blur-3xl" />
        <div className="relative mx-auto max-w-7xl px-4 py-24 sm:py-32">
          <div className="mx-auto max-w-3xl text-center">
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-accent/20 bg-accent/5 px-4 py-1.5 text-sm font-medium text-accent">
              <span className="h-2 w-2 rounded-full bg-accent animate-pulse" />
              {T.tagline}
            </div>
            <h1 className="text-4xl font-extrabold tracking-tight text-text-primary sm:text-6xl lg:text-7xl">
              {T.title}
            </h1>
            <p className="mx-auto mt-8 max-w-2xl text-lg leading-relaxed text-text-secondary">
              {T.subtitle}
            </p>
            <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Link to="/login?mode=register">
                <Button size="lg" className="px-8 text-base">
                  {T.startFree}
                  <ArrowRight size={18} className="ml-2" />
                </Button>
              </Link>
              <a href="https://github.com/0xaicrypto/heurion" target="_blank" rel="noreferrer">
                <Button variant="secondary" size="lg" className="px-8 text-base">
                  {T.github}
                </Button>
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* Pillars */}
      <section className="border-y border-border bg-surface">
        <div className="mx-auto max-w-7xl px-4 py-24">
          <div className="mb-12 text-center">
            <h2 className="text-3xl font-bold text-text-primary">{T.pillarsTitle}</h2>
          </div>
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {T.pillars.map((p, idx) => (
              <Link key={idx} to={p.to} className="group block">
                <Card className="h-full p-8 transition-all hover:border-accent/30 hover:shadow-md">
                  <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-xl bg-accent/10 text-accent transition-colors group-hover:bg-accent group-hover:text-white">
                    {p.icon}
                  </div>
                  <h3 className="text-xl font-bold text-text-primary">{p.title}</h3>
                  <p className="mt-3 leading-relaxed text-text-secondary">{p.desc}</p>
                  <div className="mt-5 inline-flex items-center text-sm font-medium text-accent">
                    {isZh ? '了解更多' : 'Learn more'}
                    <ArrowRight size={16} className="ml-1 transition-transform group-hover:translate-x-1" />
                  </div>
                </Card>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* Why stateless fails */}
      <section className="mx-auto max-w-7xl px-4 py-24">
        <div className="mx-auto max-w-3xl text-center">
          <div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <Activity size={24} />
          </div>
          <h2 className="text-3xl font-bold text-text-primary">{T.whyTitle}</h2>
          <p className="mt-4 text-lg leading-relaxed text-text-secondary">{T.whyBody}</p>
        </div>
      </section>

      {/* Evolution loop */}
      <section className="bg-surface">
        <div className="mx-auto max-w-7xl px-4 py-24">
          <div className="mb-12 text-center">
            <h2 className="text-3xl font-bold text-text-primary">{T.loopTitle}</h2>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {T.loopSteps.map((s) => (
              <Card key={s.n} className="relative overflow-hidden p-6">
                <span className="absolute -right-2 -top-4 text-6xl font-bold text-accent/5">{s.n}</span>
                <h3 className="text-lg font-bold text-accent">{s.title}</h3>
                <p className="mt-2 text-sm text-text-secondary">{s.desc}</p>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* Router */}
      <section className="mx-auto max-w-7xl px-4 py-24">
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <div>
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <MessageSquare size={24} />
            </div>
            <h2 className="text-3xl font-bold text-text-primary">{T.routerTitle}</h2>
            <p className="mt-4 text-lg leading-relaxed text-text-secondary">{T.routerBody}</p>
          </div>
          <div className="rounded-2xl border border-border bg-surface p-6 shadow-sm">
            <div className="space-y-3">
              {[
                { q: isZh ? '“ZL 的年龄/性别？”' : '"What is ZL\'s age/sex?"', r: 'sql' },
                { q: isZh ? '“NSCLC 最新指南怎么说？”' : '"Latest NSCLC guidelines?"', r: 'vector' },
                { q: isZh ? '“生成 ZQ 病例总结 Word”' : '"Generate a Word case summary for ZQ"', r: 'reports' },
                { q: isZh ? '普通临床讨论' : 'General clinical discussion', r: 'mixed' },
              ].map((item, idx) => (
                <div key={idx} className="flex items-center justify-between rounded-lg border border-border bg-background px-4 py-3">
                  <span className="text-sm text-text-primary">{item.q}</span>
                  <span className="rounded-md bg-accent/10 px-2 py-1 text-xs font-medium text-accent">{item.r}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Security */}
      <section className="bg-surface">
        <div className="mx-auto max-w-7xl px-4 py-24">
          <div className="grid items-center gap-12 lg:grid-cols-2">
            <div className="order-2 lg:order-1">
              <Card className="p-6">
                <div className="space-y-4">
                  {                  [
                    isZh ? '控制面 / 执行面双平面隔离' : 'Control / execution plane isolation',
                    isZh ? '租户隔离的对象存储' : 'Tenant-isolated object storage',
                    isZh ? '患者上下文强制注入当前会话' : 'Patient context always injected into the current turn',
                    isZh ? '版本化事实与知识，可审计、可导出' : 'Versioned facts & knowledge, auditable & exportable',
                    isZh ? '不可变 EventLog + .hma 归档导出' : 'Immutable EventLog + .hma archive export',
                  ].map((text, idx) => (
                    <div key={idx} className="flex items-center gap-3 text-text-secondary">
                      <Layers size={18} className="text-success shrink-0" />
                      <span>{text}</span>
                    </div>
                  ))}
                </div>
              </Card>
            </div>
            <div className="order-1 lg:order-2">
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-accent/10 text-accent">
                <Shield size={24} />
              </div>
              <h2 className="text-3xl font-bold text-text-primary">{T.securityTitle}</h2>
              <p className="mt-4 text-lg leading-relaxed text-text-secondary">{T.securityBody}</p>
              <div className="mt-6">
                <Link to="/security">
                  <Button variant="secondary">{T.securityCta}</Button>
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="mx-auto max-w-7xl px-4 py-24 text-center">
        <h2 className="text-3xl font-bold text-text-primary">{T.ctaTitle}</h2>
        <p className="mx-auto mt-4 max-w-xl text-text-secondary">{T.ctaSubtitle}</p>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link to="/login?mode=register">
            <Button size="lg" className="px-8">{T.startFree}</Button>
          </Link>
          <a href="https://github.com/0xaicrypto/heurion" target="_blank" rel="noreferrer">
            <Button variant="secondary" size="lg" className="px-8">{T.github}</Button>
          </a>
        </div>
      </section>
    </MarketingShell>
  );
}
