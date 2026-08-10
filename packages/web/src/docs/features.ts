/**
 * #518-followup — 用户指南功能清单。
 *
 * 手工维护的语义化功能清单(路径必须存在于 App.tsx)。
 * 新增路由后运行 `node scripts/gen-feature-inventory.mjs` 校验同步,
 * 或补入下方对应分组。
 */

export interface FeatureGroup {
  key: string
  title: string
  items: Array<{ path: string; title: string; desc: string }>
}

export const featureGroups: FeatureGroup[] = [
  {
    key: 'chat',
    title: '对话',
    items: [
      { path: '/app/chat', title: '通用对话', desc: '四场景入口(通用/患者问诊/文档写作/图表分析),附件与图片解读,技能调用' },
      { path: ':hash/chat', title: '患者对话', desc: '关联患者上下文的问诊对话,自动注入病历图谱与记忆' },
      { path: '/app/brain', title: '并行深度分析', desc: '一次提问并行开展文献与临床多路分析' },
    ],
  },
  {
    key: 'patients',
    title: '患者管理',
    items: [
      { path: '/app/patients', title: '患者列表', desc: '患者建档、检索与切换' },
      { path: ':hash', title: '患者摘要', desc: '概览:基本信息、主诉、关键事件' },
      { path: ':hash/imaging', title: '影像', desc: '影像文件管理与解读' },
      { path: ':hash/labs', title: '检验', desc: '化验数据与趋势' },
      { path: ':hash/memory', title: '记忆图谱', desc: '患者专属 Facts/知识图谱可视化' },
      { path: ':hash/report', title: '报告', desc: '生成与查看患者报告' },
      { path: ':hash/records', title: '病历', desc: '病历文档管理' },
    ],
  },
  {
    key: 'research',
    title: '研究与写作',
    items: [
      { path: '/app/research', title: '研究管理', desc: '研究项目、方案与随访管理' },
      { path: '/app/research/:studyId', title: '研究详情', desc: '单研究视图:数据、图表与协作' },
      { path: '/app/writing', title: '写作工作台', desc: '文档创作、引用文献与图表库' },
      { path: '/app/writing/:docId', title: '文档编辑', desc: '富文本编辑(表格/图片/引用),随对话修改' },
      { path: '/app/viewer/:studyId', title: '方案查看器', desc: '研究方案只读预览' },
      { path: '/app/submission', title: '投稿', desc: '期刊投稿流程与格式检查' },
    ],
  },
  {
    key: 'memory',
    title: '记忆与知识库',
    items: [
      { path: '/app/memory', title: '记忆', desc: '事件日志、事实(Facts)与摘要(Episodes)管理' },
      { path: '/app/knowledge', title: '知识库', desc: '知识文章、检索与知识命令' },
      { path: '/app/memory-graph', title: '记忆图谱', desc: '全局知识图谱可视化与溯源' },
    ],
  },
  {
    key: 'tools',
    title: '工具与扩展',
    items: [
      { path: '/app/skills', title: '技能', desc: '可复用的工作流技能' },
      { path: '/app/plugins', title: '插件', desc: '插件市场与安装(chart/bioscene/browser-agent 等)' },
      { path: '/app/plugins/:namespace/:name/settings', title: '插件设置', desc: '已安装插件的配置' },
      { path: '/app/files', title: '文件', desc: '上传文件管理' },
      { path: '/app/schedule', title: '日程', desc: '随访与任务日程' },
      { path: '/app/export', title: '导出', desc: '数据导出(合规删除/备份)' },
    ],
  },
  {
    key: 'admin',
    title: '系统与审计',
    items: [
      { path: '/app/today', title: '今日', desc: '工作台:待办、随访提醒与最近动态' },
      { path: '/app/logs', title: '运行日志', desc: '系统运行与任务日志' },
      { path: '/app/audit', title: '审计', desc: '不可变事件审计记录' },
      { path: '/app/settings', title: '设置', desc: '账户与偏好设置' },
      { path: '/app/admin/users', title: '用户管理(管理员)', desc: '用户与角色管理' },
    ],
  },
]
