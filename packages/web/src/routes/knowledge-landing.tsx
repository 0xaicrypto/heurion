import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { BookOpen, Brain, Lightbulb, Wrench, FileText, ArrowRight, Search, CheckCircle2, RotateCcw, Trash2, Edit3 } from 'lucide-react';
import { Card } from '@/components/ui';
import { MarketingShell } from '@/components/marketing/MarketingShell';

export function KnowledgeLandingPage() {
  const { i18n } = useTranslation();
  const isZh = i18n.language.startsWith('zh');

  const T = {
    title: isZh ? '可进化的知识库' : 'Evolving knowledge base',
    subtitle: isZh
      ? 'Heurion 把聊天中沉淀的事实变成可管理、可检索、可补全的知识。不是静态文档库，而是会自己长大的临床记忆。'
      : 'Heurion turns facts accumulated in chat into manageable, searchable, and completable knowledge. Not a static document library, but a clinical memory that grows on its own.',

    tabsTitle: isZh ? '五大标签，统一入口' : 'Five tabs, one entry point',
    tabs: [
      {
        icon: <BookOpen size={22} />,
        title: 'Articles',
        desc: isZh ? '由 Facts 自动合成的综述文章，支持版本与失效检测。' : 'Synthesis articles generated from facts, with versioning and staleness detection.',
      },
      {
        icon: <Brain size={22} />,
        title: 'Facts',
        desc: isZh ? '结构化记忆片段，可按来源类型、患者、研究筛选与内联编辑。' : 'Structured memory snippets filterable by source type, patient, or study, with inline editing.',
      },
      {
        icon: <Lightbulb size={22} />,
        title: 'Gaps',
        desc: isZh ? '系统识别出的未解问题，支持回答、忽略或批量关闭。' : 'Unanswered questions identified by the system; answer, ignore, or close in bulk.',
      },
      {
        icon: <Wrench size={22} />,
        title: 'Tools',
        desc: isZh ? '已启用或待审核的插件与工具，支持开关与描述管理。' : 'Enabled or pending plugins and tools, with toggles and description management.',
      },
      {
        icon: <FileText size={22} />,
        title: 'Files',
        desc: isZh ? '上传文件与 Sidecar 生成结果，按租户隔离存储。' : 'Uploaded files and Sidecar outputs stored with tenant isolation.',
      },
    ],

    featuresTitle: isZh ? '管理功能' : 'Management features',
    features: [
      { icon: <Search size={20} />, title: isZh ? '搜索过滤' : 'Search & filter', desc: isZh ? '每个标签页都有独立关键词过滤，快速定位内容。' : 'Each tab has independent keyword filtering to locate content quickly.' },
      { icon: <RotateCcw size={20} />, title: isZh ? '分页浏览' : 'Pagination', desc: isZh ? '默认每页 10 条，避免长列表卡顿。' : 'Default 10 items per page to keep long lists smooth.' },
      { icon: <Trash2 size={20} />, title: isZh ? '多选批量删除' : 'Bulk delete', desc: isZh ? '勾选多项后一键删除，减少重复操作。' : 'Select multiple items and delete them in one go.' },
      { icon: <Edit3 size={20} />, title: isZh ? '内联编辑' : 'Inline editing', desc: isZh ? 'Facts 可直接在列表里修改内容并保存。' : 'Facts can be edited directly in the list and saved.' },
    ],

    evolveTitle: isZh ? '从 Facts 到 Articles 的进化' : 'Evolution from Facts to Articles',
    evolveBody: isZh
      ? '聊天每满 5 轮自动提取 Facts；当同一主题积累 ≥3 条相关 Facts，系统会生成一篇 Knowledge Article。Articles 不是孤立文档，而是指向来源 Facts 的“活”知识。'
      : 'Facts are extracted automatically every 5 chat turns. When ≥3 related facts accumulate on one topic, the system generates a Knowledge Article. Articles are not isolated documents — they are "living" knowledge linked to their source facts.',

    gapTitle: isZh ? 'Knowledge Gap：让未解问题显式化' : 'Knowledge Gap: make the unknown visible',
    gapBody: isZh
      ? '当用户提问却没有匹配的事实时，系统会创建一个 Gap。它不会沉默地胡说，而是把“我不知道”记录下来，等您后续回答、搜索或验证。'
      : 'When a user asks something with no matching facts, the system creates a Gap. Instead of silently hallucinating, it records "I don\'t know" and waits for you to answer, search, or validate later.',

    ctaTitle: isZh ? '去知识库看看' : 'Browse the knowledge base',
    ctaBody: isZh ? '登录后进入 /app/knowledge，查看您的 Articles、Facts 与 Gaps。' : 'Log in and go to /app/knowledge to see your Articles, Facts, and Gaps.',
  };

  return (
    <MarketingShell>
      <section className="relative overflow-hidden border-b border-border">
        <div className="absolute inset-0 bg-gradient-to-b from-accent/5 to-transparent" />
        <div className="relative mx-auto max-w-4xl px-4 py-20 text-center sm:py-28">
          <div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <BookOpen size={24} />
          </div>
          <h1 className="text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl">{T.title}</h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-text-secondary">{T.subtitle}</p>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 py-24">
        <h2 className="mb-10 text-center text-2xl font-bold text-text-primary">{T.tabsTitle}</h2>
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {T.tabs.map((tab, idx) => (
            <Card key={idx} className="p-6 transition-all hover:border-accent/30">
              <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent">{tab.icon}</div>
              <h3 className="text-lg font-semibold text-text-primary">{tab.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-text-secondary">{tab.desc}</p>
            </Card>
          ))}
        </div>
      </section>

      <section className="bg-surface">
        <div className="mx-auto max-w-7xl px-4 py-24">
          <h2 className="mb-10 text-center text-2xl font-bold text-text-primary">{T.featuresTitle}</h2>
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {T.features.map((f, idx) => (
              <div key={idx} className="flex items-start gap-4">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">{f.icon}</div>
                <div>
                  <h3 className="font-semibold text-text-primary">{f.title}</h3>
                  <p className="mt-1 text-sm text-text-secondary">{f.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 py-24">
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <div>
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <CheckCircle2 size={24} />
            </div>
            <h2 className="text-2xl font-bold text-text-primary">{T.evolveTitle}</h2>
            <p className="mt-4 text-lg leading-relaxed text-text-secondary">{T.evolveBody}</p>
          </div>
          <Card className="p-6">
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-accent/10 text-xs font-bold text-accent">1</div>
                <span className="text-text-secondary">{isZh ? '聊天 → 自动提取 Facts' : 'Chat → auto-extract Facts'}</span>
              </div>
              <div className="ml-4 h-6 w-0.5 bg-border" />
              <div className="flex items-center gap-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-accent/10 text-xs font-bold text-accent">2</div>
                <span className="text-text-secondary">{isZh ? '≥3 条相关 Facts → 合成 Article' : '≥3 related facts → synthesize Article'}</span>
              </div>
              <div className="ml-4 h-6 w-0.5 bg-border" />
              <div className="flex items-center gap-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-accent/10 text-xs font-bold text-accent">3</div>
                <span className="text-text-secondary">{isZh ? 'Article 被投影到后续对话' : 'Article projected into later turns'}</span>
              </div>
            </div>
          </Card>
        </div>
      </section>

      <section className="bg-surface">
        <div className="mx-auto max-w-7xl px-4 py-24">
          <div className="grid items-center gap-12 lg:grid-cols-2">
            <Card className="p-6">
              <div className="rounded-lg border border-border bg-background p-4">
                <div className="flex items-center gap-2 text-text-tertiary">
                  <Lightbulb size={16} />
                  <span className="text-xs">{isZh ? '未解问题示例' : 'Example gap'}</span>
                </div>
                <p className="mt-2 text-text-primary">{isZh ? '“EGFR ex20ins 的最佳一线治疗方案是什么？”' : '"What is the best first-line treatment for EGFR ex20ins?"'}</p>
                <div className="mt-3 flex gap-2">
                  <span className="rounded-md bg-success/10 px-2 py-1 text-xs text-success">{isZh ? '回答' : 'Answer'}</span>
                  <span className="rounded-md bg-surface px-2 py-1 text-xs text-text-secondary">{isZh ? '忽略' : 'Ignore'}</span>
                </div>
              </div>
            </Card>
            <div>
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-accent/10 text-accent">
                <Lightbulb size={24} />
              </div>
              <h2 className="text-2xl font-bold text-text-primary">{T.gapTitle}</h2>
              <p className="mt-4 text-lg leading-relaxed text-text-secondary">{T.gapBody}</p>
            </div>
          </div>
        </div>
      </section>

      <section className="border-t border-border bg-surface">
        <div className="mx-auto max-w-7xl px-4 py-16 text-center">
          <h2 className="text-2xl font-bold text-text-primary">{T.ctaTitle}</h2>
          <p className="mx-auto mt-3 max-w-xl text-text-secondary">{T.ctaBody}</p>
          <div className="mt-6">
            <Link to="/app/knowledge" className="inline-flex items-center font-medium text-accent hover:underline">
              {isZh ? '打开知识库' : 'Open knowledge base'}
              <ArrowRight size={16} className="ml-1" />
            </Link>
          </div>
        </div>
      </section>
    </MarketingShell>
  );
}
