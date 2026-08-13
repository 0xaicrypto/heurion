import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import {
  ArrowRight,
  Brain,
  AlertTriangle,
  Activity,
  Lock,
  Terminal,
  ShieldCheck,
  FileKey,
  Globe,
  Image as ImageIcon,
  Puzzle,
  BookOpen,
} from 'lucide-react';
import { Button, Card } from '@/components/ui';
import { MarketingShell } from '@/components/marketing/MarketingShell';


/**
 * #519-followup: 正式统计图表样例 — 带误差棒(95% CI)与显著性标注。
 * 数据为演示示例,仅用于展示图表样式(诚实原则:不冒充真实结果)。
 */
function EfficacyBarChartSample() {
  const bars = [
    { label: 'A 组', value: 75, ciLow: 65, ciHigh: 85 },
    { label: 'B 组', value: 82, ciLow: 73, ciHigh: 91 },
  ]
  const chartW = 480
  const chartH = 300
  const padL = 48
  const padB = 36
  const padT = 44
  const plotW = chartW - padL - 20
  const plotH = chartH - padT - padB
  const yMax = 100
  const y = (v: number) => padT + plotH * (1 - v / yMax)
  const x = (i: number) => padL + plotW * (0.25 + i * 0.5)
  const barW = 72
  const ticks = [0, 25, 50, 75, 100]

  return (
    <svg viewBox={`0 0 ${chartW} ${chartH}`} role="img" aria-label="两组治疗有效率对比示例图" className="mx-auto block max-w-[420px]">
      <title>两组治疗有效率对比(示例数据)</title>
      {/* axes */}
      <line x1={padL} y1={padT} x2={padL} y2={padT + plotH} stroke="hsl(var(--border-strong))" strokeWidth={1} />
      <line x1={padL} y1={padT + plotH} x2={chartW - 20} y2={padT + plotH} stroke="hsl(var(--border-strong))" strokeWidth={1} />
      {ticks.map((t) => (
        <g key={t}>
          <line x1={padL} y1={y(t)} x2={chartW - 20} y2={y(t)} stroke="hsl(var(--border))" strokeWidth={0.5} strokeDasharray="3 3" />
          <text x={padL - 8} y={y(t) + 4} textAnchor="end" fontSize={11} fill="hsl(var(--text-tertiary))">{t}%</text>
        </g>
      ))}
      {/* bars + error bars */}
      {bars.map((b, i) => (
        <g key={b.label}>
          <rect x={x(i) - barW / 2} y={y(b.value)} width={barW} height={y(0) - y(b.value)} rx={4} fill={i === 0 ? 'hsl(var(--accent))' : 'hsl(var(--accent) / 0.55)'} />
          <line x1={x(i)} y1={y(b.ciHigh)} x2={x(i)} y2={y(b.ciLow)} stroke="hsl(var(--text-primary))" strokeWidth={1.5} />
          <line x1={x(i) - 10} y1={y(b.ciHigh)} x2={x(i) + 10} y2={y(b.ciHigh)} stroke="hsl(var(--text-primary))" strokeWidth={1.5} />
          <line x1={x(i) - 10} y1={y(b.ciLow)} x2={x(i) + 10} y2={y(b.ciLow)} stroke="hsl(var(--text-primary))" strokeWidth={1.5} />
          <text x={x(i)} y={y(0) + 22} textAnchor="middle" fontSize={13} fontWeight={600} fill="hsl(var(--text-primary))">{b.label}</text>
          <text x={x(i)} y={y(0) + 40} textAnchor="middle" fontSize={11} fill="hsl(var(--text-tertiary))">{b.value}%</text>
        </g>
      ))}
      {/* significance annotation */}
      <text x={(x(0) + x(1)) / 2} y={padT - 10} textAnchor="middle" fontSize={13} fontWeight={600} fill="hsl(var(--text-secondary))">P = 0.56 (ns)</text>
      <line x1={(x(0) + x(1)) / 2 - 40} y1={padT - 4} x2={(x(0) + x(1)) / 2 + 40} y2={padT - 4} stroke="hsl(var(--text-secondary))" strokeWidth={1} />
    </svg>
  )
}

