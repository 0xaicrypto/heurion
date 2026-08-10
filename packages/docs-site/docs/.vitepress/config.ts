import { defineConfig } from 'vitepress'

/**
 * Heurion 用户使用指南 — VitePress 配置。
 * 部署后站点位于 /docs 路径(base 与主站区分)。
 */
export default defineConfig({
  title: 'Heurion 用户指南',
  description: '面向医生与研究人员的 Heurion 使用指南',
  lang: 'zh-CN',
  base: '/docs/',
  themeConfig: {
    logo: '/heurion-logo.svg',
    nav: [
      { text: '指南', link: '/guide/quick-start' },
      { text: '功能', link: '/guide/chat' },
      { text: 'FAQ', link: '/guide/faq' },
    ],
    sidebar: [
      {
        text: '入门',
        items: [
          { text: '快速开始', link: '/guide/quick-start' },
          { text: '对话', link: '/guide/chat' },
        ],
      },
      {
        text: '核心功能',
        items: [
          { text: '患者管理', link: '/guide/patients' },
          { text: '研究与写作', link: '/guide/research-writing' },
          { text: '记忆与知识库', link: '/guide/memory-knowledge' },
        ],
      },
      {
        text: '工具与合规',
        items: [
          { text: '技能与插件', link: '/guide/tools-plugins' },
          { text: '安全与合规', link: '/guide/security' },
          { text: '常见问题', link: '/guide/faq' },
        ],
      },
    ],
    footer: {
      message: 'Heurion — 面向临床科研的数字化医疗助手',
      copyright: '仅用于科研辅助,不构成诊断或治疗建议',
    },
  },
})
