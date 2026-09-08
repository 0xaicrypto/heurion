/**
 * #850/D3/D4 — 三档梯度推荐规则引擎。
 * 规则加权:scope × articleType 分布 × 影响力 × 速度 × 接受率 × 费用,
 * 权重由 SelectionProfile.priority 驱动(impact/speed/acceptance 三预设)。
 * 确定性:同一 profile 两次推荐结果可复现(无随机、稳定排序 tie-break)。
 * D5:预警期刊任何档位不得入选,仅红线区展示。
 */
import type {
  BreakdownRow, JournalRecord, Recommendation, ScoreDimension,
  SelectionPriority, SelectionProfile, TieredRecommendation,
} from './journal-types.js'
import { getJournalRepository } from './journal-repository.js'

/** 优先级 → 维度权重(每列和 = 1)。 */
const WEIGHTS: Record<SelectionPriority, Record<Exclude<ScoreDimension, never>, number>> = {
  impact: { scope: 0.35, articleType: 0.20, impact: 0.25, speed: 0.05, acceptance: 0.10, cost: 0.05 },
  speed: { scope: 0.35, articleType: 0.15, impact: 0.05, speed: 0.25, acceptance: 0.15, cost: 0.05 },
  acceptance: { scope: 0.35, articleType: 0.15, impact: 0.05, speed: 0.10, acceptance: 0.20, cost: 0.15 },
}

const TYPE_LABELS: Record<string, string> = {
  rct: '随机对照试验',
  cohort: '队列研究',
  case_report: '病例报告',
  review: '综述',
  meta: 'Meta 分析',
  real_world: '真实世界/回顾性研究',
}

/** scope 标签 → 中英文匹配提示词(中文摘要也能命中英文刊)。 */
const SCOPE_HINTS: Record<string, string[]> = {
  oncology: ['oncology', 'cancer', 'tumor', 'tumour', 'carcinoma', '肿瘤', '癌'],
  cardiology: ['cardiology', 'cardiac', 'heart', 'coronary', '心血管', '心脏', '心肌', '冠心病'],
  respiratory: ['respiratory', 'pulmonary', 'lung', 'copd', 'asthma', '呼吸', '肺', '哮喘', '慢阻肺'],
  gastro: ['gastro', 'colon', 'gastric', 'intestinal', '消化', '胃肠', '结肠'],
  hepatology: ['hepatology', 'liver', 'hepatic', 'cirrhosis', '肝', '肝硬化'],
  endocrine: ['endocrine', 'diabetes', 'thyroid', 'obesity', '内分泌', '糖尿病', '甲状腺', '肥胖'],
  nephrology: ['nephrology', 'kidney', 'renal', 'dialysis', '肾', '透析'],
  neurology: ['neurology', 'stroke', 'epilepsy', 'brain', '神经', '脑', '卒中', '癫痫', '帕金森'],
  psychiatry: ['psychiatry', 'depression', 'mental', '精神', '抑郁', '焦虑'],
  infectious: ['infection', 'infectious', 'sepsis', 'antibiotic', '感染', '抗菌'],
  hematology: ['hematology', 'haematology', 'leukemia', 'anemia', '血液', '白血病', '贫血'],
  surgery: ['surgery', 'surgical', 'operative', '外科', '手术'],
  anesthesia: ['anesthesia', 'anaesthesia', 'anesthetic', '麻醉'],
  'critical-care': ['critical care', 'icu', 'sepsis', 'intensive', '重症'],
  obgyn: ['obstetric', 'gynecolog', 'pregnancy', '妇产科', '妊娠', '妇科'],
  pediatrics: ['pediatric', 'paediatric', 'children', '儿童', '小儿'],
  geriatrics: ['geriatric', 'elderly', 'aging', '老年'],
  radiology: ['radiology', 'imaging', 'radiomics', '影像', '放射'],
  pathology: ['pathology', 'histology', '病理'],
  laboratory: ['laboratory', 'assay', '检验'],
  'public-health': ['public health', 'epidemic', 'surveillance', '公共卫生'],
  epidemiology: ['epidemiology', 'cohort', '流行病', '队列'],
  nursing: ['nursing', '护理'],
  pharmacology: ['pharmacology', '药'],
  'primary-care': ['primary care', 'general practice', '全科', '基层'],
  dermatology: ['dermatology', 'skin', '皮肤'],
  ophthalmology: ['ophthalmology', 'eye', 'retina', '眼'],
  urology: ['urology', 'prostate', '泌尿', '前列腺'],
  orthopedics: ['orthopedic', 'orthopaedic', 'fracture', '骨'],
  rheumatology: ['rheumatoid', 'lupus', 'arthritis', '风湿'],
  immunology: ['immunology', 'allergy', '免疫', '过敏'],
  transplant: ['transplant', 'graft', '移植'],
  nutrition: ['nutrition', 'diet', '营养'],
}

