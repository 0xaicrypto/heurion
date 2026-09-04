import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import {
  ArrowRight,
  AlertTriangle,
  Lock,
  ShieldCheck,
  FileKey,
  Globe,
  Image as ImageIcon,
  Puzzle,
  BookOpen,
  Network,
  Box,
  Link2,
  FileText,
  Check,
  History,
  EyeOff,
  MessageSquare,
  Server,
} from 'lucide-react';
import { Button, Card } from '@/components/ui';
import { MarketingShell } from '@/components/marketing/MarketingShell';

/** 首页改版(#landing-v2): 与 homepage-draft.html 设计稿对齐。 */

function Reveal({ className, children, delay = 0 }: { className?: string; children: React.ReactNode; delay?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShown(true);
          io.disconnect();
        }
      },
      { threshold: 0.12 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div
      ref={ref}
      style={delay ? { transitionDelay: `${delay}ms` } : undefined}
      className={cn(
        'transition-all duration-700 ease-out motion-reduce:transition-none',
        shown ? 'translate-y-0 opacity-100' : 'translate-y-6 opacity-0',
        className,
      )}
    >
      {children}
    </div>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return <Check size={15} strokeWidth={2.4} className={cn('shrink-0', className)} />;
}

/**
 * #519-followup: 正式统计图表样例 — 带误差棒(95% CI)、数值标签与显著性标注。
 * 数据为演示示例,仅用于展示图表样式(诚实原则:不冒充真实结果)。
 */
function EfficacyBarChartSample() {
  const bars = [
    { label: 'A 组', n: 42, value: 75, ciLow: 65, ciHigh: 85 },
    { label: 'B 组', n: 45, value: 82, ciLow: 73, ciHigh: 91 },
  ];
  const chartW = 480;
  const chartH = 300;
  const padL = 48;
  const padB = 36;
  const padT = 44;
  const plotW = chartW - padL - 20;
  const plotH = chartH - padT - padB;
  const yMax = 100;
  const y = (v: number) => padT + plotH * (1 - v / yMax);
  const x = (i: number) => padL + plotW * (0.25 + i * 0.5);
  const barW = 72;
  const ticks = [0, 25, 50, 75, 100];

  return (
    <svg viewBox={`0 0 ${chartW} ${chartH}`} role="img" aria-label="两组治疗有效率对比示例图" className="mx-auto block max-w-[440px]">
      <title>两组治疗有效率对比(示例数据)</title>
      {/* axes + grid */}
      {ticks.map((t) => (
        <line key={t} x1={padL} y1={y(t)} x2={chartW - 20} y2={y(t)} stroke="hsl(var(--border))" strokeWidth={t === 0 ? 1 : 0.6} strokeDasharray={t === 0 ? undefined : '3 3'} />
      ))}
      <line x1={padL} y1={padT} x2={padL} y2={padT + plotH} stroke="hsl(var(--border-strong))" strokeWidth={1} />
      {ticks.map((t) => (
        <text key={`t-${t}`} x={padL - 8} y={y(t) + 4} textAnchor="end" fontSize={11} fill="hsl(var(--text-tertiary))">
          {t}%
        </text>
      ))}
      {/* significance annotation */}
      <text x={(x(0) + x(1)) / 2} y={padT - 10} textAnchor="middle" fontSize={13} fontWeight={600} fill="hsl(var(--text-secondary))">
        P = 0.56 (ns)
      </text>
      <line x1={(x(0) + x(1)) / 2 - 40} y1={padT - 4} x2={(x(0) + x(1)) / 2 + 40} y2={padT - 4} stroke="hsl(var(--text-tertiary))" strokeWidth={1} />
      {/* bars + error bars + value labels */}
      {bars.map((b, i) => (
        <g key={b.label}>
          <rect x={x(i) - barW / 2} y={y(b.value)} width={barW} height={y(0) - y(b.value)} rx={5} fill="hsl(var(--accent))" opacity={i === 0 ? 1 : 0.55} />
          <line x1={x(i)} y1={y(b.ciHigh)} x2={x(i)} y2={y(b.ciLow)} stroke="hsl(var(--text-primary))" strokeWidth={1.6} />
          <line x1={x(i) - 10} y1={y(b.ciHigh)} x2={x(i) + 10} y2={y(b.ciHigh)} stroke="hsl(var(--text-primary))" strokeWidth={1.6} />
          <line x1={x(i) - 10} y1={y(b.ciLow)} x2={x(i) + 10} y2={y(b.ciLow)} stroke="hsl(var(--text-primary))" strokeWidth={1.6} />
          <text x={x(i)} y={y(b.value) - 10} textAnchor="middle" fontSize={12} fontWeight={700} fill="hsl(var(--text-secondary))">
            {b.value}%
          </text>
          <text x={x(i)} y={y(0) + 22} textAnchor="middle" fontSize={13} fontWeight={600} fill="hsl(var(--text-primary))">
            {b.label} (n={b.n})
          </text>
        </g>
      ))}
    </svg>
  );
}

