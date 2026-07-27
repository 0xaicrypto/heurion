import { useTranslation } from 'react-i18next';
import { Shield, Server, Cpu, Lock, Users, FileKey, Eye, ArrowRight } from 'lucide-react';
import { Card } from '@/components/ui';
import { MarketingShell } from '@/components/marketing/MarketingShell';

export function SecurityPage() {
  const { i18n } = useTranslation();
  const isZh = i18n.language.startsWith('zh');

  const T = {
    title: isZh ? '安全与隔离架构' : 'Security & isolation architecture',
    subtitle: isZh
      ? 'Heurion 从设计之初就把临床数据的隐私、可审计与最小权限放在第一位。'
      : 'Heurion was designed from the ground up with clinical data privacy, auditability, and least privilege in mind.',

    planesTitle: isZh ? '双平面隔离' : 'Two-plane isolation',
    planes: [
      {
        icon: <Server size={24} />,
        title: isZh ? '控制面 Control Plane' : 'Control Plane',
        desc: isZh
          ? '运行 Fastify + Prisma + SQLite：认证、授权、患者、研究、知识库、插件管理。插件无法直接访问。'
          : 'Runs Fastify + Prisma + SQLite: authentication, authorization, patients, research, knowledge base, and plugin management. Plugins cannot reach it directly.',
      },
      {
        icon: <Cpu size={24} />,
        title: isZh ? '执行面 Execution Plane' : 'Execution Plane',
        desc: isZh
          ? '运行 FastAPI + Redis + heurion_worker：报告渲染、插件沙箱、对象存储上传。与主数据库隔离。'
          : 'Runs FastAPI + Redis + heurion_worker: report rendering, plugin sandbox, and object-storage upload. Isolated from the main database.',
      },
    ],

    principlesTitle: isZh ? '核心安全原则' : 'Core security principles',
    principles: [
      {
        icon: <Lock size={22} />,
        title: isZh ? '租户隔离' : 'Tenant isolation',
        desc: isZh ? '每个用户的事件日志、事实、知识与文件都按 workspace 隔离存储。' : 'Each user\'s event log, facts, knowledge, and files are stored in an isolated workspace.',
      },
      {
        icon: <Users size={22} />,
        title: isZh ? '角色访问控制' : 'Role-based access',
        desc: isZh ? '普通用户与管理员拥有不同侧边栏入口与 API 权限。' : 'Regular users and admins see different sidebar entries and API permissions.',
      },
      {
        icon: <Eye size={22} />,
        title: isZh ? '可审计' : 'Auditable',
        desc: isZh ? '不可变 EventLog 记录每次聊天、文件生成与事实变更，支持导出。' : 'An immutable EventLog records every chat, file generation, and fact change, and supports export.',
      },
      {
        icon: <FileKey size={22} />,
        title: isZh ? '最小权限' : 'Least privilege',
        desc: isZh ? '插件与报告助手只拥有完成任务所需的最小访问范围。' : 'Plugins and report-assistant workers have only the minimum access needed to complete their tasks.',
      },
    ],

    contextTitle: isZh ? '患者上下文强制注入' : 'Mandatory patient context injection',
    contextBody: isZh
      ? '当对话关联到具体患者时，系统会把年龄、性别、主诉、最近文件等上下文强制拼接到 Prompt 中。这降低了模型“遗忘”患者信息而给出通用建议的风险。'
      : 'When a conversation is linked to a specific patient, the system forcibly appends age, sex, chief complaint, recent files, and other context to the prompt. This reduces the risk of the model "forgetting" the patient and giving generic advice.',

    selfHostTitle: isZh ? '自托管友好' : 'Self-host friendly',
    selfHostBody: isZh
      ? '所有服务都可通过 Docker Compose 在本地或私有云运行。API 密钥、对象存储与数据库连接均可通过环境变量配置，数据不出境。'
      : 'All services can run locally or in a private cloud via Docker Compose. API keys, object storage, and database connections are configurable via environment variables, keeping data on premises.',

    ctaTitle: isZh ? '查看开源代码与安全说明' : 'Review the open-source code and security notes',
  };

  return (
    <MarketingShell>
      <section className="relative overflow-hidden border-b border-border">
        <div className="absolute inset-0 bg-gradient-to-b from-accent/5 to-transparent" />
        <div className="relative mx-auto max-w-4xl px-4 py-20 text-center sm:py-28">
          <div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <Shield size={24} />
          </div>
          <h1 className="text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl">{T.title}</h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-text-secondary">{T.subtitle}</p>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 py-24">
        <h2 className="mb-10 text-center text-2xl font-bold text-text-primary">{T.planesTitle}</h2>
        <div className="grid gap-6 lg:grid-cols-2">
          {T.planes.map((p, idx) => (
            <Card key={idx} className="p-8 transition-all hover:border-accent/30">
              <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-xl bg-accent/10 text-accent">{p.icon}</div>
              <h3 className="text-xl font-bold text-text-primary">{p.title}</h3>
              <p className="mt-3 leading-relaxed text-text-secondary">{p.desc}</p>
            </Card>
          ))}
        </div>
      </section>

      <section className="bg-surface">
        <div className="mx-auto max-w-7xl px-4 py-24">
          <h2 className="mb-10 text-center text-2xl font-bold text-text-primary">{T.principlesTitle}</h2>
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {T.principles.map((p, idx) => (
              <Card key={idx} className="p-6 text-center transition-all hover:border-accent/30">
                <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-accent/10 text-accent">{p.icon}</div>
                <h3 className="font-semibold text-text-primary">{p.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-text-secondary">{p.desc}</p>
              </Card>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 py-24">
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <div>
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <Lock size={24} />
            </div>
            <h2 className="text-2xl font-bold text-text-primary">{T.contextTitle}</h2>
            <p className="mt-4 text-lg leading-relaxed text-text-secondary">{T.contextBody}</p>
          </div>
          <Card className="p-6">
            <div className="space-y-3 text-sm text-text-secondary">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-success" />
                {isZh ? '当前患者 demographics 注入' : 'Current patient demographics injected'}
              </div>
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-success" />
                {isZh ? '最近 5 份文件上下文' : 'Last 5 file contexts'}
              </div>
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-success" />
                {isZh ? '患者列表（Roster）始终可见' : 'Patient roster always visible'}
              </div>
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-success" />
                {isZh ? '相关 Facts / Knowledge 加权投影' : 'Weighted projection of relevant facts/knowledge'}
              </div>
            </div>
          </Card>
        </div>
      </section>

      <section className="bg-surface">
        <div className="mx-auto max-w-7xl px-4 py-24 text-center">
          <div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <Server size={24} />
          </div>
          <h2 className="text-2xl font-bold text-text-primary">{T.selfHostTitle}</h2>
          <p className="mx-auto mt-4 max-w-2xl text-text-secondary">{T.selfHostBody}</p>
          <div className="mt-6">
            <a
              href="https://github.com/0xaicrypto/heurion"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center font-medium text-accent hover:underline"
            >
              {T.ctaTitle}
              <ArrowRight size={16} className="ml-1" />
            </a>
          </div>
        </div>
      </section>
    </MarketingShell>
  );
}
