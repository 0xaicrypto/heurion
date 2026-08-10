import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowRight,
  Brain,
  Cpu,
  FlaskConical,
  AlertTriangle,
  Search,
  Activity,
  CheckCircle,
  XCircle,
  FileText,
  Users,
  Lock,
  Terminal,
  ShieldCheck,
  FileKey,
  Globe,
  Image as ImageIcon,
  BarChart3,
  Puzzle,
  Stethoscope,
  Presentation,
} from 'lucide-react';
import { Button, Card } from '@/components/ui';
import { MarketingShell } from '@/components/marketing/MarketingShell';

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
        isZh ? '临床原始输入写入不可变 EventLog' : 'Raw clinical inputs are written to an immutable EventLog',
        isZh ? '原子 Facts 组合成 Articles，构成 DAG 记忆图谱' : 'Atomic facts compose articles, forming a DAG memory graph',
        isZh ? '底层数据一改，上层报告自动标红 Stale' : 'When underlying data changes, downstream reports auto-mark stale',
        isZh ? '发现数据缺失，AI 主动提出 Gaps 而非瞎编' : 'When data is missing, the AI raises gaps instead of hallucinating',
        isZh ? '每一个结论都能点击追溯到具体日期的病历' : 'Every conclusion is one click away from its source record',
      ],
    },
    executionPlane: {
      label: isZh ? '⚙️ Execution Plane · 执行沙箱' : '⚙️ Execution Plane · Sandbox',
      title: isZh ? '执行与交付引擎' : 'Execution & delivery engine',
      points: [
        isZh ? '自然语言指令触发隔离沙箱' : 'Natural-language commands trigger an isolated sandbox',
        isZh ? '自动运行 Python / 渲染引擎清洗数据' : 'Python and rendering engines clean data automatically',
        isZh ? '直接交付 DOCX、PPTX、Table 1、KM 曲线' : 'Directly deliver DOCX, PPTX, Table 1, KM curves',
        isZh ? '沙箱崩溃不影响核心患者数据库' : 'Sandbox crashes never touch core patient data',
        isZh ? '数据不出院，算力可本地化部署' : 'Data never leaves the hospital; compute can be on-premise',
      ],
    },

    // #515: 独特能力露出 — 已上线且可演示的差异化能力。
    uniqueTitle: isZh ? '从对话到行动：三大独特能力' : 'From conversation to action: three distinctive capabilities',
    uniqueSubtitle: isZh
      ? '不只是问答：AI 能替你操作真实网页、直接解读上传的图片，并在数据缺失时诚实说明。'
      : 'More than Q&A: the AI operates real web pages for you, reads uploaded images, and is honest when data is missing.',
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

    personasTitle: isZh ? '面向三种关键角色' : 'Built for three critical roles',
    personas: [
      {
        icon: <Users size={24} />,
        role: isZh ? '临床医生 / MDT 负责人' : 'Clinicians / MDT leads',
        quote: isZh
          ? '“复诊前一句话唤起患者三年的完整随访轨迹：化验趋势、基因变异、影像结论全部按时间轴排列，每一条都能点击回原始报告。写病程或 MDT 汇报时，引用内容全部带可核对的出处。”'
          : '"One sentence recalls a patient\u2019s full multi-year trajectory: lab trends, mutations, and imaging conclusions on a single timeline, each traceable to its original report. Every citation in my MDT summaries is verifiable."',
      },
      {
        icon: <FlaskConical size={24} />,
        role: isZh ? '医学研究员 / PI / 科研助理' : 'Researchers / PIs / assistants',
        quote: isZh
          ? '“Heurion 是带了‘手’的 AI。一句指令就能跑 Python 清洗数据、生成 Table 1、渲染带 KM 生存曲线的学术 PPT，并且反哺到知识库。”'
          : '"Heurion has hands. One command runs Python, generates Table 1, renders a PPT with KM curves, and feeds the results back into the knowledge base."',
      },
      {
        icon: <Lock size={24} />,
        role: isZh ? '医院信息科 / 药企合规' : 'Hospital IT / pharma compliance',
        quote: isZh
          ? '“Docker Compose 纯本地化部署，敏感数据不出院；不可变 EventLog 让每一次增删改查都有迹可循；双平面隔离让科研计算崩溃也不会触碰核心病历库。”'
          : '"Docker Compose on-premise keeps sensitive data inside. Immutable EventLog supports audits. Dual-plane isolation protects core records even if research code crashes."',
      },
    ],

    battleTitle: isZh ? '竞品攻防：为什么不是 ChatGPT / RAG？' : 'Why not ChatGPT / RAG?',
    battleCards: [
      {
        icon: <XCircle size={24} />,
        title: isZh ? '通用大模型' : 'General-purpose LLMs',
        cons: isZh
          ? '无状态，每次对话都在遗忘；会编造数据；无法执行代码、生成文件。'
          : 'Stateless; forgets every turn; hallucinates data; cannot execute code or generate files.',
        pro: isZh
          ? 'Heurion 通过 DAG 图谱 + Gaps 机制主动发问，每个事实都有版本号可追溯，且能直接交付科研成果。'
          : 'Heurion uses a DAG graph + gaps mechanism, traces every fact, and delivers research outputs directly.',
      },
      {
        icon: <Search size={24} />,
        title: isZh ? '传统 RAG 知识库' : 'Traditional RAG knowledge bases',
        cons: isZh
          ? '静态切片搜索，文档更新后前后矛盾；没有 Stale 失效传播，全院数据一致性差。'
          : 'Static chunk search; documents contradict after updates; no stale propagation; poor consistency.',
        pro: isZh
          ? 'Heurion 的记忆是“活的生命体”：底层 Facts 修改后，所有依赖它的 Articles 自动标红失效，保证全院一致。'
          : 'Heurion memory is a living system: when a fact changes, every article that depends on it is auto-marked stale.',
      },
      {
        icon: <BarChart3 size={24} />,
        title: isZh ? '通用 AI 图表生成' : 'Generic AI chart generation',
        cons: isZh
          ? '数据缺失时编造示例数值并呈现为“结果”；统计口径与样本量无法核对。'
          : 'Fabricates placeholder values and presents them as results; methodology and sample sizes cannot be verified.',
        pro: isZh
          ? 'Heurion 在数据缺失时明确说明并索要真实数据，绝不编造；统计图表标注方法学（检验类型、P 值、样本量）。'
          : 'Heurion states explicitly when data is missing and asks for the real numbers — no fabrication; charts carry methodology (test, p-value, N).',
      },
    ],

    ctaTitle: isZh ? '把科室的隐性经验，沉淀为可继承的数据资产' : 'Turn tacit expertise into inheritable data assets',
    ctaSubtitle: isZh
      ? '免费开始，或在您的服务器上自托管完整平台。'
      : 'Start free or self-host the full platform on your own servers.',

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
          ? '支持纯本地化部署（Docker Compose），敏感数据不离开院区；隔离沙箱与核心病历库物理分离。'
          : 'On-premise deployment (Docker Compose) keeps sensitive data inside the hospital; the sandbox is isolated from core records.',
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
    workflowTitle: isZh ? '一次真实的临床科研工作流' : 'A real clinical research workflow',
    workflowSubtitle: isZh
      ? '从随访问答到学术成果交付，全程可溯源、可复现。'
      : 'From follow-up Q&A to a publishable deliverable — fully traceable and reproducible.',
    workflowSteps: [
      {
        icon: <Stethoscope size={18} />,
        title: isZh ? '随访问答' : 'Follow-up Q&A',
        desc: isZh ? '一句话唤起患者多年随访轨迹：化验趋势、基因变异、影像结论按时间轴排列。' : 'One sentence recalls the patient trajectory: labs, mutations, imaging on one timeline.',
      },
      {
        icon: <FileText size={18} />,
        title: isZh ? '溯源总结' : 'Traceable summaries',
        desc: isZh ? '生成病程与 MDT 汇报，每条引用可点击回原始报告。' : 'Progress notes and MDT reports, every citation traceable to the source record.',
      },
      {
        icon: <Terminal size={18} />,
        title: isZh ? '数据清洗' : 'Data cleaning',
        desc: isZh ? '自然语言触发隔离沙箱运行 Python 清洗随访数据。' : 'Natural language triggers an isolated sandbox to clean follow-up data.',
      },
      {
        icon: <BarChart3 size={18} />,
        title: isZh ? '统计图表' : 'Statistical figures',
        desc: isZh ? 'Table 1、KM 曲线、卡方检验，标注方法学与样本量。' : 'Table 1, KM curves, chi-square — methodology and sample size annotated.',
      },
      {
        icon: <Presentation size={18} />,
        title: isZh ? '成果交付' : 'Deliverables',
        desc: isZh ? '一键导出学术 PPT / DOCX，并反哺知识库。' : 'One-click export of academic PPT/DOCX, feeding the knowledge base.',
      },
    ],
    workflowSampleLabel: isZh
      ? '样例：带误差棒与显著性标注的正式统计图表（占位）'
      : 'Sample: formal statistical figure with error bars and significance (placeholder)',

    // #518: 合作伙伴与致谢。
    partnersTitle: isZh ? '合作伙伴与致谢' : 'Partners & acknowledgements',
    partnersIntro: isZh
      ? 'Heurion 构建于开放的技术生态之上，感谢以下平台与项目的支撑。'
      : 'Heurion is built on an open technical ecosystem. Thanks to the platforms and projects below.',
    partners: [
      { name: 'Cloudflare', desc: isZh ? 'Workers 平台与 Browser Run 浏览器执行服务' : 'Workers platform & Browser Run browser execution' },
      { name: 'opencode.ai', desc: isZh ? 'zen 网关：多模型统一访问' : 'zen gateway: unified model access' },
      { name: 'Vercel AI SDK', desc: isZh ? 'ai / @ai-sdk：工具调用与多模态消息' : 'ai / @ai-sdk: tool calls & multimodal messages' },
      { name: 'Cloudflare agents', desc: isZh ? 'Agent Browser 浏览器自动化工具集' : 'Agent Browser automation toolkit' },
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

        {/* Simple architecture diagram */}
        <div className="mt-12 hidden items-center justify-center gap-4 rounded-lg border border-border bg-surface p-8 lg:flex">
          <div className="flex w-56 flex-col items-center rounded-xl border border-accent/30 bg-accent/5 p-5 text-center">
            <Brain size={32} className="text-accent" />
            <span className="mt-2 font-semibold text-text-primary">
              {isZh ? 'Control Plane' : 'Control Plane'}
            </span>
            <span className="text-xs text-text-secondary">{isZh ? '记忆 · 溯源 · 合规' : 'Memory · Provenance · Compliance'}</span>
          </div>
          <div className="flex flex-col items-center gap-1 text-text-tertiary">
            <span className="text-xs uppercase tracking-wider">{isZh ? '可信数据' : 'Trusted data'}</span>
            <div className="h-px w-24 bg-border" />
            <span className="text-xs uppercase tracking-wider">{isZh ? '执行结果' : 'Results'}</span>
          </div>
          <div className="flex w-56 flex-col items-center rounded-xl border border-accent/30 bg-accent/5 p-5 text-center">
            <Cpu size={32} className="text-accent" />
            <span className="mt-2 font-semibold text-text-primary">
              {isZh ? 'Execution Plane' : 'Execution Plane'}
            </span>
            <span className="text-xs text-text-secondary">{isZh ? 'Python · DOCX · PPTX · 图表' : 'Python · DOCX · PPTX · Plots'}</span>
          </div>
          <div className="ml-4 flex flex-col gap-2">
            <div className="flex items-center gap-2 text-sm text-text-secondary">
              <FileText size={16} className="text-accent" />
              <span>DOCX / PPTX</span>
            </div>
            <div className="flex items-center gap-2 text-sm text-text-secondary">
              <Activity size={16} className="text-accent" />
              <span>{isZh ? '统计图表' : 'Statistical plots'}</span>
            </div>
          </div>
        </div>
      </section>

      {/* #515: Distinctive capabilities — already shipped, demonstrable
          differentiators (Agent Browser / multimodal / plugin ecosystem). */}
      <section className="border-y border-border bg-surface">
        <div className="mx-auto max-w-7xl px-4 py-24">
          <div className="mb-12 text-center">
            <h2 className="text-3xl font-bold text-text-primary sm:text-4xl">{T.uniqueTitle}</h2>
            <p className="mx-auto mt-4 max-w-2xl text-lg text-text-secondary">{T.uniqueSubtitle}</p>
          </div>
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {T.uniqueCards.map((p, idx) => (
              <Card key={idx} className="h-full p-8">
                <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-xl bg-accent/10 text-accent">
                  {p.icon}
                </div>
                <h3 className="text-lg font-bold text-text-primary">{p.title}</h3>
                <p className="mt-3 leading-relaxed text-text-secondary">{p.desc}</p>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* Personas */}
      <section className="bg-surface">
        <div className="mx-auto max-w-7xl px-4 py-24">
          <div className="mb-12 text-center">
            <h2 className="text-3xl font-bold text-text-primary sm:text-4xl">{T.personasTitle}</h2>
          </div>
          <div className="grid gap-6 lg:grid-cols-3">
            {T.personas.map((p, idx) => (
              <Card key={idx} className="h-full p-8">
                <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-xl bg-accent/10 text-accent">
                  {p.icon}
                </div>
                <h3 className="text-lg font-bold text-text-primary">{p.role}</h3>
                <p className="mt-4 italic leading-relaxed text-text-secondary">{p.quote}</p>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* Battlecards */}
      <section className="mx-auto max-w-7xl px-4 py-24">
        <div className="mb-12 text-center">
          <h2 className="text-3xl font-bold text-text-primary sm:text-4xl">{T.battleTitle}</h2>
        </div>
        <div className="grid gap-6 lg:grid-cols-2">
          {T.battleCards.map((b, idx) => (
            <Card key={idx} className="p-8">
              <div className="mb-4 flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-error/10 text-error">
                  {b.icon}
                </div>
                <h3 className="text-xl font-bold text-text-primary">{b.title}</h3>
              </div>
              <div className="space-y-4">
                <div className="flex items-start gap-3 rounded-lg bg-error/5 p-4 text-text-secondary">
                  <XCircle size={18} className="mt-0.5 shrink-0 text-error" />
                  <span>{b.cons}</span>
                </div>
                <div className="flex items-start gap-3 rounded-lg bg-success/5 p-4 text-text-secondary">
                  <CheckCircle size={18} className="mt-0.5 shrink-0 text-success" />
                  <span>{b.pro}</span>
                </div>
              </div>
            </Card>
          ))}
        </div>
      </section>

      {/* #514: Medical positioning & compliance — the first professional
          statement prospective customers (physicians / hospital IT /
          compliance) should see. */}
      <section className="border-t border-border bg-surface">
        <div className="mx-auto max-w-7xl px-4 py-24">
          <div className="mb-12 text-center">
            <h2 className="text-3xl font-bold text-text-primary sm:text-4xl">{T.complianceTitle}</h2>
            <p className="mx-auto mt-4 max-w-3xl text-lg leading-relaxed text-text-secondary">{T.complianceIntro}</p>
          </div>
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {T.compliancePoints.map((p, idx) => (
              <Card key={idx} className="h-full p-8">
                <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent">
                  {p.icon}
                </div>
                <h3 className="text-lg font-bold text-text-primary">{p.title}</h3>
                <p className="mt-3 leading-relaxed text-text-secondary">{p.desc}</p>
              </Card>
            ))}
          </div>
          <p className="mt-8 text-center text-xs leading-relaxed text-text-tertiary">{T.complianceFootnote}</p>
        </div>
      </section>

      {/* #519: 真实临床工作流 — 统计方法学严谨性露出。 */}
      <section className="mx-auto max-w-7xl px-4 py-24">
        <div className="mb-12 text-center">
          <h2 className="text-3xl font-bold text-text-primary sm:text-4xl">{T.workflowTitle}</h2>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-text-secondary">{T.workflowSubtitle}</p>
        </div>
        <div className="grid gap-6 lg:grid-cols-5">
          {T.workflowSteps.map((s, idx) => (
            <Card key={idx} className="relative h-full p-6">
              <span className="absolute right-4 top-4 text-3xl font-bold text-accent/10">{idx + 1}</span>
              <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-accent/10 text-accent">
                {s.icon}
              </div>
              <h3 className="text-sm font-bold text-text-primary">{s.title}</h3>
              <p className="mt-2 text-xs leading-relaxed text-text-secondary">{s.desc}</p>
            </Card>
          ))}
        </div>
        <div className="mt-8 flex min-h-[160px] items-center justify-center rounded-xl border border-dashed border-border bg-surface p-8">
          <div className="text-center">
            <BarChart3 size={28} className="mx-auto text-text-tertiary" />
            <p className="mt-3 text-sm text-text-tertiary">{T.workflowSampleLabel}</p>
          </div>
        </div>
      </section>

      {/* #518: 合作伙伴与致谢。 */}
      <section className="border-t border-border bg-surface">
        <div className="mx-auto max-w-7xl px-4 py-24">
          <div className="mb-12 text-center">
            <h2 className="text-3xl font-bold text-text-primary sm:text-4xl">{T.partnersTitle}</h2>
            <p className="mx-auto mt-4 max-w-2xl text-lg text-text-secondary">{T.partnersIntro}</p>
          </div>
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {T.partners.map((p, idx) => (
              <Card key={idx} className="p-6 text-center">
                <h3 className="font-semibold text-text-primary">{p.name}</h3>
                <p className="mt-2 text-xs leading-relaxed text-text-secondary">{p.desc}</p>
              </Card>
            ))}
          </div>
          <p className="mt-8 text-center text-xs text-text-tertiary">{T.partnersFootnote}</p>
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
          </div>
        </div>
      </section>
    </MarketingShell>
  );
}
