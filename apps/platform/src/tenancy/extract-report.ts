import type { Complete } from '../memory/evolve.ts'

/**
 * 患者报告的自动提取（第二期）：报告文字 → 打码 → 模型提取类型、报告日期、化验项 → 逐个数值回原文核对 → 进「待确认」由医生审核。
 * - 发给外部模型之前去掉姓名、证件号、电话、住院号 / 病历号、地址、出生日期（机构关闭「交给外部模型」时不提取，改手工录入）。
 * - 报告日期取报告上的日期（采样 / 报告时间），不是上传时间。
 * - 模型给出的每个数值都必须能在那一页原文里找到，找不到的标 verified=false，界面里提示医生重点核对。
 */

export interface ExtractedLab {
  test_name: string; value: string; unit: string | null; ref_low: number | null; ref_high: number | null; ref_text: string | null
  page: number; verified: boolean
}
export interface ExtractedReport {
  kind: 'lab_report' | 'discharge' | 'pathology' | 'imaging' | 'other'
  title: string
  report_date: string | null
  labs: ExtractedLab[]
}

const REDACTIONS: Array<[RegExp, string]> = [
  [/(姓\s*名|患者姓名|病人姓名)\s*[:：]?\s*[一-龥·]{1,6}/g, '$1：【姓名】'],
  [/(?<![0-9])\d{17}[\dXx](?![0-9A-Za-z])/g, '【证件号】'],
  [/(?<!\d)(\+?86[- ]?)?1[3-9]\d{9}(?!\d)/g, '【电话】'],
  [/(住院号|病历号|病案号|门诊号|就诊号|登记号|床\s*号|ID号|患者ID|条码号|标本号|医保号|卡号)\s*[:：#]?\s*[A-Za-z0-9-]{2,}/gi, '$1：【编号】'],
  [/(家庭住址|住址|地址)\s*[:：]?\s*\S{2,40}/g, '$1：【地址】'],
  [/(出生日期|出生年月|生日)\s*[:：]?\s*\d{4}[-/年.]\d{1,2}([-/月.]\d{1,2}日?)?/g, '$1：【出生日期】'],
  [/(电话|联系电话|手机)\s*[:：]?\s*[\d-]{7,}/g, '$1：【电话】'],
]

const NAME_FIELD = /(?:姓\s*名|患者姓名|病人姓名|受检者|患\s*者)\s*[:：]\s*([\u4e00-\u9fa5·]{2,6})/g

/** 报告「姓名：」字段里的名字（之后在全文与模型输出里统一替换——名字也会出现在正文、签名、标题里）。 */
export function namesIn(text: string): string[] {
  return [...new Set([...text.matchAll(NAME_FIELD)].map(m => m[1]!).filter(n => n.length >= 2))]
}

/** 发给外部模型前打码（身份信息换成占位符；化验数值、日期、科室不动）。names：已知的患者姓名，在全文任何位置都替换。 */
export function redact(text: string, names: string[] = namesIn(text)): string {
  let out = text
  for (const n of names) out = out.split(n).join('【姓名】')
  for (const [re, to] of REDACTIONS) out = out.replace(re, to)
  return out
}

const SYSTEM = `你在从医学检验 / 检查报告里提取结构化数据。输入是报告各页文字（已打码，【】里是隐去的身份信息）。
只输出 JSON：{"kind":"lab_report|discharge|pathology|imaging|other","title":"…","report_date":"YYYY-MM-DD 或 null","labs":[{"test_name":"…","value":"…","unit":"…或 null","ref_low":数字或 null,"ref_high":数字或 null,"ref_text":"参考范围原文或 null","page":页码}]}
规则：
- kind：化验单 / 检验报告 = lab_report；出院小结 / 出院记录 = discharge；病理 = pathology；CT / MRI / 超声 / X 线等 = imaging；其他 = other。
- title：简短的报告名，例如「肝功能」「血常规」「出院小结」，不要写任何姓名。
- report_date：报告上的采样 / 检验 / 报告日期（优先采样日期），不是今天；没有就 null。
- labs：只在 kind=lab_report 或报告里明确列出检验结果时提取；每一项照抄报告上的项目名与数值（value 原样抄写，含 < > 等符号），不要换算单位、不要计算、不要补全报告里没有的项目。
- 参考范围写成「3.5-5.5」这类时拆成 ref_low / ref_high；只有上限（如「<40」）时 ref_low 为 null；同时把原文写进 ref_text。
- 看不清、不确定的项目不要提取。`

function parseJson(text: string): Record<string, unknown> {
  const m = /\{[\s\S]*\}/.exec(text.replace(/```(?:json)?/g, ''))
  if (!m) throw new Error('模型没有返回 JSON')
  return JSON.parse(m[0]) as Record<string, unknown>
}

const num = (x: unknown) => (x === null || x === undefined || x === '' || !Number.isFinite(Number(x)) ? null : Number(x))
const KINDS = new Set(['lab_report', 'discharge', 'pathology', 'imaging', 'other'])

/** 数值能否在原文那一页（或任一页）里找到（防止模型编造或读错行）。 */
function foundIn(value: string, pages: string[], page: number): boolean {
  const v = value.replace(/\s+/g, '')
  if (!v) return false
  const hay = (s: string) => s.replace(/\s+/g, '')
  const target = pages[page - 1]
  const re = new RegExp(`(?<![0-9.])${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![0-9])`)
  return Boolean((target && re.test(hay(target))) || pages.some(p => re.test(hay(p))))
}

export async function extractReport(pages: string[], complete: Complete): Promise<ExtractedReport> {
  const names = namesIn(pages.join('\n'))
  const input = pages.map((p, i) => `【第 ${i + 1} 页】\n${redact(p, names).slice(0, 6000)}`).join('\n\n').slice(0, 24000)
  const raw = parseJson(await complete(SYSTEM, input))
  const kind = typeof raw.kind === 'string' && KINDS.has(raw.kind) ? raw.kind as ExtractedReport['kind'] : 'other'
  const date = typeof raw.report_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.report_date) ? raw.report_date : null
  const labs = (Array.isArray(raw.labs) ? raw.labs : []).slice(0, 200).flatMap((x): ExtractedLab[] => {
    if (!x || typeof x !== 'object') return []
    const l = x as Record<string, unknown>
    const name = typeof l.test_name === 'string' ? l.test_name.trim().slice(0, 60) : ''
    const value = l.value === null || l.value === undefined ? '' : String(l.value).trim().slice(0, 40)
    if (!name || !value) return []
    const page = Math.min(Math.max(1, Math.round(Number(l.page) || 1)), Math.max(1, pages.length))
    return [{
      test_name: name, value, unit: typeof l.unit === 'string' && l.unit.trim() ? l.unit.trim().slice(0, 20) : null,
      ref_low: num(l.ref_low), ref_high: num(l.ref_high), ref_text: typeof l.ref_text === 'string' ? l.ref_text.slice(0, 60) : null,
      page, verified: foundIn(value, pages, page),
    }]
  })
  // 标题明文存储：再过一遍打码（模型若从别处抄了名字也会被换掉）
  const title = typeof raw.title === 'string' ? redact(raw.title, names).trim().slice(0, 60) : ''
  return { kind, title: title || ({ lab_report: '化验报告', discharge: '出院小结', pathology: '病理报告', imaging: '影像报告', other: '报告' })[kind], report_date: date, labs }
}
