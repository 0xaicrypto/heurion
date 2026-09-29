import { useTranslation } from 'react-i18next';
import { Shield, Server, Cpu, Lock, Users, FileKey, Eye, ArrowRight } from 'lucide-react';
import { Card } from '@/components/ui';
import { MarketingShell } from '@/components/marketing/MarketingShell';

export function SecurityPage() {
  const { t } = useTranslation();

  const T = {
    title: t('security.title', '安全与隔离架构'),
    subtitle: t('security.subtitle', 'Heurion 从设计之初就把临床数据的隐私、可审计与最小权限放在第一位。'),

    planesTitle: t('security.planesTitle', '双平面隔离'),
    planes: [
      {
        icon: <Server size={24} />,
        title: t('security.planeControl', '控制面 Control Plane'),
        desc: t('security.planeControlDesc', '承载认证、授权、患者、研究、知识库与插件管理；插件无法直接访问核心数据。'),
      },
      {
        icon: <Cpu size={24} />,
        title: t('security.planeExecution', '执行面 Execution Plane'),
        desc: t('security.planeExecutionDesc', '承载报告渲染、插件沙箱与文件交付；与核心数据隔离。'),
      },
    ],

    principlesTitle: t('security.principlesTitle', '核心安全原则'),
    principles: [
      {
        icon: <Lock size={22} />,
        title: t('security.principalTenant', '租户隔离'),
        desc: t('security.principalTenantDesc', '每个用户的事件日志、事实、知识与文件都按 workspace 隔离存储。'),
      },
      {
        icon: <Users size={22} />,
        title: t('security.principalRbac', '角色访问控制'),
        desc: t('security.principalRbacDesc', '普通用户与管理员拥有不同侧边栏入口与 API 权限。'),
      },
      {
        icon: <Eye size={22} />,
        title: t('security.principalAudit', '可审计'),
        desc: t('security.principalAuditDesc', '不可变 EventLog 记录每次聊天、文件生成与事实变更，支持导出。'),
      },
      {
        icon: <FileKey size={22} />,
        title: t('security.principalLeastPrivilege', '最小权限'),
        desc: t('security.principalLeastPrivilegeDesc', '插件与自动化任务只拥有完成任务所需的最小访问范围。'),
      },
    ],

    contextTitle: t('security.contextTitle', '患者上下文强制注入'),
    contextBody: t('security.contextBody', '当对话关联到具体患者时，系统会把年龄、性别、主诉、最近文件等上下文强制拼接到 Prompt 中。这降低了模型“遗忘”患者信息而给出通用建议的风险。'),

    // #514: 法规映射 — 面向医院信息科/合规角色的具体承诺。
    regulationsTitle: t('security.regulationsTitle', '法规与合规映射'),
    regulations: [
      {
        framework: t('security.regPiplFramework', '个人信息保护法（PIPL）'),
        mechanisms: t('security.regPiplMechanisms', '最小必要收集（仅存储任务所需字段）；数据本地化部署；用户数据导出与删除能力'),
      },
      {
        framework: t('security.regHipaaFramework', 'HIPAA（美国）'),
        mechanisms: t('security.regHipaaMechanisms', '租户级数据隔离；不可变审计日志（EventLog）记录访问与生成；角色访问控制；传输加密（TLS）'),
      },
      {
        framework: t('security.regGdprFramework', 'GDPR（欧盟）'),
        mechanisms: t('security.regGdprMechanisms', '数据主体导出/删除（隐私权）；事件日志保留策略可配置；最小化处理原则'),
      },
      {
        framework: t('security.regClassificationFramework', '医疗数据分级分类'),
        mechanisms: t('security.regClassificationMechanisms', '敏感字段（诊断、基因、影像）按用途分级；科研计算沙箱与核心病历库物理隔离'),
      },
    ],

    selfHostTitle: t('security.selfHostTitle', '自托管友好'),
    selfHostBody: t('security.selfHostBody', '支持在本地或私有云中完整部署，敏感数据不出境；无需依赖外部服务即可运行全部功能。'),

    ctaTitle: t('security.ctaTitle', '查看开源代码与安全说明'),
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
                {t('security.contextItemDemographics', '当前患者 demographics 注入')}
              </div>
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-success" />
                {t('security.contextItemFiles', '最近 5 份文件上下文')}
              </div>
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-success" />
                {t('security.contextItemRoster', '患者列表（Roster）始终可见')}
              </div>
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-success" />
                {t('security.contextItemFacts', '相关 Facts / Knowledge 加权投影')}
              </div>
            </div>
          </Card>
        </div>
      </section>

      {/* #514: 法规映射表 — 面向医院信息科/合规角色的具体承诺。 */}
      <section className="bg-surface">
        <div className="mx-auto max-w-5xl px-4 py-24">
          <h2 className="mb-10 text-center text-2xl font-bold text-text-primary">{T.regulationsTitle}</h2>
          <div className="overflow-hidden rounded-xl border border-border">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-elevated">
                  <th className="px-4 py-3 font-semibold text-text-primary">{t('security.regulationsFrameworkCol', '法规 / 框架')}</th>
                  <th className="px-4 py-3 font-semibold text-text-primary">{t('security.regulationsMechanismsCol', 'Heurion 对应机制')}</th>
                </tr>
              </thead>
              <tbody>
                {T.regulations.map((r, idx) => (
                  <tr key={idx} className="border-b border-border last:border-b-0">
                    <td className="whitespace-nowrap px-4 py-3 align-top font-medium text-text-primary">{r.framework}</td>
                    <td className="px-4 py-3 leading-relaxed text-text-secondary">{r.mechanisms}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
