import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import {
  Activity,
  ArrowRight,
  BarChart3,
  BookOpen,
  Brain,
  CheckCircle2,
  Cpu,
  FileText,
  Globe,
  Layers,
  LayoutGrid,
  Lock,
  MessageSquare,
  Route,
  Server,
  Shield,
  Table,
} from 'lucide-react';
import { Button, Card } from '@/components/ui';

export function LandingPage() {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith('zh');

  const switchLang = () => {
    i18n.changeLanguage(isZh ? 'en' : 'zh-CN');
  };

  const T = {
    tagline: isZh ? '运行时短暂，进化永恒' : 'Runtime is temporary. Evolution is eternal.',
    title: isZh ? '自我进化的临床 AI 工作站' : 'Self-Evolving Clinical AI Workstation',
    subtitle: isZh
      ? 'Heurion 为肿瘤研究者打造。每一次问诊、每一份文件、每一次确认都会沉淀为四层记忆；系统先路由问题，再投影最相关的临床上下文，让 AI 真正“记得”而不是“重置”。'
      : 'Built for oncology researchers. Every encounter, file, and confirmation is accumulated into four layers of memory; the system routes your question first, then projects only the most relevant clinical context — so the AI remembers instead of resets.',
    startFree: isZh ? '免费开始使用' : 'Start Free',
    github: 'GitHub',
    selfHostDocs: isZh ? '自托管文档' : 'Self-Hosting Docs',

    problemTitle: isZh ? '为什么临床 AI 不能“无状态”？' : 'Why clinical AI cannot be stateless',
    problemBody: isZh
      ? '传统聊天机器人在每次对话后重置。医生不得不反复提供患者背景、研究偏好和既往结论。Heurion 把原始输入提炼成 Facts、Knowledge、Persona，并在下一轮自动引用。'
      : 'Traditional chatbots reset after every conversation. Doctors repeatedly provide patient background, research preferences, and prior conclusions. Heurion distills raw inputs into Facts, Knowledge, and Persona, then recalls them automatically in the next turn.',

    loopTitle: isZh ? '六步进化闭环' : 'The 6-stage evolution loop',
    loopSteps: [
      { n: '01', title: isZh ? 'INGEST' : 'INGEST', desc: isZh ? '追加到不可变事件日志' : 'Append to immutable event log' },
      { n: '02', title: isZh ? 'EXTRACT' : 'EXTRACT', desc: isZh ? 'LLM 提取事实与洞察' : 'LLM extracts facts & insights' },
      { n: '03', title: isZh ? 'GRAPH' : 'GRAPH', desc: isZh ? '积累患者临床发现' : 'Accumulate clinical findings' },
      { n: '04', title: isZh ? 'DISTILL' : 'DISTILL', desc: isZh ? '跨患者模式蒸馏' : 'Cross-patient pattern distillation' },
      { n: '05', title: isZh ? 'EVOLVE' : 'EVOLVE', desc: isZh ? '自主自我改进' : 'Autonomous self-improvement' },
      { n: '06', title: isZh ? 'RETRIEVE' : 'RETRIEVE', desc: isZh ? '加权注意力上下文投影' : 'Weighted attention projection' },
    ],

    memoryTitle: isZh ? '四层记忆 + 一次投影' : 'Four-layer memory + one projection',
    memoryLayers: [
      { icon: <MessageSquare size={20} />, title: isZh ? '原始输入' : 'Raw input', desc: isZh ? '对话、文件、确认' : 'Conversations, files, confirmations' },
      { icon: <Activity size={20} />, title: 'Facts', desc: isZh ? '结构化片段，带重要性与时间戳' : 'Structured snippets with importance & timestamp' },
      { icon: <BookOpen size={20} />, title: 'Knowledge', desc: isZh ? '≥3 条相关 Facts 自动合成的综述' : 'Synthesized articles from ≥3 related facts' },
      { icon: <Brain size={20} />, title: 'Persona', desc: isZh ? '每次聊天前动态生成的系统人设' : 'Dynamic identity generated before each chat' },
    ],
    projectionTitle: isZh ? '记忆投影的六层优先级' : 'Six-layer memory projection priority',
    projectionItems: [
      isZh ? 'Persona：你是谁、关心什么' : 'Persona: who you are and what you care about',
      isZh ? '当前患者上下文（最高优先级）' : 'Current patient context (highest priority)',
      isZh ? '最近 3 轮完整对话（不压缩）' : 'Last 3 full turns (uncompressed)',
      isZh ? '近期会话 Episodes 摘要' : 'Recent session episode summaries',
      isZh ? '加权 Facts / Knowledge：attention = 重要性 × e^(-0.3×天数)' : 'Weighted facts/knowledge: attention = importance × e^(-0.3×days)',
      isZh ? 'Skills：积累并验证过的策略' : 'Skills: validated strategies',
    ],

    routerTitle: isZh ? '先路由，再投影' : 'Route first, then project',
    routerBody: isZh
      ? 'Query Router 用规则层在 <1ms 内判断问题是“查患者数据库”、“搜知识库”、“渲染文档”还是“普通讨论”，只打开必要的记忆来源，避免把所有历史塞进 LLM。'
      : 'The Query Router uses a rule layer to decide in <1ms whether a question needs the patient DB, knowledge base, document rendering, or general discussion — opening only the required memory sources.',

    sidecarTitle: isZh ? 'MedSci-Sidecar：从聊天到文档' : 'MedSci-Sidecar: from chat to document',
    sidecarBody: isZh
      ? '一句话即可生成病例总结 DOCX、学术汇报 PPTX、基线特征表格或统计图。文件上传到租户隔离的对象存储，聊天界面直接显示下载卡片；刷新页面后仍可通过 fileId 重新获取下载链接，并可一键加入知识库。'
      : 'Generate case-summary DOCX, academic PPTX, baseline tables, or plots from a single sentence. Files are uploaded to tenant-isolated object storage; the chat UI shows a download card, refresh-safe via fileId, with one-click ingestion into the knowledge base.',
    sidecarOutputs: [
      { icon: <FileText size={20} />, title: 'DOCX', desc: isZh ? '病例总结 / 出院小结' : 'Case summary / discharge summary' },
      { icon: <LayoutGrid size={20} />, title: 'PPTX', desc: isZh ? '学术汇报幻灯片' : 'Academic presentation slides' },
      { icon: <Table size={20} />, title: isZh ? '表格' : 'Table', desc: isZh ? '基线特征 / Table 1' : 'Baseline characteristics / Table 1' },
      { icon: <BarChart3 size={20} />, title: isZh ? '图表' : 'Plot', desc: isZh ? 'KM 曲线 / 柱状图' : 'KM curve / bar chart' },
    ],

    kbTitle: isZh ? '知识库：可管理、可进化' : 'Knowledge base: manageable & evolving',
    kbBody: isZh
      ? 'Articles、Facts、Gaps、Tools、Files 五大标签页均支持搜索过滤、分页与多选批量删除。Facts 可内联编辑；Knowledge Gap 把未解问题显式化，推动用户主动填补知识缺口。'
      : 'All five tabs — Articles, Facts, Gaps, Tools, and Files — support search filtering, pagination, and multi-select bulk delete. Facts can be edited inline; Knowledge Gaps make unanswered questions visible and drive user-guided evolution.',

    architectureTitle: isZh ? '双平面架构：安全与可扩展' : 'Two-plane architecture: secure & scalable',
    architectureBody: isZh
      ? '控制面（Control Plane）运行主 API、认证与业务逻辑；执行面（Execution Plane）在独立沙箱中运行插件与 Sidecar 渲染。对象存储按租户隔离，LLM 推理与文档生成互不影响。'
      : 'The Control Plane runs the main API, auth, and business logic; the Execution Plane runs plugins and Sidecar rendering in an isolated sandbox. Object storage is tenant-isolated, and LLM inference is decoupled from document generation.',

    trustTitle: isZh ? '为临床工作流设计' : 'Designed for clinical workflows',
    trustItems: [
      isZh ? '患者信息强制进入当前对话上下文' : 'Patient context is always injected into the current turn',
      isZh ? '规则优先、LLM 兜底，控制推理成本' : 'Rules first, LLM fallback to control inference cost',
      isZh ? '版本化的事实与知识，可审计、可导出' : 'Versioned facts and knowledge, auditable & exportable',
      isZh ? '执行面隔离，插件无法访问主数据库' : 'Execution-plane isolation prevents plugin access to the main DB',
    ],

    ctaTitle: isZh ? '让 AI 从您的每一次诊疗中学习' : 'Let AI learn from every case',
    ctaSubtitle: isZh
      ? '免费开始，或在您的服务器上自托管完整平台。'
      : 'Start free or self-host the full platform on your own servers.',

    footer: t('landing.footer', { year: new Date().getFullYear() }),
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Navigation */}
      <nav className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur-lg">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4">
          <Link to="/" className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-sm font-bold text-white">H</div>
            <span className="text-xl font-bold text-text-primary">{t('appName')}</span>
          </Link>
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
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" className="mr-2" aria-hidden="true">
                    <path d="M12 1C5.925 1 1 5.925 1 12c0 4.867 3.154 8.993 7.533 10.45.55.101.733-.238.733-.529 0-.262-.01-1.13-.015-2.05-3.065.665-3.71-1.47-3.71-1.47-.501-1.273-1.224-1.613-1.224-1.613-.999-.683.076-.669.076-.669 1.105.078 1.687 1.135 1.687 1.135.982 1.682 2.576 1.197 3.204.916.1-.712.384-1.197.698-1.472-2.448-.278-5.021-1.224-5.021-5.45 0-1.204.43-2.188 1.135-2.96-.114-.278-.492-1.397.108-2.912 0 0 .925-.297 3.03 1.13A10.56 10.56 0 0 1 12 6.843c.937.005 1.88.127 2.762.372 2.103-1.427 3.027-1.13 3.027-1.13.602 1.515.224 2.634.11 2.912.706.772 1.134 1.756 1.134 2.96 0 4.235-2.577 5.168-5.03 5.44.395.34.747 1.01.747 2.037 0 1.472-.014 2.657-.014 3.02 0 .293.182.633.74.526C19.85 20.99 23 16.866 23 12c0-6.075-4.925-11-11-11Z" />
                  </svg>
                  {T.github}
                </Button>
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* Problem */}
      <section className="border-y border-border bg-surface">
        <div className="mx-auto max-w-7xl px-4 py-20">
          <div className="mx-auto max-w-3xl text-center">
            <h2 className="text-3xl font-bold text-text-primary">{T.problemTitle}</h2>
            <p className="mt-4 text-lg leading-relaxed text-text-secondary">{T.problemBody}</p>
          </div>
        </div>
      </section>

      {/* Evolution loop */}
      <section className="mx-auto max-w-7xl px-4 py-24">
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
      </section>

      {/* Four-layer memory */}
      <section className="bg-surface">
        <div className="mx-auto max-w-7xl px-4 py-24">
          <div className="mb-12 text-center">
            <h2 className="text-3xl font-bold text-text-primary">{T.memoryTitle}</h2>
          </div>
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {T.memoryLayers.map((l, idx) => (
              <div key={idx} className="rounded-xl border border-border bg-background p-6 text-center shadow-sm transition-all hover:border-accent/30 hover:shadow-md">
                <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-accent/10 text-accent">
                  {l.icon}
                </div>
                <h3 className="font-semibold text-text-primary">{l.title}</h3>
                <p className="mt-2 text-sm text-text-secondary">{l.desc}</p>
              </div>
            ))}
          </div>

          <div className="mt-16 rounded-2xl border border-border bg-background p-6 sm:p-10">
            <h3 className="mb-6 text-xl font-semibold text-text-primary">{T.projectionTitle}</h3>
            <div className="space-y-4">
              {T.projectionItems.map((item, idx) => (
                <div key={idx} className="flex items-start gap-3">
                  <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent/10 text-xs font-bold text-accent">
                    {idx + 1}
                  </div>
                  <p className="text-text-secondary">{item}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Router */}
      <section className="mx-auto max-w-7xl px-4 py-24">
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <div>
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <Route size={24} />
            </div>
            <h2 className="text-3xl font-bold text-text-primary">{T.routerTitle}</h2>
            <p className="mt-4 text-lg leading-relaxed text-text-secondary">{T.routerBody}</p>
          </div>
          <div className="rounded-2xl border border-border bg-surface p-6 shadow-sm">
            <div className="space-y-3">
              {[
                { q: isZh ? '“ZL 的年龄/性别？”' : '"What is ZL\'s age/sex?"', r: 'sql' },
                { q: isZh ? '“NSCLC 最新指南怎么说？”' : '"Latest NSCLC guidelines?"', r: 'vector' },
                { q: isZh ? '“生成 ZQ 病例总结 Word”' : '"Generate a Word case summary for ZQ"', r: 'sidecar' },
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

      {/* Sidecar */}
      <section className="bg-surface">
        <div className="mx-auto max-w-7xl px-4 py-24">
          <div className="mb-12 text-center">
            <h2 className="text-3xl font-bold text-text-primary">{T.sidecarTitle}</h2>
            <p className="mx-auto mt-4 max-w-3xl text-lg leading-relaxed text-text-secondary">{T.sidecarBody}</p>
          </div>
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {T.sidecarOutputs.map((o, idx) => (
              <Card key={idx} className="p-6 text-center transition-all hover:border-accent/30">
                <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-accent/10 text-accent">
                  {o.icon}
                </div>
                <h3 className="font-semibold text-text-primary">{o.title}</h3>
                <p className="mt-2 text-sm text-text-secondary">{o.desc}</p>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* Knowledge base */}
      <section className="mx-auto max-w-7xl px-4 py-24">
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <div className="order-2 lg:order-1">
            <div className="rounded-2xl border border-border bg-surface p-6 shadow-sm">
              <div className="mb-4 flex items-center gap-2 border-b border-border pb-4">
                <BookOpen size={18} className="text-accent" />
                <span className="font-semibold text-text-primary">{isZh ? '知识库' : 'Knowledge Base'}</span>
              </div>
              <div className="space-y-3">
                {[
                  isZh ? 'Articles：自动生成的综述文章' : 'Articles: auto-generated synthesis articles',
                  isZh ? 'Facts：按患者/医生/研究/通用分组' : 'Facts: grouped by patient / doctor / research / general',
                  isZh ? 'Gaps：未解问题，支持回答/忽略' : 'Gaps: unanswered questions with answer/ignore actions',
                  isZh ? 'Tools / Files：多选、过滤、分页' : 'Tools / Files: multi-select, filter, pagination',
                ].map((row, idx) => (
                  <div key={idx} className="flex items-center gap-2 text-sm text-text-secondary">
                    <CheckCircle2 size={16} className="text-success shrink-0" />
                    {row}
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="order-1 lg:order-2">
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <Layers size={24} />
            </div>
            <h2 className="text-3xl font-bold text-text-primary">{T.kbTitle}</h2>
            <p className="mt-4 text-lg leading-relaxed text-text-secondary">{T.kbBody}</p>
          </div>
        </div>
      </section>

      {/* Architecture */}
      <section className="bg-surface">
        <div className="mx-auto max-w-7xl px-4 py-24">
          <div className="mb-12 text-center">
            <h2 className="text-3xl font-bold text-text-primary">{T.architectureTitle}</h2>
            <p className="mx-auto mt-4 max-w-3xl text-lg leading-relaxed text-text-secondary">{T.architectureBody}</p>
          </div>
          <div className="grid gap-5 sm:grid-cols-2">
            <Card className="p-6">
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-accent/10 text-accent">
                <Server size={24} />
              </div>
              <h3 className="text-lg font-semibold text-text-primary">{isZh ? '控制面 Control Plane' : 'Control Plane'}</h3>
              <p className="mt-2 text-sm text-text-secondary">{isZh ? 'Fastify + Prisma + SQLite：认证、Chat SSE、患者、研究、知识库、插件管理。' : 'Fastify + Prisma + SQLite: auth, chat SSE, patients, research, knowledge base, plugin management.'}</p>
            </Card>
            <Card className="p-6">
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-accent/10 text-accent">
                <Cpu size={24} />
              </div>
              <h3 className="text-lg font-semibold text-text-primary">{isZh ? '执行面 Execution Plane' : 'Execution Plane'}</h3>
              <p className="mt-2 text-sm text-text-secondary">{isZh ? 'FastAPI + Redis + heurion_worker：Sidecar 渲染、插件沙箱、对象存储上传。' : 'FastAPI + Redis + heurion_worker: Sidecar rendering, plugin sandbox, object-storage upload.'}</p>
            </Card>
          </div>
        </div>
      </section>

      {/* Trust */}
      <section className="mx-auto max-w-7xl px-4 py-24">
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <div>
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <Shield size={24} />
            </div>
            <h2 className="text-3xl font-bold text-text-primary">{T.trustTitle}</h2>
          </div>
          <ul className="space-y-4">
            {T.trustItems.map((text, idx) => (
              <li key={idx} className="flex items-start gap-3 text-text-secondary">
                <Lock size={18} className="mt-0.5 shrink-0 text-success" />
                <span>{text}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Stats */}
      <section className="border-y border-border bg-surface">
        <div className="mx-auto max-w-7xl px-4 py-12">
          <div className="grid grid-cols-2 gap-8 sm:grid-cols-4">
            <StatCard value="4" label={isZh ? '层记忆' : 'Memory layers'} />
            <StatCard value="6" label={isZh ? '步进化闭环' : 'Evolution stages'} />
            <StatCard value="P10" label={isZh ? '知识管线阶段' : 'Pipeline phases'} />
            <StatCard value="2" label={isZh ? '独立平面' : 'Isolated planes'} />
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="bg-surface">
        <div className="mx-auto max-w-7xl px-4 py-24 text-center">
          <h2 className="text-3xl font-bold text-text-primary">{T.ctaTitle}</h2>
          <p className="mx-auto mt-4 max-w-xl text-text-secondary">{T.ctaSubtitle}</p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link to="/login?mode=register">
              <Button size="lg" className="px-8">{T.startFree}</Button>
            </Link>
            <a href="https://github.com/0xaicrypto/heurion" target="_blank" rel="noreferrer">
              <Button variant="secondary" size="lg" className="px-8">
                <Globe size={18} className="mr-2" />
                {T.selfHostDocs}
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
          <p className="mt-6 text-center text-xs text-text-tertiary">{T.footer}</p>
        </div>
      </footer>
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