interface ScopeMatch {
  score: number
  evidence: string
}

/** scope 维度:关键词命中(标题×3/摘要×1.5)+ scope 提示词命中(标题×2/摘要×1)。 */
function matchScope(journal: JournalRecord, profile: SelectionProfile): ScopeMatch | null {
  const title = profile.title.toLowerCase()
  const abstract = (profile.abstract || '').toLowerCase()
  let points = 0
  const titleHits: string[] = []
  const abstractHits: string[] = []

  const hit = (kw: string): 'title' | 'abstract' | null => {
    const k = kw.toLowerCase()
    // 拉丁词最短 2 字符;CJK 单字(肺/癌/肝)即有意义,放行
    if (k.length < 2 && !/[\u4e00-\u9fa5]/.test(k)) return null
    if (title.includes(k)) return 'title'
    if (abstract.includes(k)) return 'abstract'
    return null
  }
  for (const kw of journal.keywords) {
    const where = hit(kw)
    if (where === 'title') { points += 3; titleHits.push(kw) }
    else if (where === 'abstract') { points += 1.5; abstractHits.push(kw) }
  }
  for (const tag of journal.scope) {
    for (const hint of SCOPE_HINTS[tag] ?? []) {
      if (titleHits.includes(hint) || abstractHits.includes(hint)) continue
      const where = hit(hint)
      if (where === 'title') { points += 2; titleHits.push(hint) }
      else if (where === 'abstract') { points += 1; abstractHits.push(hint) }
    }
  }
  if (points === 0) return null
  const score = Math.min(100, Math.round(points * 12))
  const parts: string[] = []
  if (titleHits.length > 0) parts.push(`标题命中 ${titleHits.slice(0, 4).join(' / ')}`)
  if (abstractHits.length > 0) parts.push(`摘要命中 ${abstractHits.slice(0, 4).join(' / ')}`)
  return { score, evidence: parts.join(';') }
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

function scoreJournal(journal: JournalRecord, profile: SelectionProfile, priority: SelectionPriority) {
  const weights = { ...WEIGHTS[priority] }
  if (profile.selfPayOa) weights.cost = 0 // 自费 OA 意愿开启 → 费用维度退出权重

  const dims = new Map<ScoreDimension, { score: number; evidence?: string }>()

  const scope = matchScope(journal, profile)
  dims.set('scope', scope ? { score: scope.score, evidence: scope.evidence } : { score: 0 })

  // articleType:profile 未声明 → 中性 50 无证据行;该刊历史分布未知 → 中性 50。
  if (profile.articleType) {
    if (journal.articleTypes.includes(profile.articleType)) {
      dims.set('articleType', {
        score: 100,
        evidence: `研究类型 ${TYPE_LABELS[profile.articleType] ?? profile.articleType} — 该刊历史接收含此类(内置快照;OpenAlex 接线后为实时占比)`,
      })
    } else if (journal.articleTypes.length > 0) {
      dims.set('articleType', {
        score: 40,
        evidence: `研究类型 ${TYPE_LABELS[profile.articleType] ?? profile.articleType} — 该刊历史接收以 ${journal.articleTypes.map((t) => TYPE_LABELS[t] ?? t).join('/')} 为主(内置快照)`,
      })
    } else {
      dims.set('articleType', { score: 50 })
    }
  } else {
    dims.set('articleType', { score: 50 })
  }

  const ifMetric = journal.metrics.impactFactor
  dims.set('impact', ifMetric
    ? { score: clamp(Math.round((Math.log10(ifMetric.value + 1) / Math.log10(201)) * 100), 5, 100), evidence: `IF ${ifMetric.value}（${ifMetric.source},截至 ${ifMetric.asOf}）` }
    : { score: 50 })

  const wk = journal.metrics.reviewWeeksMedian
  dims.set('speed', wk
    ? { score: clamp(Math.round(100 - (wk.value - 3) * 6), 10, 100), evidence: `一审中位约 ${wk.value} 周(估计值)` }
    : { score: 50 })

  const acc = journal.metrics.acceptanceRate
  dims.set('acceptance', acc
    ? { score: clamp(Math.round(acc.value * 2), 5, 100), evidence: `接受率约 ${acc.value}%（${acc.source},截至 ${acc.asOf}）` }
    : { score: 50 })

  const apc = journal.metrics.apc
  if (profile.selfPayOa) {
    dims.set('cost', { score: 50 })
  } else if (apc) {
    dims.set('cost', {
      score: clamp(Math.round(100 - (apc.value - 500) / 40), 5, 100),
      evidence: `APC ≈ ${apc.currency === 'USD' ? '$' : `${apc.currency} `}${apc.value.toLocaleString('en-US')}（${apc.source},截至 ${apc.asOf}）`,
    })
  } else if (journal.oa) {
    dims.set('cost', { score: 50, evidence: 'OA 刊,APC 未收录(DOAJ 待补)' })
  } else {
    dims.set('cost', { score: 100, evidence: '订阅刊,无强制 APC' })
  }

  let total = 0
  let weightSum = 0
  for (const [dim, { score }] of dims) {
    total += weights[dim] * score
    weightSum += weights[dim]
  }
  const totalScore = weightSum > 0 ? Math.round((total / weightSum) * 10) / 10 : 0

  // D4:breakdown 只输出有证据的维度,按权重 × 分数降序。
  const breakdown: BreakdownRow[] = [...dims.entries()]
    .filter(([dim, { evidence }]) => dim === 'scope' || (evidence !== undefined && evidence.length > 0))
    .map(([dimension, { score, evidence }]) => ({ dimension, score, evidence: evidence ?? '' }))
    .sort((a, b) => weights[b.dimension] * b.score - weights[a.dimension] * a.score)

  return { totalScore, breakdown, scopeScore: scope?.score ?? 0 }
}

/** 主入口:profile → 三档梯度 + 红线区(D5:预警刊永不入档)。 */
export function recommendTiers(profile: SelectionProfile): TieredRecommendation {
  const repo = getJournalRepository()
  const priority: SelectionPriority = profile.priority ?? 'impact'
  const lang = profile.language

  // 语言过滤:中文稿只推中文刊,英文稿不推中文刊(未声明 → 全量)。
  const pool = repo.listAll().filter((j) => {
    const isZh = j.scope.includes('chinese')
    if (lang === 'zh') return isZh
    if (lang === 'en') return !isZh
    return true
  })

  const scored = pool
    .map((journal) => ({ journal, ...scoreJournal(journal, profile, priority) }))
    .sort((a, b) => b.totalScore - a.totalScore || a.journal.id.localeCompare(b.journal.id))

  // 只有 scope 有真实命中证据的刊才可入档(无证据不推荐);预警刊只进红线区。
  const eligible = scored.filter((s) => s.scopeScore > 0 && s.journal.warnings.length === 0)
  const redline = scored
    .filter((s) => s.journal.warnings.length > 0)
    .map(({ journal }) => ({ journal }))

  // 匹配档锚:总分离且接受率 ≥ 25%(现实可投)的最高排名刊;无接受率数据 → 首位。
  const anchorIdx = eligible.findIndex((s) => {
    const acc = s.journal.metrics.acceptanceRate
    return acc ? acc.value >= 25 : false
  })
  const anchor = anchorIdx >= 0 ? anchorIdx : 0

  const reach = eligible.slice(Math.max(0, anchor - 3), anchor).map(toRec('reach'))
  const match = eligible.slice(anchor, anchor + 3).map(toRec('match'))
  const usedIds = new Set([...reach, ...match].map((r) => r.journal.id))
  const safetyPool = eligible
    .filter((s) => !usedIds.has(s.journal.id))
    .sort((a, b) => {
      const accA = a.journal.metrics.acceptanceRate?.value ?? 0
      const accB = b.journal.metrics.acceptanceRate?.value ?? 0
      return accB - accA || b.totalScore - a.totalScore || a.journal.id.localeCompare(b.journal.id)
    })
  const safety = safetyPool.slice(0, 3).map(toRec('safety'))

  return {
    engine: 'selection-v2',
    profileEcho: { priority, articleType: profile.articleType, selfPayOa: !!profile.selfPayOa },
    tiers: { reach, match, safety },
    redline,
  }

  function toRec(tier: Recommendation['tier']) {
    return ({ journal, totalScore, breakdown }: { journal: JournalRecord; totalScore: number; breakdown: BreakdownRow[] }): Recommendation =>
      ({ journal, tier, totalScore, breakdown })
  }
}