export function LandingPage() {
  const { i18n } = useTranslation();
  const isZh = i18n.language.startsWith('zh');

  const T = {
    tagline: isZh ? '面向临床科研的数字化医疗助手' : 'A digital medical research assistant',
    title: isZh ? '让 AI 拥有临床记忆与执行能力' : 'Give AI clinical memory and execution',
    subtitle: isZh
      ? 'Heurion 用“双平面架构”重建医疗 AI 的大脑与双手：Control Plane 沉淀可溯源、可失效传播的 DAG 记忆；Execution Plane 在隔离沙箱中直接生成 DOCX、PPTX、统计图表。'
      : 'Heurion rebuilds medical AI with a dual-plane architecture: a Control Plane that builds traceable, stale-propagating DAG memory, and an Execution Plane that generates DOCX, PPTX, and plots inside an isolated sandbox.',
    startFree: isZh ? '免费开始使用' : 'Start Free',
    github: 'GitHub',

    painsTitle: isZh ? '临床场景中医疗大模型的三大失效模式' : 'Three failure modes of medical LLMs in clinical practice',
    pains: [
      {
        icon: <Brain size={28} />,
        title: isZh ? '会话级记忆缺失' : 'No persistent memory',
        desc: isZh
          ? '每次打开对话框，AI 都不认识患者。复诊、写总结前，医生得把过去 3 年的化验单、基因突变、影像记录重新粘贴一遍。'
          : 'Every session starts from scratch. Before a follow-up or summary, doctors must re-paste years of labs, mutations, and imaging.',
      },
      {
        icon: <AlertTriangle size={28} />,
        title: isZh ? '幻觉与黑盒' : 'Hallucination & black box',
        desc: isZh
          ? 'AI 生成的病例总结很漂亮，但医生不敢用：指标可能是编造的，且无法点击追溯到具体日期的病历。'
          : 'Generated summaries look polished, but doctors cannot trust them: metrics may be invented, and sources cannot be traced.',
      },
      {
        icon: <Activity size={28} />,
        title: isZh ? '缺乏执行能力：仅限对话' : 'No execution: chat only',
        desc: isZh
          ? '“帮我把随访数据清洗一下，画一张 KM 曲线。”通用 AI 只能回答：“抱歉，我是一个语言模型，无法作图。”'
          : '"Clean this follow-up data and plot a KM curve." Generic AI replies: "Sorry, I am a language model and cannot generate charts."',
      },
    ],

    dualPlaneTitle: isZh ? '双平面架构：大脑 + 双手' : 'Dual-Plane Architecture: brain + hands',
    dualPlaneSubtitle: isZh
      ? '无需理解底层实现：Heurion 由具备持久临床记忆的智能大脑与在隔离沙箱中完成执行与交付的执行引擎构成。'
      : 'No implementation details required: Heurion pairs a brain with persistent clinical memory and an execution engine that delivers results inside an isolated sandbox.',

    controlPlane: {
      label: isZh ? '🧠 Control Plane · 记忆引擎' : '🧠 Control Plane · Memory Engine',
      title: isZh ? '持久记忆与完整溯源' : 'Persistent memory & full provenance',
      points: [
        isZh ? '临床原始输入被不可变记录' : 'Raw clinical inputs are recorded immutably',
        isZh ? '记忆以可组合的知识单元组织成 DAG 图谱' : 'Memory is organized as a DAG graph of composable knowledge units',
        isZh ? '底层数据一旦变更，上层报告自动标记失效' : 'When underlying data changes, downstream reports auto-mark stale',
        isZh ? '发现数据缺失时主动提问，而非编造' : 'When data is missing, the AI asks instead of hallucinating',
        isZh ? '每个结论都可点击追溯到具体日期的病历' : 'Every conclusion is one click away from its source record',
      ],
    },
    executionPlane: {
      label: isZh ? '⚙️ Execution Plane · 执行沙箱' : '⚙️ Execution Plane · Sandbox',
      title: isZh ? '执行与交付引擎' : 'Execution & delivery engine',
      points: [
        isZh ? '自然语言指令触发隔离沙箱' : 'Natural-language commands trigger an isolated sandbox',
        isZh ? '自动执行数据分析、清洗与图表渲染' : 'Automated data analysis, cleaning, and figure rendering',
        isZh ? '直接交付 DOCX、PPTX、Table 1、KM 曲线' : 'Directly deliver DOCX, PPTX, Table 1, KM curves',
        isZh ? '沙箱崩溃不影响核心患者数据库' : 'Sandbox crashes never touch core patient data',
        isZh ? '数据不出院，算力可本地化部署' : 'Data never leaves the hospital; compute can be on-premise',
      ],
    },

    // #515: 独特能力露出 — 已上线且可演示的差异化能力。
    uniqueCards: [
      {
        icon: <Globe size={24} />,
        title: isZh ? '浏览器自动化' : 'Browser automation',
        desc: isZh
          ? '用自然语言指令让 AI 登录系统、查询与采集网页信息（Agent Browser）。也可用于回归测试：模拟真实用户旅程验证平台功能。'
          : 'Tell the AI to log in, query, and collect web information (Agent Browser). Also powers regression testing that simulates real user journeys.',
      },
      {
        icon: <ImageIcon size={24} />,
        title: isZh ? '上传即解读' : 'Upload & interpret',
        desc: isZh
          ? '上传化验单、影像截图或手写记录，AI 直接解读并结构化（视觉模型支持，非视觉模型走 OCR 并明确标注来源）。'
          : 'Upload lab reports, imaging snapshots, or notes and the AI interprets them directly (vision models; OCR fallback with explicit sourcing).',
      },
      {
        icon: <Puzzle size={24} />,
        title: isZh ? '可扩展的插件生态' : 'Extensible plugin ecosystem',
        desc: isZh
          ? '统计图表（chart）、3D 生物场景（bioscene）、网页操作（browser-agent）等能力按需安装启用，核心平台保持轻量。'
          : 'Statistical charts (chart), 3D bioscience scenes (bioscene), and web operations (browser-agent) install on demand — the core stays lean.',
      },
    ],

    ctaTitle: isZh ? '把科室的隐性经验，沉淀为可继承的数据资产' : 'Turn tacit expertise into inheritable data assets',
    ctaSubtitle: isZh
      ? '免费开始，或在您的服务器上自托管完整平台。'
      : 'Start free or self-host the full platform on your own servers.',
    docsCta: isZh ? '查看用户指南' : 'User Guide',

    // #514: 医疗定位与合规澄清 — 面向潜在客户的第一句专业声明。
    complianceTitle: isZh ? '医疗定位与合规' : 'Medical positioning & compliance',
    complianceIntro: isZh
      ? 'Heurion 是面向临床科研的辅助工具，不提供诊断或治疗决策建议。所有 AI 输出必须由执业医师审阅确认。'
      : 'Heurion is a clinical research assistance tool. It does not provide diagnoses or treatment decisions — every AI output must be reviewed and confirmed by a licensed physician.',
    compliancePoints: [
      {
        icon: <ShieldCheck size={20} />,
        title: isZh ? '科研辅助定位' : 'Research-assistance positioning',
        desc: isZh
          ? '用于病历摘要、随访管理、数据清洗与科研报告；AI 生成内容仅供参考，不作为临床决策依据。'
          : 'For charting, follow-up management, data cleaning, and research reporting. AI-generated content is reference-only, never a basis for clinical decisions.',
      },
      {
        icon: <Lock size={20} />,
        title: isZh ? '数据不出院' : 'Data stays inside',
        desc: isZh
          ? '支持纯本地化部署，敏感数据不离开院区；隔离沙箱与核心病历库物理分离。'
          : 'On-premise deployment keeps sensitive data inside the hospital; the sandbox is isolated from core records.',
      },
      {
        icon: <FileKey size={20} />,
        title: isZh ? '可审计溯源' : 'Auditable provenance',
        desc: isZh
          ? '不可变 EventLog 记录每一次访问与生成；每个结论可点击追溯至具体日期的病历原文。'
          : 'An immutable EventLog records every access and generation; every conclusion traces back to its source record.',
      },
    ],
    complianceFootnote: isZh
      ? '* Heurion 不构成医疗器械，不用于诊断、治疗或预后判断；部署前请按机构法规完成评估。'
      : '* Heurion is not a medical device and is not intended for diagnosis, treatment, or prognosis. Evaluate against your institution\u2019s regulations before deployment.',

    // #519: 真实临床工作流演示 — 统计方法学严谨性露出。
    workflowTitle: isZh ? '正式统计图表,方法学完整标注' : 'Formal statistical figures, methodology annotated',
    workflowSubtitle: isZh
      ? '两组比较示例:误差棒(95% CI)、P 值与样本量——科研级图表可直接交付。'
      : 'Two-group example: error bars (95% CI), p-values and sample size — publication-grade figures.',
    workflowSampleLabel: isZh
      ? '示例数据：仅用于演示图表样式，不代表任何真实研究结果'
      : 'Sample data: for style demonstration only, not real study results',

    // #518: 合作伙伴与致谢。
    partnersTitle: isZh ? '合作伙伴与致谢' : 'Partners & acknowledgements',
    partnersIntro: isZh
      ? 'Heurion 构建于开放的技术生态之上，感谢以下平台与项目的支撑。'
      : 'Heurion is built on an open technical ecosystem. Thanks to the platforms and projects below.',
    // #518-followup: 合并去重(Cloudflare agents 并入 Cloudflare),以 logo 墙为主。
    // #518-followup: 官方彩色 logo。Cloudflare 为品牌彩色;Vercel/GitHub/
    // opencode 官方 logo 本身即单色(mono=true),dark 主题下反白适配。
    partners: [
      { name: 'Cloudflare', logo: '/partners/cloudflare.png', mono: false, url: 'https://cloudflare.com', desc: isZh ? 'Workers · Browser Run · Agents' : 'Workers · Browser Run · Agents' },
      { name: 'Reactome', logo: '/partners/reactome.png', mono: false, url: 'https://reactome.org', desc: isZh ? '通路图数据（CC BY 4.0）' : 'Pathway data (CC BY 4.0)' },
      { name: 'Vercel', logo: '/partners/vercel.png', mono: true, url: 'https://vercel.com', desc: isZh ? 'AI SDK · 工具调用与多模态' : 'AI SDK · tools & multimodal' },
      { name: 'GitHub', logo: '/partners/github.png', mono: true, url: 'https://github.com', desc: isZh ? '开源托管 · 自动化交付' : 'Hosting · automation' },
    ],
    partnersFootnote: isZh
      ? '以及所有为开源与医疗信息化做出贡献的开发者。'
      : 'And every developer contributing to open source and health informatics.',
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
            <h1 className="text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl lg:text-6xl">
              {T.title}
            </h1>
            <p className="mx-auto mt-8 max-w-3xl text-lg leading-relaxed text-text-secondary sm:text-xl">
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

      {/* Pain points */}
      <section className="border-y border-border bg-surface">
        <div className="mx-auto max-w-7xl px-4 py-24">
          <div className="mb-12 text-center">
            <h2 className="text-3xl font-bold text-text-primary sm:text-4xl">{T.painsTitle}</h2>
          </div>
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {T.pains.map((p, idx) => (
              <Card key={idx} className="h-full border-error/10 bg-error/5 p-8">
                <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-xl bg-error/10 text-error">
                  {p.icon}
                </div>
                <h3 className="text-xl font-bold text-text-primary">{p.title}</h3>
                <p className="mt-3 leading-relaxed text-text-secondary">{p.desc}</p>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* Dual-Plane architecture */}
      <section className="mx-auto max-w-7xl px-4 py-24">
        <div className="mb-12 text-center">
          <h2 className="text-3xl font-bold text-text-primary sm:text-4xl">{T.dualPlaneTitle}</h2>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-text-secondary">{T.dualPlaneSubtitle}</p>
        </div>

        <div className="grid gap-8 lg:grid-cols-2">
          {/* Control Plane */}
          <Card className="relative overflow-hidden border-l-4 border-l-accent p-8">
            <div className="absolute -right-6 -top-6 h-32 w-32 rounded-full bg-accent/5" />
            <span className="text-sm font-semibold uppercase tracking-wider text-accent">
              {T.controlPlane.label}
            </span>
            <h3 className="mt-2 text-2xl font-bold text-text-primary">{T.controlPlane.title}</h3>
            <ul className="mt-6 space-y-4">
              {T.controlPlane.points.map((pt, idx) => (
                <li key={idx} className="flex items-start gap-3 text-text-secondary">
                  <Brain size={18} className="mt-0.5 shrink-0 text-accent" />
                  <span>{pt}</span>
                </li>
              ))}
            </ul>
          </Card>

          {/* Execution Plane */}
          <Card className="relative overflow-hidden border-l-4 border-l-accent p-8">
            <div className="absolute -right-6 -top-6 h-32 w-32 rounded-full bg-accent/5" />
            <span className="text-sm font-semibold uppercase tracking-wider text-accent">
              {T.executionPlane.label}
            </span>
            <h3 className="mt-2 text-2xl font-bold text-text-primary">{T.executionPlane.title}</h3>
            <ul className="mt-6 space-y-4">
              {T.executionPlane.points.map((pt, idx) => (
                <li key={idx} className="flex items-start gap-3 text-text-secondary">
                  <Terminal size={18} className="mt-0.5 shrink-0 text-accent" />
                  <span>{pt}</span>
                </li>
              ))}
            </ul>
          </Card>
        </div>

        {/* 独特能力徽章:已上线的差异化能力(原独立区块并入)。 */}
        <div className="mt-10 grid gap-4 sm:grid-cols-3">
          {T.uniqueCards.map((p, idx) => (
            <div key={idx} className="flex items-start gap-3 rounded-lg border border-border bg-surface p-4">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
                {p.icon}
              </span>
              <div>
                <h4 className="text-sm font-bold text-text-primary">{p.title}</h4>
                <p className="mt-1 text-xs leading-relaxed text-text-secondary">{p.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* #514: 医疗定位与合规 — 紧凑底部条(专业澄清,不占篇幅)。 */}
      <section className="border-t border-border bg-surface py-10">
        <div className="mx-auto max-w-5xl px-4 text-center">
          <p className="text-sm font-semibold text-text-primary">{T.complianceIntro}</p>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-x-8 gap-y-2 text-sm text-text-secondary">
            {T.compliancePoints.map((p, idx) => (
              <span key={idx} className="inline-flex items-center gap-1.5">
                <span className="text-accent">{p.icon}</span>
                {p.title}: {p.desc}
              </span>
            ))}
          </div>
          <p className="mt-3 text-xs text-text-tertiary">{T.complianceFootnote}</p>
        </div>
      </section>

      {/* #519: 统计图表成果样例 — 方法学严谨性露出(流程细节见 /docs 指南)。 */}
      <section className="mx-auto max-w-7xl px-4 py-20">
        <div className="mb-10 text-center">
          <h2 className="text-3xl font-bold text-text-primary sm:text-4xl">{T.workflowTitle}</h2>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-text-secondary">{T.workflowSubtitle}</p>
        </div>
        <div className="mx-auto max-w-xl rounded-xl border border-border bg-surface p-6">
          <EfficacyBarChartSample />
          <p className="mt-3 text-center text-xs text-text-tertiary">{T.workflowSampleLabel}</p>
        </div>
      </section>

      {/* #518: 合作伙伴与致谢。 */}
      <section className="border-t border-border bg-surface py-16">
        <div className="mx-auto max-w-7xl px-4 text-center">
          <h2 className="text-2xl font-bold text-text-primary">{T.partnersTitle}</h2>
          <p className="mx-auto mt-3 max-w-2xl text-sm text-text-secondary">{T.partnersIntro}</p>
          <div className="mt-8 flex flex-wrap items-stretch justify-center gap-6">
            {T.partners.map((p, idx) => (
              <a
                key={idx}
                href={p.url}
                target="_blank"
                rel="noreferrer"
                className="group flex w-40 flex-col items-center gap-2 rounded-xl border border-border bg-surface-elevated p-5 transition-colors hover:border-accent/30"
              >
                <img
                  src={p.logo}
                  alt={p.name}
                  className={cn('h-9 w-auto transition-colors group-hover:opacity-80', p.mono && 'dark:invert')}
                />
                <span className="text-sm font-semibold text-text-primary">{p.name}</span>
              </a>
            ))}
          </div>
          <p className="mt-6 text-xs text-text-tertiary">{T.partnersFootnote}</p>
        </div>
      </section>

      {/* CTA */}
      <section className="relative overflow-hidden border-t border-border bg-surface">
        <div className="absolute inset-0 bg-gradient-to-r from-accent/5 via-transparent to-accent/5" />
        <div className="relative mx-auto max-w-7xl px-4 py-24 text-center">
          <h2 className="text-3xl font-bold text-text-primary sm:text-4xl">{T.ctaTitle}</h2>
          <p className="mx-auto mt-4 max-w-xl text-text-secondary">{T.ctaSubtitle}</p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link to="/login?mode=register">
              <Button size="lg" className="px-8">
                {T.startFree}
                <ArrowRight size={18} className="ml-2" />
              </Button>
            </Link>
            <a href="https://github.com/0xaicrypto/heurion" target="_blank" rel="noreferrer">
              <Button variant="secondary" size="lg" className="px-8">
                {T.github}
              </Button>
            </a>
            <a href="/docs/">
              <Button variant="ghost" size="lg" className="px-8">
                <BookOpen size={18} className="mr-2" />
                {T.docsCta}
              </Button>
            </a>
          </div>
        </div>
      </section>
    </MarketingShell>
  );
}
