import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { MessageSquare, Users, FlaskConical, Brain, Wrench, ShieldCheck, BookOpen, ArrowRight } from 'lucide-react';
import { Card } from '@/components/ui';
import { MarketingShell } from '@/components/marketing/MarketingShell';
import { featureGroups } from '@/docs/features';

/**
 * #518-followup — 用户使用指南(/docs)。
 * 功能总览由 src/docs/features.ts 渲染;新增路由后运行
 * `node scripts/gen-feature-inventory.mjs` 校验同步。
 */
export function DocsPage() {
  const { i18n } = useTranslation();
  const isZh = i18n.language.startsWith('zh');

  const T = {
    title: isZh ? '用户使用指南' : 'User Guide',
    subtitle: isZh
      ? '从注册到深度使用:对话、患者管理、研究与写作、记忆与知识库、插件扩展。'
      : 'From sign-up to deep usage: chat, patient management, research & writing, memory & knowledge, and plugins.',
    quickStartTitle: isZh ? '快速开始' : 'Quick start',
    quickStart: [
      isZh ? '1. 注册并登录;2. 创建会话,选择对话场景(通用/患者/文档/图表);3. 直接提问,或上传病历/图片;4. 在功能总览中探索各模块。'
        : '1. Sign up and log in; 2. Create a session and pick a scene (general/patient/document/chart); 3. Ask, or upload records/images; 4. Explore modules below.',
    ],
    chatTitle: isZh ? '对话' : 'Chat',
    chatBody: isZh
      ? '四场景入口对应不同的 AI 行为:患者问诊自动注入病历上下文;文档写作聚焦文档编辑;图表分析优先图表工具并遵守"数据缺失即明说"。上传的化验单/影像图可被直接解读(视觉模型)或走 OCR。'
      : 'Four scenes shape the AI behavior: patient Q&A injects record context; document writing focuses on editing; chart analysis favors chart tools and never fabricates data. Uploaded images are interpreted directly (vision models) or via OCR.',
    sceneGeneral: isZh ? '通用对话:独立任务,不预设患者上下文' : 'General: standalone tasks, no patient context',
    scenePatient: isZh ? '患者问诊:自动关联患者图谱与记忆' : 'Patient: auto-linked to the patient graph & memory',
    sceneDocument: isZh ? '文档写作:围绕当前文档编辑' : 'Document: edit the current document',
    sceneChart: isZh ? '图表分析:统计图表与数据可视化' : 'Chart: statistical figures & data visualization',
    overviewTitle: isZh ? '功能总览' : 'Feature overview',
    overviewNote: isZh
      ? '以下清单由代码路由自动校验(scripts/gen-feature-inventory.mjs),与产品保持一致。'
      : 'This list is validated against the app routes (scripts/gen-feature-inventory.mjs).',
    memoryTitle: isZh ? '记忆与溯源' : 'Memory & provenance',
    memoryBody: isZh
      ? '每次对话与操作写入不可变记录;事实(Facts)与知识(Articles)构成图谱,底层数据变更后依赖内容自动标记失效;每个结论可追溯到原始记录。'
      : 'Every turn and action is recorded immutably; facts and articles form a graph — when underlying data changes, dependent content is auto-marked stale; every conclusion traces to its source.',
    securityTitle: isZh ? '安全与合规' : 'Security & compliance',
    securityBody: isZh
      ? '科研辅助工具,不提供诊断或治疗决策;数据支持本地化部署,不出院;插件与自动化任务仅获得最小访问权限;管理员的每一次访问都可审计。'
      : 'A research-assistance tool, not for diagnosis or treatment decisions. On-premises deployment keeps data inside; plugins get least privilege; every admin access is auditable.',
    ctaTitle: isZh ? '开始使用' : 'Get started',
  };

  const groupIcons: Record<string, React.ReactNode> = {
    chat: <MessageSquare size={20} />,
    patients: <Users size={20} />,
    research: <FlaskConical size={20} />,
    memory: <Brain size={20} />,
    tools: <Wrench size={20} />,
    admin: <ShieldCheck size={20} />,
  };

  return (
    <MarketingShell>
      {/* Hero */}
      <section className="relative overflow-hidden border-b border-border">
        <div className="absolute inset-0 bg-gradient-to-b from-accent/5 via-transparent to-transparent" />
        <div className="relative mx-auto max-w-4xl px-4 py-20 text-center sm:py-28">
          <div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <BookOpen size={24} />
          </div>
          <h1 className="text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl">{T.title}</h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-text-secondary">{T.subtitle}</p>
        </div>
      </section>

      {/* Quick start */}
      <section className="mx-auto max-w-7xl px-4 py-16">
        <Card className="p-8">
          <h2 className="text-2xl font-bold text-text-primary">{T.quickStartTitle}</h2>
          <p className="mt-4 leading-relaxed text-text-secondary">{T.quickStart}</p>
        </Card>
      </section>

      {/* Chat scenes */}
      <section className="mx-auto max-w-7xl px-4 pb-16">
        <h2 className="mb-4 text-2xl font-bold text-text-primary">{T.chatTitle}</h2>
        <p className="mb-6 leading-relaxed text-text-secondary">{T.chatBody}</p>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[T.sceneGeneral, T.scenePatient, T.sceneDocument, T.sceneChart].map((s, i) => (
            <Card key={i} className="p-5">
              <span className="text-sm font-semibold text-text-primary">{s}</span>
            </Card>
          ))}
        </div>
      </section>

      {/* Feature overview (route-validated) */}
      <section className="border-y border-border bg-surface">
        <div className="mx-auto max-w-7xl px-4 py-16">
          <h2 className="text-2xl font-bold text-text-primary">{T.overviewTitle}</h2>
          <p className="mt-2 text-xs text-text-tertiary">{T.overviewNote}</p>
          <div className="mt-8 grid gap-8 lg:grid-cols-2">
            {featureGroups.map((g) => (
              <div key={g.key}>
                <div className="mb-3 flex items-center gap-2 font-semibold text-text-primary">
                  <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent">
                    {groupIcons[g.key]}
                  </span>
                  {g.title}
                </div>
                <div className="space-y-2">
                  {g.items.map((item) => (
                    <Link
                      key={item.path}
                      to={item.path.startsWith(':') ? `/app/patients/${item.path.replace(/^:/, '')}` : item.path}
                      className="block rounded-lg border border-border bg-surface-elevated p-3 transition-colors hover:border-accent/30"
                    >
                      <span className="text-sm font-medium text-text-primary">{item.title}</span>
                      <span className="block text-xs leading-relaxed text-text-secondary">{item.desc}</span>
                    </Link>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Memory & security */}
      <section className="mx-auto max-w-7xl px-4 py-16">
        <div className="grid gap-8 lg:grid-cols-2">
          <Card className="p-8">
            <h2 className="text-xl font-bold text-text-primary">{T.memoryTitle}</h2>
            <p className="mt-3 leading-relaxed text-text-secondary">{T.memoryBody}</p>
          </Card>
          <Card className="p-8">
            <h2 className="text-xl font-bold text-text-primary">{T.securityTitle}</h2>
            <p className="mt-3 leading-relaxed text-text-secondary">{T.securityBody}</p>
          </Card>
        </div>
      </section>

      {/* CTA */}
      <section className="border-t border-border bg-surface py-16 text-center">
        <Link to="/login?mode=register">
          <span className="inline-flex items-center gap-2 font-medium text-accent hover:underline">
            {T.ctaTitle}
            <ArrowRight size={16} />
          </span>
        </Link>
      </section>
    </MarketingShell>
  );
}
