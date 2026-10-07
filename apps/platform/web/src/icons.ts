/**
 * 统一矢量图标系统 (Heurion Unified Vector Icon System)
 *
 * 与全站极简医疗工作站设计语言严格保持一致：
 * - 纯净单色矢量线条 (stroke="currentColor", fill="none")
 * - 统一 1.4~1.5 细线条几何轮廓与圆角端点 (stroke-linecap="round", stroke-linejoin="round")
 * - 告别刺眼杂乱的彩色 Emoji，全站按键、标签、弹窗、导航均呈现精致统一的临床科研视觉体系
 */

export type IconName =
  | 'scan'
  | 'mpr'
  | 'report'
  | 'evidence'
  | 'compare'
  | 'download'
  | 'write'
  | 'deck'
  | 'search'
  | 'target'
  | 'save'
  | 'copy'
  | 'lock'
  | 'layers'
  | 'pin'
  | 'eye'
  | 'print'
  | 'building'
  | 'users'
  | 'shield'
  | 'template'
  | 'info'
  | 'check'
  | 'close'
  | 'sparkles'
  | 'globe'
  | 'chart'
  | 'link'
  | 'microscope'
  | 'dna'
  | 'hospital'
  | 'file'
  | 'folder'
  | 'refresh'
  | 'chat'
  | 'camera'
  | 'home'
  | 'warning'
  | 'arrowRight'
  | 'grid'
  | 'edit'
  | 'book'
  | 'caliper'
  | 'ruler'
  | 'nsclc'
  | 'calendar'
  | 'mail'
  | 'clock'
  | 'send'
  | 'star'
  | 'trash'
  | 'reply'
  | 'forward'
  | 'paperclip'
  | 'archive'
  | 'bot'