/** Hero 右侧产品示意 — 一句话指令 → 沙箱执行 → 交付物,浮动卡片展示溯源与失效传播。 */
function ProductMockup({ isZh }: { isZh: boolean }) {
  const M = {
    userMsg: isZh ? '把 2024 年随访数据清洗后画一组 KM 曲线，顺手导出 DOCX 报告' : 'Clean the 2024 follow-up data, plot KM curves, and export a DOCX report',
    aiHead: isZh ? 'Execution Plane · 隔离沙箱' : 'Execution Plane · Sandbox',
    done: isZh ? '已完成' : 'Done',
    kmA: 'A 组 67%',
    kmB: 'B 组 58%',
    chip1: 'Table 1',
    chip2: isZh ? 'KM 曲线 ×2' : 'KM curves ×2',
    chip3: isZh ? '随访报告.docx' : 'Follow-up report.docx',
    srcTitle: isZh ? '结论可溯源' : 'Provenance',
    srcDesc: isZh ? '该结论来源：2024-03-12 化验单 #A2291' : 'Source: lab report #A2291, 2024-03-12',
    staleTitle: isZh ? '失效传播' : 'Stale propagation',
    staleDesc: isZh ? '底层数据已变更 → 2 份报告自动标记失效' : 'Underlying data changed → 2 reports auto-marked stale',
  };
  return (
    <div className="relative">
      {/* 浏览器窗口 */}
      <div className="overflow-hidden rounded-lg border border-border bg-surface-elevated shadow-[0_24px_60px_-20px_rgba(15,23,42,0.22)] dark:shadow-[0_24px_60px_-20px_rgba(0,0,0,0.6)]">
        <div className="flex items-center gap-3 border-b border-border bg-surface px-4 py-3">
          <div className="flex gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-red-300" />
            <span className="h-2.5 w-2.5 rounded-full bg-amber-300" />
            <span className="h-2.5 w-2.5 rounded-full bg-green-300" />
          </div>
          <div className="mx-auto max-w-[260px] flex-1 rounded-md border border-border bg-background px-2.5 py-1 text-center text-xs text-text-tertiary">
            app.heurion.ai
          </div>
          <div className="w-12" />
        </div>
        <div className="flex min-h-[380px] flex-col gap-4 p-5">
          <div className="ml-auto max-w-[82%] rounded-lg rounded-br-sm bg-accent px-4 py-3 text-sm leading-relaxed text-white">
            {M.userMsg}
          </div>
          <div className="mr-auto max-w-[92%] rounded-lg rounded-bl-sm border border-border bg-surface px-4 py-3.5">
            <div className="mb-2.5 flex items-center gap-2 text-[13px] font-semibold text-text-primary">
              <Network size={14} className="text-accent" />
              {M.aiHead}
              <span className="rounded bg-accent/10 px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-wider text-accent">
                {M.done}
              </span>
            </div>
            {/* KM 曲线示意 */}
            <svg viewBox="0 0 440 150" className="block w-full" role="img" aria-label="KM 曲线示意">
              <line x1="36" y1="12" x2="36" y2="126" stroke="hsl(var(--border-strong))" />
              <line x1="36" y1="126" x2="428" y2="126" stroke="hsl(var(--border-strong))" />
              <text x="28" y="18" fontSize="9" fill="hsl(var(--text-tertiary))" textAnchor="end">1.0</text>
              <text x="28" y="70" fontSize="9" fill="hsl(var(--text-tertiary))" textAnchor="end">0.5</text>
              <text x="28" y="129" fontSize="9" fill="hsl(var(--text-tertiary))" textAnchor="end">0</text>
              <path d="M36 12 h60 v10 h28 v12 h34 v14 h40 v16 h44 v20 h50 v18 h46 v14 h40" fill="none" stroke="#0ea5e9" strokeWidth="2.4" strokeLinejoin="round" />
              <path d="M36 12 h44 v8 h26 v10 h30 v14 h36 v16 h40 v18 h44 v20 h44 v16 h50 v12 h40" fill="none" stroke="hsl(var(--text-tertiary))" strokeWidth="2.4" strokeLinejoin="round" opacity="0.55" />
              <text x="330" y="34" fontSize="10" fontWeight="600" fill="hsl(var(--text-secondary))">{M.kmA}</text>
              <text x="330" y="52" fontSize="10" fill="hsl(var(--text-tertiary))">{M.kmB}</text>
            </svg>
            <div className="mt-3 flex flex-wrap gap-2">
              {[M.chip1, M.chip2, M.chip3].map((c) => (
                <span key={c} className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-elevated px-2.5 py-1 text-xs font-semibold text-text-secondary">
                  <CheckIcon className="text-success" />
                  {c}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
      {/* 浮动卡片: 溯源 */}
      <div className="absolute -right-4 -top-5 hidden animate-floaty rounded-lg border border-border bg-surface-elevated p-3.5 shadow-md lg:block xl:-right-8">
        <div className="mb-1 flex items-center gap-2 text-[13px] font-bold text-text-primary">
          <Link2 size={14} className="text-accent" />
          {M.srcTitle}
        </div>
        <div className="text-xs leading-relaxed text-text-tertiary">{M.srcDesc}</div>
      </div>
      {/* 浮动卡片: 失效传播 */}
      <div className="absolute -bottom-6 -left-4 hidden animate-[floaty_5s_ease-in-out_2.5s_infinite] rounded-lg border border-border bg-surface-elevated p-3.5 shadow-md lg:block xl:-left-8">
        <div className="mb-1 flex items-center gap-2 text-[13px] font-bold text-warning">
          <AlertTriangle size={14} />
          {M.staleTitle}
        </div>
        <div className="text-xs leading-relaxed text-text-tertiary">{M.staleDesc}</div>
      </div>
    </div>
  );
}

export function LandingPage() {
  const { i18n } = useTranslation();
  const isZh = i18n.language.startsWith('zh');

  const T = {
    tagline: isZh ? '面向临床科研的数字化医疗助手' : 'A digital medical research assistant',
    title1: isZh ? '让 AI 拥有临床记忆' : 'Give AI clinical memory —',
    title2: isZh ? '与执行能力' : 'hands that deliver',
    subtitle: isZh
      ? 'Heurion 以「双平面架构」重建医疗 AI 的大脑与双手：Control Plane 沉淀可溯源、可失效传播的 DAG 临床记忆；Execution Plane 在隔离沙箱中直接生成 DOCX、PPTX 与统计图表。'
      : 'Heurion rebuilds medical AI with a dual-plane architecture: a Control Plane of traceable, stale-propagating DAG clinical memory, and an Execution Plane that generates DOCX, PPTX and statistical figures in an isolated sandbox.',
    startFree: isZh ? '免费开始使用' : 'Start Free',
    startFreeShort: isZh ? '免费开始' : 'Start Free',
    github: isZh ? '在 GitHub 查看' : 'View on GitHub',
    trustItems: [
      { icon: <Lock size={15} strokeWidth={2.2} />, label: isZh ? '数据不出院' : 'Data stays on-prem' },
      { icon: <History size={15} strokeWidth={2.2} />, label: isZh ? '全量可审计' : 'Fully auditable' },
      { icon: <Server size={15} strokeWidth={2.2} />, label: isZh ? '支持本地化部署' : 'Self-hosted ready' },
    ],

    pillars: [
      {
        icon: <Network size={22} />,
        title: isZh ? 'DAG 临床记忆' : 'DAG clinical memory',
        desc: isZh ? '知识单元按依赖关系组成图谱，随诊疗持续生长。' : 'Knowledge units form a dependency graph that grows with care.',
      },
      {
        icon: <Box size={22} />,
        title: isZh ? '隔离执行沙箱' : 'Isolated sandbox',
        desc: isZh ? '崩溃与风险都被限制在沙箱内，核心病历库不受影响。' : 'Crashes stay in the sandbox; core records are never touched.',
      },
      {
        icon: <Link2 size={22} />,
        title: isZh ? '完整溯源' : 'Complete provenance',
        desc: isZh ? '每个结论一键追溯到具体日期的病历原文。' : 'Every conclusion links back to its source record.',
      },
      {
        icon: <FileText size={22} />,
        title: isZh ? '科研级交付' : 'Publication-grade delivery',
        desc: isZh ? 'DOCX、PPTX、Table 1、KM 曲线，开箱即用。' : 'DOCX, PPTX, Table 1 and KM curves, out of the box.',
      },
    ],

    painsEyebrow: isZh ? '临床现场的真实痛点' : 'Real clinical pain',
    painsTitle: isZh ? '医疗大模型在临床场景的三大失效模式' : 'Three failure modes of medical LLMs in clinical practice',
    painQuote: isZh
      ? '“复诊时，医生得把过去三年的化验单、基因突变、影像记录重新粘贴一遍。”'
      : '“Before every follow-up, doctors re-paste years of labs, mutations and imaging.”',
    painQuoteSource: isZh ? '— 来自 12 家合作科室的访谈' : '— From interviews with 12 partner departments',
    pains: [
      {
        num: '01',
        icon: <History size={18} />,
        title: isZh ? '会话级记忆缺失' : 'No persistent memory',
        desc: isZh
          ? '每次打开对话框，AI 都不认识患者。复诊、写总结前，医生得把过去 3 年的化验单、基因突变、影像记录重新粘贴一遍。'
          : 'Every session starts from scratch. Before a follow-up or summary, doctors must re-paste years of labs, mutations, and imaging.',
      },
      {
        num: '02',
        icon: <EyeOff size={18} />,
        title: isZh ? '幻觉与黑盒' : 'Hallucination & black box',
        desc: isZh
          ? 'AI 生成的病例总结很漂亮，但医生不敢用：指标可能是编造的，且无法点击追溯到具体日期的病历。'
          : 'Generated summaries look polished, but doctors cannot trust them: metrics may be invented, and sources cannot be traced.',
      },
      {
        num: '03',
        icon: <MessageSquare size={18} />,
        title: isZh ? '缺乏执行能力：仅限对话' : 'No execution: chat only',
        desc: isZh
          ? '“帮我把随访数据清洗一下，画一张 KM 曲线。”通用 AI 只能回答：“抱歉，我是一个语言模型，无法作图。”'
          : '"Clean this follow-up data and plot a KM curve." Generic AI replies: "Sorry, I am a language model and cannot generate charts."',
      },
    ],

    dualPlaneEyebrow: isZh ? 'Heurion 的答案' : 'The Heurion answer',
    dualPlaneTitle: isZh ? '双平面架构：大脑 + 双手' : 'Dual-Plane Architecture: brain + hands',
    dualPlaneSubtitle: isZh
      ? '无需理解底层实现：Heurion 由具备持久临床记忆的智能大脑，与在隔离沙箱中完成执行与交付的执行引擎构成。'
      : 'No implementation details required: Heurion pairs a brain with persistent clinical memory and an execution engine that delivers results inside an isolated sandbox.',
    archCmd: isZh ? '医生的自然语言指令' : "The physician's natural-language command",
    controlPlane: {
      label: isZh ? 'Control Plane · 记忆引擎' : 'Control Plane · Memory Engine',
      title: isZh ? '持久记忆与完整溯源' : 'Persistent memory & full provenance',
      points: [
        isZh ? '临床原始输入被不可变记录' : 'Raw clinical inputs recorded immutably',
        isZh ? '记忆以可组合的知识单元组织成 DAG 图谱' : 'Memory organized as a DAG of composable knowledge units',
        isZh ? '底层数据变更时，上层报告自动标记失效' : 'Downstream reports auto-mark stale on data changes',
        isZh ? '数据缺失时主动提问，而非编造' : 'Asks when data is missing, instead of hallucinating',
      ],
    },
    executionPlane: {
      label: isZh ? 'Execution Plane · 执行沙箱' : 'Execution Plane · Sandbox',
      title: isZh ? '执行与交付引擎' : 'Execution & delivery engine',
      points: [
        isZh ? '自然语言指令触发隔离沙箱' : 'Natural-language commands trigger the sandbox',
        isZh ? '自动执行数据分析、清洗与图表渲染' : 'Automated analysis, cleaning, and figure rendering',
        isZh ? '沙箱崩溃不影响核心患者数据库' : 'Sandbox crashes never touch core patient data',
        isZh ? '数据不出院，算力可本地化部署' : 'Data never leaves the hospital; compute can be on-premise',
      ],
    },
    deliverLabel: isZh ? '直接交付：' : 'Directly delivers:',
    deliverItems: isZh ? ['DOCX', 'PPTX', 'Table 1', 'KM 曲线', '统计图'] : ['DOCX', 'PPTX', 'Table 1', 'KM curves', 'figures'],

    uniqueCards: [
      {
        icon: <Globe size={24} />,
        title: isZh ? '浏览器自动化' : 'Browser automation',
        desc: isZh
          ? '用自然语言指令让 AI 登录系统、查询与采集网页信息（Agent Browser），也可模拟真实用户旅程做回归测试。'
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

    stepsEyebrow: isZh ? '三步上手' : 'Three steps',
    stepsTitle: isZh ? '从病历到科研交付物' : 'From records to research deliverables',
    steps: [
      {
        title: isZh ? '上传病历与随访数据' : 'Upload records & follow-up data',
        desc: isZh ? '化验单、影像、手写记录均可直接上传，自动结构化入库。' : 'Labs, imaging, and handwritten notes are structured automatically.',
      },
      {
        title: isZh ? 'AI 构建可溯源临床记忆' : 'AI builds traceable memory',
        desc: isZh ? '知识单元沉淀为 DAG 图谱，随诊疗持续生长，结论可一键溯源。' : 'Knowledge settles into a DAG graph that grows with care, every conclusion traceable.',
      },
      {
        title: isZh ? '一句话生成科研级交付物' : 'One sentence → publication-grade output',
        desc: isZh ? '清洗、统计、作图、成文一次完成，直接导出 DOCX 与 PPTX。' : 'Cleaning, statistics, figures and writing in one pass — export DOCX and PPTX.',
      },
    ],

    figEyebrow: isZh ? '方法学严谨性' : 'Methodological rigor',
    figTitle: isZh ? '正式统计图表,方法学完整标注' : 'Formal statistical figures, methodology annotated',
    figDesc: isZh
      ? '科研级图表可直接交付：误差棒、置信区间、P 值与样本量一应俱全，风格符合期刊规范。'
      : 'Deliver publication-ready figures: error bars, CIs, p-values and sample sizes in journal style.',
    figChecks: [
      isZh ? '误差棒标注 95% 置信区间' : 'Error bars denote 95% CIs',
      isZh ? 'P 值与显著性标注规范呈现' : 'Formal p-value and significance annotation',
      isZh ? '示例数据明确标注，诚实原则' : 'Sample data explicitly labeled — honest by design',
    ],
    figBadge: isZh ? 'Figure 1 · 示例' : 'Figure 1 · Example',
    figCaption: isZh
      ? 'Figure 1. 两组治疗有效率对比，误差棒表示 95% 置信区间；显著性检验为双侧 t 检验。'
      : 'Figure 1. Treatment response rates by group; error bars denote 95% CIs; two-sided t-test.',
    figWarn: isZh
      ? '示例数据：仅用于演示图表样式，不代表真实研究结果'
      : 'Sample data for style demonstration only — not real study results',

    complianceIntro: isZh
      ? 'Heurion 是面向临床科研的辅助工具，不提供诊断或治疗决策建议。所有 AI 输出必须由执业医师审阅确认。'
      : 'Heurion is a clinical research assistance tool. It does not provide diagnoses or treatment decisions — every AI output must be reviewed and confirmed by a licensed physician.',
    compliancePoints: [
      {
        icon: <ShieldCheck size={19} />,
        title: isZh ? '科研辅助定位' : 'Research-assistance positioning',
        desc: isZh
          ? 'AI 生成内容仅供参考，不作为临床决策依据。'
          : 'AI content is reference-only, never a basis for clinical decisions.',
      },
      {
        icon: <Lock size={19} />,
        title: isZh ? '数据不出院' : 'Data stays inside',
        desc: isZh
          ? '纯本地化部署，隔离沙箱与核心病历库物理分离。'
          : 'On-premise deployment; sandbox isolated from core records.',
      },
      {
        icon: <FileKey size={19} />,
        title: isZh ? '可审计溯源' : 'Auditable provenance',
        desc: isZh
          ? '不可变 EventLog 记录每一次访问与生成。'
          : 'An immutable EventLog records every access and generation.',
      },
    ],
    complianceFootnote: isZh
      ? '* Heurion 不构成医疗器械，不用于诊断、治疗或预后判断；部署前请按机构法规完成评估。'
      : '* Heurion is not a medical device and is not intended for diagnosis, treatment, or prognosis. Evaluate against your institution\u2019s regulations before deployment.',

    partnersTitle: isZh ? '临床合作与医学伙伴' : 'Clinical & Medical Partners',
    partnersIntro: isZh
      ? 'Heurion 与临床科室和医学数据生态同行，让能力生长在真实诊疗场景中。'
      : 'Heurion grows with clinicians and medical data ecosystems — built for real-world care.',
    hospitalName: isZh ? '中国科学技术大学附属第一医院（安徽省立医院）' : 'The First Affiliated Hospital of USTC (Anhui Provincial Hospital)',
    reactomeDesc: isZh ? '通路数据（CC BY 4.0）' : 'Pathway data (CC BY 4.0)',
    ncbiDesc: isZh ? 'PubMed 文献与医学检索数据' : 'PubMed literature & medical search data',
    techLine: isZh
      ? '技术生态致谢：Cloudflare Workers · Vercel AI SDK · GitHub 开源社区，以及所有为开源与医疗信息化做出贡献的开发者。'
      : 'Built on Cloudflare Workers · Vercel AI SDK · GitHub open source — and every developer contributing to open source and health informatics.',

    ctaTitle: isZh ? '把科室的隐性经验，沉淀为可继承的数据资产' : 'Turn tacit expertise into inheritable data assets',
    ctaSubtitle: isZh
      ? '免费开始，或在您的服务器上自托管完整平台。'
      : 'Start free or self-host the full platform on your own servers.',
    docsCta: isZh ? '查看用户指南' : 'User Guide',
  };

  return (
    <MarketingShell>
      {/* ── Hero ── */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 bg-[url('/photos/hero-bg.jpg')] bg-cover bg-center opacity-[0.08] dark:opacity-[0.05]" />
        <div className="absolute inset-0 bg-[radial-gradient(700px_400px_at_85%_10%,rgba(14,165,233,0.10),transparent_60%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(500px_350px_at_10%_90%,rgba(2,132,199,0.07),transparent_60%)]" />
        <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-b from-transparent to-background" />

        <div className="relative mx-auto grid max-w-7xl items-center gap-14 px-4 pb-28 pt-24 lg:grid-cols-[1.02fr_0.98fr] lg:pb-32 lg:pt-28">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-accent/20 bg-accent/5 px-3.5 py-1.5 text-[13px] font-semibold text-accent">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
              {T.tagline}
            </div>
            <h1 className="mt-5 text-4xl font-extrabold leading-[1.14] tracking-tight text-text-primary sm:text-5xl lg:text-[3.4rem]">
              {T.title1}
              <br />
              <span className="bg-gradient-to-r from-accent to-accent-hover bg-clip-text text-transparent dark:from-sky-300 dark:to-sky-200">
                {T.title2}
              </span>
            </h1>
            <p className="mt-6 max-w-[560px] text-lg leading-relaxed text-text-secondary">{T.subtitle}</p>
            <div className="mt-9 flex flex-wrap gap-3.5">
              <Link to="/login?mode=register">
                <Button size="lg" className="px-7 text-base shadow-lg shadow-accent/30">
                  {T.startFree}
                  <ArrowRight size={17} strokeWidth={2.4} className="ml-2" />
                </Button>
              </Link>
              <a href="https://github.com/0xaicrypto/heurion" target="_blank" rel="noreferrer">
                <Button variant="secondary" size="lg" className="px-7 text-base">
                  {T.github}
                </Button>
              </a>
            </div>
            <div className="mt-7 flex flex-wrap gap-x-6 gap-y-2">
              {T.trustItems.map((item) => (
                <span key={item.label} className="inline-flex items-center gap-1.5 text-[13.5px] font-medium text-text-tertiary">
                  <span className="text-success">{item.icon}</span>
                  {item.label}
                </span>
              ))}
            </div>
          </div>
          <Reveal>
            <ProductMockup isZh={isZh} />
          </Reveal>
        </div>
      </section>

      {/* ── 能力支柱 ── */}
      <section className="border-y border-border bg-surface">
        <div className="mx-auto grid max-w-7xl gap-y-10 px-4 py-16 sm:grid-cols-2 lg:grid-cols-4 lg:gap-y-0">
          {T.pillars.map((p, idx) => (
            <Reveal key={p.title} delay={idx * 80} className={cn('px-0 lg:px-7', idx > 0 && 'lg:border-l lg:border-border', idx === 0 && 'lg:pl-0', idx === 3 && 'lg:pr-0')}>
              <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-md bg-accent/10 text-accent">{p.icon}</div>
              <h3 className="text-base font-bold text-text-primary">{p.title}</h3>
              <p className="mt-1.5 text-[13.5px] leading-relaxed text-text-tertiary">{p.desc}</p>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ── 痛点 ── */}
      <section className="mx-auto max-w-7xl px-4 py-24">
        <Reveal className="mx-auto mb-16 max-w-3xl text-center">
          <span className="mb-3.5 inline-block text-[13px] font-bold uppercase tracking-[0.1em] text-accent">{T.painsEyebrow}</span>
          <h2 className="text-3xl font-extrabold tracking-tight text-text-primary sm:text-4xl">{T.painsTitle}</h2>
        </Reveal>
        <div className="grid items-stretch gap-10 lg:grid-cols-[0.9fr_1.1fr]">
          {/* 实拍图 + 引言 */}
          <Reveal className="relative min-h-[300px] overflow-hidden rounded-lg shadow-md lg:min-h-[440px]">
            <img
              src="/photos/clinician-tablet.jpg"
              alt={isZh ? '医生正在平板上查看患者数据' : 'Clinician reviewing patient data on a tablet'}
              loading="lazy"
              className="absolute inset-0 h-full w-full object-cover"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-slate-900/75 via-slate-900/10 to-transparent" />
            <div className="absolute bottom-6 left-6 right-6 text-white">
              <p className="text-[15px] font-medium leading-relaxed">{T.painQuote}</p>
              <span className="mt-2 block text-xs opacity-75">{T.painQuoteSource}</span>
            </div>
          </Reveal>
          {/* 编号卡片 */}
          <div className="flex flex-col justify-center gap-[18px]">
            {T.pains.map((p, idx) => (
              <Reveal key={p.num} delay={idx * 90}>
                <Card className="group flex gap-[18px] p-6 transition-all hover:-translate-y-0.5 hover:border-accent/30 hover:shadow-md">
                  <div className="min-w-[40px] text-[26px] font-extrabold leading-none tracking-tight text-border-strong">{p.num}</div>
                  <div>
                    <h3 className="flex items-center gap-2.5 text-[17px] font-bold text-text-primary">
                      <span className="text-error opacity-85">{p.icon}</span>
                      {p.title}
                    </h3>
                    <p className="mt-2 text-[14.5px] leading-relaxed text-text-secondary">{p.desc}</p>
                  </div>
                </Card>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── 双平面架构 ── */}
      <section className="border-y border-border bg-surface">
        <div className="mx-auto max-w-7xl px-4 py-24">
          <Reveal className="mx-auto mb-14 max-w-3xl text-center">
            <span className="mb-3.5 inline-block text-[13px] font-bold uppercase tracking-[0.1em] text-accent">{T.dualPlaneEyebrow}</span>
            <h2 className="text-3xl font-extrabold tracking-tight text-text-primary sm:text-4xl">{T.dualPlaneTitle}</h2>
            <p className="mx-auto mt-4 max-w-2xl text-lg text-text-secondary">{T.dualPlaneSubtitle}</p>
          </Reveal>

          <Reveal className="rounded-2xl border border-border bg-surface-elevated p-6 sm:p-10 lg:p-12">
            {/* 指令入口 */}
            <div className="mx-auto flex w-fit max-w-full items-center gap-2.5 rounded-full border border-border-strong bg-background px-5 py-2.5 text-sm font-semibold shadow-sm">
              <MessageSquare size={17} className="shrink-0 text-accent" />
              <span className="truncate">{T.archCmd}</span>
            </div>
            <div className="flex justify-center py-3.5 text-text-tertiary">
              <svg width="18" height="26" viewBox="0 0 24 32" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 4v22M6 20l6 6 6-6" /></svg>
            </div>

            <div className="grid gap-5 lg:grid-cols-2">
              {/* Control Plane */}
              <div className="relative overflow-hidden rounded-xl border border-border bg-background p-6 before:absolute before:inset-x-0 before:top-0 before:h-[3px] before:bg-gradient-to-r before:from-accent before:to-sky-300">
                <span className="text-xs font-bold uppercase tracking-[0.08em] text-accent">{T.controlPlane.label}</span>
                <h3 className="mt-1.5 text-xl font-extrabold tracking-tight text-text-primary">{T.controlPlane.title}</h3>
                {/* DAG 迷你图 */}
                <div className="my-4 rounded-lg border border-border bg-surface p-3.5">
                  <svg viewBox="0 0 400 92" className="block w-full">
                    <line x1="56" y1="46" x2="150" y2="24" stroke="hsl(var(--border-strong))" strokeWidth="1.4" />
                    <line x1="56" y1="46" x2="150" y2="70" stroke="hsl(var(--border-strong))" strokeWidth="1.4" />
                    <line x1="150" y1="24" x2="248" y2="46" stroke="hsl(var(--border-strong))" strokeWidth="1.4" />
                    <line x1="150" y1="70" x2="248" y2="46" stroke="hsl(var(--border-strong))" strokeWidth="1.4" />
                    <line x1="248" y1="46" x2="344" y2="24" stroke="hsl(var(--border-strong))" strokeWidth="1.4" strokeDasharray="4 3" />
                    <line x1="248" y1="46" x2="344" y2="70" stroke="hsl(var(--border-strong))" strokeWidth="1.4" />
                    <circle cx="56" cy="46" r="11" fill="hsl(var(--background))" stroke="#0ea5e9" strokeWidth="2" />
                    <circle cx="150" cy="24" r="11" fill="hsl(var(--background))" stroke="#0ea5e9" strokeWidth="2" />
                    <circle cx="150" cy="70" r="11" fill="hsl(var(--background))" stroke="#0ea5e9" strokeWidth="2" />
                    <circle cx="248" cy="46" r="11" fill="hsl(var(--background))" stroke="#0ea5e9" strokeWidth="2" />
                    <circle cx="344" cy="24" r="11" fill="hsl(var(--background))" stroke="#f59e0b" strokeWidth="2" strokeDasharray="3 3" />
                    <circle cx="344" cy="70" r="11" fill="hsl(var(--background))" stroke="#0ea5e9" strokeWidth="2" />
                    <text x="56" y="50" fontSize="9" textAnchor="middle" fill="hsl(var(--text-tertiary))" fontWeight="600">{isZh ? '输入' : 'Input'}</text>
                    <text x="248" y="50" fontSize="9" textAnchor="middle" fill="hsl(var(--text-tertiary))" fontWeight="600">{isZh ? '结论' : 'Claim'}</text>
                    <text x="380" y="28" fontSize="9" fill="#f59e0b" fontWeight="700" textAnchor="middle">{isZh ? '失效' : 'Stale'}</text>
                  </svg>
                </div>
                <ul className="space-y-2.5">
                  {T.controlPlane.points.map((pt) => (
                    <li key={pt} className="flex gap-2.5 text-sm leading-relaxed text-text-secondary">
                      <CheckIcon className="mt-1 text-accent" />
                      <span>{pt}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Execution Plane */}
              <div className="relative overflow-hidden rounded-xl border border-border bg-background p-6 before:absolute before:inset-x-0 before:top-0 before:h-[3px] before:bg-gradient-to-r before:from-indigo-500 before:to-indigo-300">
                <span className="text-xs font-bold uppercase tracking-[0.08em] text-indigo-500 dark:text-indigo-300">{T.executionPlane.label}</span>
                <h3 className="mt-1.5 text-xl font-extrabold tracking-tight text-text-primary">{T.executionPlane.title}</h3>
                {/* 终端迷你图 */}
                <div className="my-4 rounded-lg border border-border bg-surface p-3.5">
                  <svg viewBox="0 0 400 92" className="block w-full">
                    <rect x="14" y="14" width="372" height="64" rx="10" fill="hsl(var(--background))" stroke="hsl(var(--border))" strokeWidth="1.4" />
                    <text x="30" y="38" fontSize="10.5" fill="hsl(var(--text-tertiary))" fontFamily="ui-monospace, SFMono-Regular, monospace">$ heurion run clean --cohort 2024</text>
                    <text x="30" y="56" fontSize="10.5" fill="hsl(var(--text-tertiary))" fontFamily="ui-monospace, SFMono-Regular, monospace">→ render km.plot + table1 …</text>
                    <text x="322" y="56" fontSize="10" fill="hsl(var(--success))" fontWeight="700" fontFamily="ui-monospace, SFMono-Regular, monospace">✔ done</text>
                  </svg>
                </div>
                <ul className="space-y-2.5">
                  {T.executionPlane.points.map((pt) => (
                    <li key={pt} className="flex gap-2.5 text-sm leading-relaxed text-text-secondary">
                      <CheckIcon className="mt-1 text-indigo-500 dark:text-indigo-300" />
                      <span>{pt}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            <div className="flex justify-center py-3.5 text-text-tertiary">
              <svg width="18" height="26" viewBox="0 0 24 32" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 28V6M6 12l6-6 6 6" /></svg>
            </div>
            <div className="mx-auto flex w-fit max-w-full flex-wrap items-center justify-center gap-2.5 rounded-full border border-dashed border-border-strong px-6 py-2.5 text-sm font-semibold text-text-secondary">
              <b className="text-text-primary">{T.deliverLabel}</b>
              {T.deliverItems.map((d, i) => (
                <span key={d}>
                  {d}
                  {i < T.deliverItems.length - 1 && <span className="mx-1.5 text-text-tertiary">·</span>}
                </span>
              ))}
            </div>
          </Reveal>

          {/* 独特能力徽章 */}
          <div className="mt-14 grid gap-5 sm:grid-cols-3">
            {T.uniqueCards.map((p, idx) => (
              <Reveal key={p.title} delay={idx * 80}>
                <Card className="h-full p-6 transition-all hover:-translate-y-1 hover:border-accent/30 hover:shadow-md">
                  <div className="mb-3.5 flex h-10 w-10 items-center justify-center rounded-md bg-accent/10 text-accent">{p.icon}</div>
                  <h4 className="text-[15.5px] font-bold text-text-primary">{p.title}</h4>
                  <p className="mt-2 text-[13.5px] leading-relaxed text-text-tertiary">{p.desc}</p>
                </Card>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── 三步上手 ── */}
      <section className="mx-auto max-w-7xl px-4 py-24">
        <Reveal className="mx-auto mb-16 max-w-3xl text-center">
          <span className="mb-3.5 inline-block text-[13px] font-bold uppercase tracking-[0.1em] text-accent">{T.stepsEyebrow}</span>
          <h2 className="text-3xl font-extrabold tracking-tight text-text-primary sm:text-4xl">{T.stepsTitle}</h2>
        </Reveal>
        <div className="relative grid gap-12 lg:grid-cols-3 lg:gap-5">
          <div className="absolute left-[16%] right-[16%] top-9 hidden border-t-2 border-dashed border-border-strong lg:block" />
          {T.steps.map((s, idx) => (
            <Reveal key={s.title} delay={idx * 100} className="relative px-4 text-center">
              <div className="relative z-10 mx-auto mb-5 flex h-[68px] w-[68px] items-center justify-center rounded-full border-2 border-accent bg-surface-elevated text-[22px] font-extrabold text-accent shadow-sm">
                {idx + 1}
              </div>
              <h3 className="text-[17px] font-bold text-text-primary">{s.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-text-tertiary">{s.desc}</p>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ── 统计图样例 ── */}
      <section className="border-y border-border bg-surface">
        <div className="mx-auto grid max-w-7xl items-center gap-12 px-4 py-24 lg:grid-cols-[0.92fr_1.08fr]">
          <Reveal>
            <span className="mb-3.5 inline-block text-[13px] font-bold uppercase tracking-[0.1em] text-accent">{T.figEyebrow}</span>
            <h2 className="text-3xl font-extrabold tracking-tight text-text-primary sm:text-4xl">{T.figTitle}</h2>
            <p className="mt-4 text-[16.5px] leading-relaxed text-text-tertiary">{T.figDesc}</p>
            <ul className="mt-7 space-y-3.5">
              {T.figChecks.map((c) => (
                <li key={c} className="flex gap-3 text-[15px] leading-relaxed text-text-secondary">
                  <CheckIcon className="mt-1 text-success" />
                  <span>{c}</span>
                </li>
              ))}
            </ul>
          </Reveal>
          <Reveal>
            <div className="relative rounded-2xl border border-border bg-surface-elevated p-7 shadow-lg sm:p-8">
              <span className="absolute -top-3.5 left-6 rounded-full bg-accent px-3.5 py-1 text-xs font-bold tracking-wide text-white">
                {T.figBadge}
              </span>
              <EfficacyBarChartSample />
              <p className="mt-3.5 text-center text-xs leading-relaxed text-text-tertiary">{T.figCaption}</p>
              <p className="mt-2.5 flex items-center justify-center gap-1.5 text-xs font-semibold text-warning">
                <AlertTriangle size={13} />
                {T.figWarn}
              </p>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ── 医疗定位与合规 ── */}
      <section className="mx-auto max-w-5xl px-4 py-20">
        <Reveal className="text-center">
          <p className="text-base font-semibold leading-relaxed text-text-primary sm:text-[16.5px]">{T.complianceIntro}</p>
          <div className="mt-6 grid gap-5 text-left sm:grid-cols-3">
            {T.compliancePoints.map((p) => (
              <div key={p.title} className="flex gap-3 rounded-xl border border-border bg-surface-elevated p-[18px]">
                <span className="mt-0.5 shrink-0 text-accent">{p.icon}</span>
                <div>
                  <b className="block text-sm text-text-primary">{p.title}</b>
                  <span className="mt-1 block text-xs leading-relaxed text-text-tertiary">{p.desc}</span>
                </div>
              </div>
            ))}
          </div>
          <p className="mt-6 text-xs text-text-tertiary">{T.complianceFootnote}</p>
        </Reveal>
      </section>

      {/* ── 临床合作与医学伙伴 ── */}
      <section className="border-y border-border bg-surface">
        <div className="mx-auto max-w-7xl px-4 py-20">
          <Reveal className="mx-auto max-w-3xl text-center">
            <h2 className="text-2xl font-extrabold tracking-tight text-text-primary sm:text-3xl">{T.partnersTitle}</h2>
            <p className="mx-auto mt-3 max-w-2xl text-sm text-text-secondary">{T.partnersIntro}</p>
          </Reveal>
          <Reveal className="mt-11 flex flex-wrap justify-center gap-7">
            <a
              href="https://www.ahslyy.com.cn/"
              target="_blank"
              rel="noreferrer"
              title={T.hospitalName}
              className="flex min-w-[300px] items-center justify-center rounded-2xl border border-border bg-surface-elevated px-10 py-6 transition-all hover:-translate-y-0.5 hover:border-accent/30 hover:shadow-md"
            >
              <img
                src="/partners/ustc-1st-hospital.png"
                alt={T.hospitalName}
                loading="lazy"
                className="h-14 w-auto max-w-[320px] object-contain opacity-85 transition-opacity hover:opacity-100 dark:brightness-0 dark:invert dark:opacity-80"
              />
            </a>
            <a
              href="https://reactome.org"
              target="_blank"
              rel="noreferrer"
              title={`Reactome · ${T.reactomeDesc}`}
              className="flex min-w-[300px] items-center justify-center rounded-2xl border border-border bg-surface-elevated px-10 py-6 transition-all hover:-translate-y-0.5 hover:border-accent/30 hover:shadow-md"
            >
              <img
                src="/partners/reactome.png"
                alt="Reactome"
                loading="lazy"
                className="h-14 w-auto max-w-[320px] object-contain opacity-85 transition-opacity hover:opacity-100"
              />
            </a>
            <a
              href="https://www.ncbi.nlm.nih.gov/"
              target="_blank"
              rel="noreferrer"
              title={`NCBI · ${T.ncbiDesc}`}
              className="flex min-w-[300px] items-center justify-center rounded-2xl border border-border bg-surface-elevated px-10 py-6 transition-all hover:-translate-y-0.5 hover:border-accent/30 hover:shadow-md"
            >
              <img
                src="/partners/ncbi.svg"
                alt="NCBI — National Center for Biotechnology Information"
                loading="lazy"
                className="h-14 w-auto max-w-[320px] object-contain opacity-85 transition-opacity hover:opacity-100"
              />
            </a>
          </Reveal>
          <p className="mt-7 text-center text-xs text-text-tertiary">{T.techLine}</p>
        </div>
      </section>

      {/* ── CTA ── */}
      <section className="mx-auto max-w-7xl px-4 py-24">
        <Reveal className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-sky-900 to-slate-900 px-6 py-20 text-center sm:py-24">
          <img src="/photos/hospital-corridor.jpg" alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover opacity-15" />
          <div className="absolute inset-0 bg-[radial-gradient(600px_300px_at_50%_0%,rgba(56,189,248,0.18),transparent_65%)]" />
          <div className="relative">
            <h2 className="text-3xl font-extrabold tracking-tight text-white sm:text-4xl">{T.ctaTitle}</h2>
            <p className="mx-auto mt-4 max-w-xl text-[17px] text-sky-200">{T.ctaSubtitle}</p>
            <div className="mt-9 flex flex-col items-center justify-center gap-3.5 sm:flex-row">
              <Link to="/login?mode=register">
                <Button size="lg" className="border border-transparent bg-white px-7 text-base text-slate-900 hover:bg-sky-100">
                  {T.startFreeShort}
                  <ArrowRight size={17} strokeWidth={2.4} className="ml-2" />
                </Button>
              </Link>
              <a href="/docs/">
                <Button size="lg" variant="ghost" className="border border-white/40 px-7 text-base text-white hover:bg-white/10 hover:text-white">
                  <BookOpen size={18} className="mr-2" />
                  {T.docsCta}
                </Button>
              </a>
            </div>
          </div>
        </Reveal>
      </section>
    </MarketingShell>
  );
}
