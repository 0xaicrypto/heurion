import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { FileText, LayoutGrid, Table, BarChart3, ArrowRight, RefreshCw, Database, CheckCircle2, Sparkles } from 'lucide-react';
import { Card } from '@/components/ui';
import { MarketingShell } from '@/components/marketing/MarketingShell';

export function SidecarPage() {
  const { t } = useTranslation();

  const T = {
    title: t('sidecar.title', '智能报告助手：从聊天到文档'),
    subtitle: t('sidecar.subtitle', '一句话把临床讨论变成可交付的文档、表格或图表。报告助手在执行面独立渲染，不阻塞聊天流。'),

    outputsTitle: t('sidecar.outputsTitle', '支持生成的内容'),
    outputs: [
      {
        icon: <FileText size={24} />,
        title: 'DOCX',
        desc: t('sidecar.desc', '病例总结、出院小结、研究方案、随访记录'),
      },
      {
        icon: <LayoutGrid size={24} />,
        title: 'PPTX',
        desc: t('sidecar.desc2', '学术汇报幻灯片，自动分页与标题层级'),
      },
      {
        icon: <Table size={24} />,
        title: t('sidecar.title2', '表格'),
        desc: t('sidecar.desc3', '基线特征表、Table 1、不良事件汇总'),
      },
      {
        icon: <BarChart3 size={24} />,
        title: t('sidecar.title3', '图表'),
        desc: t('sidecar.desc4', 'KM 生存曲线、柱状图、折线图、森林图'),
      },
    ],

    flowTitle: t('sidecar.flowTitle', '一句话生成，三步交付'),
    flowSteps: [
      {
        title: t('sidecar.title4', '1. 意图识别'),
        desc: t('sidecar.desc5', 'Query Router 识别“生成/创建/导出”等报告请求，避免普通聊天误触发。'),
      },
      {
        title: t('sidecar.title5', '2. 执行面渲染'),
        desc: t('sidecar.desc6', '任务在隔离环境中异步完成文件生成与交付。'),
      },
      {
        title: t('sidecar.title6', '3. 刷新不丢的下载'),
        desc: t('sidecar.desc7', 'fileId 持久化到 EventLog，刷新页面后仍可通过 fileId 重新获取下载链接。'),
      },
    ],

    capabilityTitle: t('sidecar.capabilityTitle', '能力检测，避免空转'),
    capabilityBody: t('sidecar.capabilityBody', '如果用户只是问“你可以创建 PPT 吗？”，报告助手不会真的生成空文件，而是返回可用格式与使用示例。'),

    kbTitle: t('sidecar.kbTitle', '一键加入知识库'),
    kbBody: t('sidecar.kbBody', '生成文件时，报告助手同时输出 knowledgePayload。聊天界面的下载卡片提供“加入知识库”选项，把文档结构化为 Facts 或 Summaries。'),

    ctaTitle: t('sidecar.ctaTitle', '在聊天里试试'),
    ctaBody: t('sidecar.ctaBody', '登录后打开 Chat，输入“生成一份 NSCLC 免疫治疗进展的 PPTX”。'),
  };

  return (
    <MarketingShell>
      <section className="relative overflow-hidden border-b border-border">
        <div className="absolute inset-0 bg-gradient-to-b from-accent/5 to-transparent" />
        <div className="relative mx-auto max-w-4xl px-4 py-20 text-center sm:py-28">
          <div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <Sparkles size={24} />
          </div>
          <h1 className="text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl">{T.title}</h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-text-secondary">{T.subtitle}</p>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 py-24">
        <h2 className="mb-10 text-center text-2xl font-bold text-text-primary">{T.outputsTitle}</h2>
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {T.outputs.map((o, idx) => (
            <Card key={idx} className="p-6 text-center transition-all hover:border-accent/30">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-accent/10 text-accent">{o.icon}</div>
              <h3 className="font-semibold text-text-primary">{o.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-text-secondary">{o.desc}</p>
            </Card>
          ))}
        </div>
      </section>

      <section className="bg-surface">
        <div className="mx-auto max-w-7xl px-4 py-24">
          <h2 className="mb-10 text-center text-2xl font-bold text-text-primary">{T.flowTitle}</h2>
          <div className="grid gap-6 sm:grid-cols-3">
            {T.flowSteps.map((s, idx) => (
              <Card key={idx} className="relative p-6">
                <span className="absolute -right-2 -top-4 text-6xl font-bold text-accent/5">0{idx + 1}</span>
                <h3 className="text-lg font-bold text-text-primary">{s.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-text-secondary">{s.desc}</p>
              </Card>
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
            <h2 className="text-2xl font-bold text-text-primary">{T.capabilityTitle}</h2>
            <p className="mt-4 text-lg leading-relaxed text-text-secondary">{T.capabilityBody}</p>
          </div>
          <Card className="p-6">
            <div className="flex items-center gap-2 text-sm text-text-tertiary">
              <RefreshCw size={16} />
              <span>{t('sidecar.item', '示例')}</span>
            </div>
            <p className="mt-3 text-text-primary">{t('sidecar.item2', '“生成一份 EGFR-TKI 耐药机制综述的 PPTX，包含研究进展和临床意义。”')}</p>
          </Card>
        </div>
      </section>

      <section className="bg-surface">
        <div className="mx-auto max-w-7xl px-4 py-24">
          <div className="grid items-center gap-12 lg:grid-cols-2">
            <Card className="p-6">
              <div className="flex items-center gap-2 text-accent">
                <Database size={20} />
                <span className="font-bold">{t('sidecar.item3', 'knowledgePayload')}</span>
              </div>
              <p className="mt-3 text-sm text-text-secondary">{T.kbBody}</p>
            </Card>
            <div>
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-accent/10 text-accent">
                <Database size={24} />
              </div>
              <h2 className="text-2xl font-bold text-text-primary">{T.kbTitle}</h2>
              <p className="mt-4 text-lg leading-relaxed text-text-secondary">{T.kbBody}</p>
            </div>
          </div>
        </div>
      </section>

      <section className="border-t border-border bg-surface">
        <div className="mx-auto max-w-7xl px-4 py-16 text-center">
          <h2 className="text-2xl font-bold text-text-primary">{T.ctaTitle}</h2>
          <p className="mx-auto mt-3 max-w-xl text-text-secondary">{T.ctaBody}</p>
          <div className="mt-6">
            <Link to="/app/chat" className="inline-flex items-center font-medium text-accent hover:underline">
              {t('sidecar.item4', '打开聊天')}
              <ArrowRight size={16} className="ml-1" />
            </Link>
          </div>
        </div>
      </section>
    </MarketingShell>
  );
}