const ICONS: Record<IconName, string> = {
  // 3D 医学影像、CT 扫描
  scan: '<rect x="2.5" y="2.5" width="15" height="15" rx="3"/><circle cx="10" cy="10" r="4"/><path d="M10 2.5v3M10 14.5v3M2.5 10h3M14.5 10h3"/>',
  
  // 3D 多平面重建 (MPR) 正交三视图
  mpr: '<rect x="2" y="2" width="7" height="7" rx="1.5"/><rect x="11" y="2" width="7" height="7" rx="1.5"/><rect x="2" y="11" width="7" height="7" rx="1.5"/><path d="M11 14.5h7M14.5 11v7"/>',

  // 诊断报告、病历文书
  report: '<path d="M4 2.5h8l4 4v11H4z"/><path d="M12 2.5v4h4M7 8.5h6M7 11.5h6M7 14.5h3.5"/>',

  // 科学证据、因果链
  evidence: '<circle cx="6" cy="6" r="3"/><circle cx="14" cy="14" r="3"/><circle cx="14" cy="6" r="2.5"/><path d="M8.5 7.5l3.5 4.5M8.5 6h3"/>',

  // 随访对比、趋势对比
  compare: '<path d="M3 17V3M3 17h14M7 13l3.5-4 3 2.5 4-5.5"/>',

  // 导出、下载
  download: '<path d="M10 3v9M6.5 8.5L10 12l3.5-3.5M3.5 16h13"/>',

  // 书写、病例撰写
  write: '<path d="M11 3.5l5.5 5.5-8.5 8.5H2.5v-5.5zM13.5 1.5l3 3-1.5 1.5-3-3z"/>',

  // 幻灯片、Slide
  deck: '<rect x="2" y="3" width="16" height="11" rx="2"/><path d="M10 14v3.5M6.5 17.5h7M7 8h6"/>',

  // 查看、切片探查
  search: '<circle cx="8.5" cy="8.5" r="5.5"/><path d="M13 13l4.5 4.5"/>',

  // 定位病灶、十字准星
  target: '<circle cx="10" cy="10" r="7"/><circle cx="10" cy="10" r="2.5"/><path d="M10 1.5v3M10 15.5v3M1.5 10h3M15.5 10h3"/>',

  // 保存、归档、落库
  save: '<path d="M4 2.5h9.5l3 3V17.5H4z"/><path d="M7 2.5v4h5v-4M7 17.5v-6h6v6"/>',

  // 复制剪贴板
  copy: '<rect x="6.5" y="6.5" width="10" height="10" rx="2"/><path d="M3.5 13.5h-1v-10h10v1"/>',

  // 锁定
  lock: '<rect x="4.5" y="8.5" width="11" height="8.5" rx="2"/><path d="M7 8.5V6a3 3 0 0 1 6 0v2.5"/>',

  // 图层、热力图、多结构
  layers: '<polygon points="10 2.5 17 6 10 9.5 3 6"/><polyline points="3 10.5 10 14 17 10.5"/><polyline points="3 14 10 17.5 17 14"/>',

  // 锚点、基线标记
  pin: '<path d="M10 2.5a5 5 0 0 0-5 5c0 3.75 5 10 5 10s5-6.25 5-10a5 5 0 0 0-5-5z"/><circle cx="10" cy="7.5" r="1.75"/>',

  // 预览、排版视图
  eye: '<path d="M1.5 10s3.5-6.5 8.5-6.5 8.5 6.5 8.5 6.5-3.5 6.5-8.5 6.5S1.5 10 1.5 10z"/><circle cx="10" cy="10" r="3"/>',

  // 打印
  print: '<path d="M5.5 6.5V2.5h9v4M5.5 14.5v3h9v-3"/><rect x="2.5" y="6.5" width="15" height="8" rx="2"/><circle cx="14.5" cy="9.5" r=".75" fill="currentColor"/>',

  // 机构
  building: '<path d="M3 18V4.5a1.5 1.5 0 0 1 1.5-1.5h11a1.5 1.5 0 0 1 1.5 1.5V18M2 18h16M6.5 7h2M11.5 7h2M6.5 10.5h2M11.5 10.5h2M9 18v-4h2v4"/>',

  // 成员、用户群
  users: '<circle cx="7.5" cy="6.5" r="3"/><path d="M2.5 16.5c.5-3 2.5-4.5 5-4.5s4.5 1.5 5 4.5"/><path d="M13.5 3.5a2.5 2.5 0 0 1 0 5M16.5 14.5c.3-1.8-1-3-2.5-3.5"/>',

  // 安全审计、合规
  shield: '<path d="M10 2.5l7 3v5c0 4.5-3.5 7.5-7 8.5-3.5-1-7-4-7-8.5v-5z"/><path d="M7.5 10l2 2 3.5-4"/>',

  // 机构模板
  template: '<rect x="3" y="2.5" width="14" height="15" rx="2"/><path d="M3 7.5h14M8.5 7.5V17.5"/>',

  // 提示、信息
  info: '<circle cx="10" cy="10" r="7.5"/><path d="M10 9v5M10 6v.5"/>',

  // 完成、成功
  check: '<polyline points="4.5 10.5 8 14 15.5 6.5"/>',

  // 关闭
  close: '<path d="M5 5l10 10M15 5L5 15"/>',

  // AI 智能
  sparkles: '<path d="M10 2l1.8 4.2L16 8l-4.2 1.8L10 14l-1.8-4.2L4 8l4.2-1.8zM15 13l.9 2.1L18 16l-2.1.9L15 19l-.9-2.1L12 16l2.1-.9z"/>',

  // WebGL、网络
  globe: '<circle cx="10" cy="10" r="7.5"/><ellipse cx="10" cy="10" rx="3.5" ry="7.5"/><path d="M2.5 10h15"/>',

  // 柱状图、指标
  chart: '<path d="M3 17.5V2.5M3 17.5h14M6.5 14v-4.5M10.5 14v-8M14.5 14v-2.5"/>',

  // 链接
  link: '<path d="M8.5 11.5l3-3a2.8 2.8 0 1 1 4 4l-3 3a2.8 2.8 0 0 1-4-4z"/><path d="M11.5 8.5l-3 3a2.8 2.8 0 1 1-4-4l3-3a2.8 2.8 0 0 1 4 4z"/>',

  // 显微镜、病理
  microscope: '<path d="M6 3h5M8.5 3v5M5 8h7l-1 5H6zM4 17.5h12M13 14a4 4 0 0 1-4 3.5"/>',

  // 基因组学、生物标志物
  dna: '<path d="M3 4c3 3 11 3 14 0M3 16c3-3 11-3 14 0M6 6.5v7M14 6.5v7M10 8.5v3"/>',

  // 医院、科室
  hospital: '<rect x="3" y="3" width="14" height="15" rx="2"/><path d="M10 6.5v5M7.5 9h5M8 18v-3h4v3"/>',

  // 文件
  file: '<path d="M4 2.5h7.5L16 7v11H4z"/><path d="M11.5 2.5V7H16"/>',

  // 文件夹
  folder: '<path d="M2.5 5.5a1.5 1.5 0 0 1 1.5-1.5h3.5l2 2h6a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H4a1.5 1.5 0 0 1-1.5-1.5z"/>',

  // 刷新、重置
  refresh: '<path d="M3 10a7 7 0 1 1 2 5.2M3 15v-5h5"/>',

  // 对话、咨询
  chat: '<path d="M4 4h12a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H7l-4 3V6a2 2 0 0 1 2-2z"/>',

  // 拍照、上传图像
  camera: '<path d="M4 6.5h2.5l1.5-2h4l1.5 2H16a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z"/><circle cx="10" cy="12" r="3"/>',

  // 档案首页
  home: '<path d="M3 9l7-6 7 6v8a1.5 1.5 0 0 1-1.5 1.5H4.5A1.5 1.5 0 0 1 3 17V9z"/><path d="M8 18.5v-6h4v6"/>',

  // 警告、注意
  warning: '<path d="M10 2.5l8 14H2z"/><path d="M10 7.5v4M10 14v.5"/>',

  // 箭头导航
  arrowRight: '<path d="M3.5 10h13M11.5 5l5 5-5 5"/>',

  // 网格、数据集矩阵
  grid: '<rect x="3" y="3" width="14" height="14" rx="2"/><path d="M3 10h14M10 3v14"/>',

  // 编辑
  edit: '<path d="M11.5 3.5l5 5-9.5 9.5H2.5v-4.5z"/>',

  // 教程、指南、书本
  book: '<path d="M4 16.5A2.5 2.5 0 0 1 6.5 14H17"/><path d="M6.5 3H17v14H6.5A2.5 2.5 0 0 1 4 14.5v-9A2.5 2.5 0 0 1 6.5 3z"/>',

  // 测距卡尺、游标测量
  caliper: '<path d="M3 4v12M17 4v12M3 10h14M3 6h4M3 14h4M17 6h-4M17 14h-4"/>',

  // 标尺、几何测量
  ruler: '<path d="M2.5 17.5L17.5 2.5l2 2-15 15zM6 7l2 2M9 10l2 2M12 13l2 2"/>',

  // 非小细胞肺癌 (NSCLC) / 胸部肿瘤靶向评估标志
  nsclc: '<path d="M10 2.5v15M10 7c-2.5-3-7-3-7 3.5 0 4.5 3 6.5 6 7M10 7c2.5-3 7-3 7 3.5 0 4.5-3 6.5-6 7"/><circle cx="13.5" cy="8" r="2.2" stroke-dasharray="1.5 1"/><path d="M13.5 5v1.5M13.5 9.5v1.5M10.5 8h1.5M15 8h1.5"/>',

  // 日历、排期
  calendar: '<rect x="3" y="4" width="14" height="13" rx="2"/><path d="M15 2v4M5 2v4M3 8h14"/><circle cx="7" cy="11.5" r="0.75" fill="currentColor"/><circle cx="10" cy="11.5" r="0.75" fill="currentColor"/><circle cx="13" cy="11.5" r="0.75" fill="currentColor"/><circle cx="7" cy="14" r="0.75" fill="currentColor"/><circle cx="10" cy="14" r="0.75" fill="currentColor"/>',

  // 邮件、邮箱
  mail: '<rect x="2.5" y="4" width="15" height="12" rx="2"/><path d="M2.5 6l7.5 5.5 7.5-5.5"/>',

  // 时间、时钟
  clock: '<circle cx="10" cy="10" r="7.5"/><path d="M10 5.5v4.5l3 2"/>',

  // 发送
  send: '<path d="M17.5 2.5L8.5 11.5M17.5 2.5l-6 15-3-6-6-3 15-6z"/>',

  // 标星、收藏
  star: '<polygon points="10 2 12.5 7.5 18.5 8.2 14 12.3 15.3 18.2 10 15.2 4.7 18.2 6 12.3 1.5 8.2 7.5 7.5 10 2"/>',

  // 废纸篓、删除
  trash: '<path d="M3.5 5.5h13M8 5.5V3.5h4v2M5.5 5.5l1 11h7l1-11M8.5 9v5M11.5 9v5"/>',

  // 往来回复
  reply: '<polyline points="7 14 2 9 7 4"/><path d="M18 17v-4a4 4 0 0 0-4-4H2"/>',

  // 往来转发
  forward: '<polyline points="13 14 18 9 13 4"/><path d="M2 17v-4a4 4 0 0 1 4-4h12"/>',

  // 邮件附件曲别针
  paperclip: '<path d="M15.5 8.5l-6.8 6.8a4 4 0 0 1-5.7-5.7l7.5-7.5a2.8 2.8 0 0 1 4 4l-7.5 7.5a1.4 1.4 0 0 1-2-2l6.5-6.5"/>',

  // 归档、档案箱
  archive: '<rect x="2.5" y="3.5" width="15" height="4" rx="1"/><path d="M4 7.5v9a1.5 1.5 0 0 0 1.5 1.5h9a1.5 1.5 0 0 0 1.5-1.5v-9M8.5 11.5h3"/>',

  // 智能助手、AI 机器人
  bot: '<rect x="3.5" y="6" width="13" height="10" rx="2.5"/><path d="M10 2v4M2 11h1.5M16.5 11H18"/><circle cx="7.5" cy="11" r="1" fill="currentColor"/><circle cx="12.5" cy="11" r="1" fill="currentColor"/>',
}

export interface IconOptions {
  size?: number
  class?: string
  style?: string
}

/**
 * 生成全站设计风格统一的内联 SVG 图标
 */
export function icon(name: IconName, opts?: IconOptions): string {
  const size = opts?.size ?? 14
  const cls = ['ui-icon', opts?.class].filter(Boolean).join(' ')
  const styleAttr = opts?.style ? ` style="${opts.style}"` : ''
  const pathContent = ICONS[name] || ICONS.info

  return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${styleAttr}>${pathContent}</svg>`
}
