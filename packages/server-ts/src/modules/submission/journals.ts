/**
 * #362: built-in oncology journal database for the recommend-journals API.
 * Curated tumor-journal list with impact factor, acceptance rate, review
 * time and matching keywords. Extended later by #356 (medical-research
 * data source).
 */
export interface JournalInfo {
  id: string
  name: string
  impactFactor: number
  acceptanceRate: number // percent
  reviewWeeks: number
  casZone: string // 中科院分区
  keywords: string[]
  description: string
}

export const JOURNAL_DATABASE: JournalInfo[] = [
  { id: 'lancet-oncol', name: 'Lancet Oncology', impactFactor: 51.1, acceptanceRate: 8, reviewWeeks: 6, casZone: '1区', keywords: ['lung', 'cancer', 'oncology', 'trial', 'immunotherapy'], description: '顶级肿瘤学期刊，适合重大临床突破' },
  { id: 'jco', name: 'Journal of Clinical Oncology', impactFactor: 45.3, acceptanceRate: 12, reviewWeeks: 8, casZone: '1区', keywords: ['cancer', 'clinical', 'trial', 'chemotherapy', 'survival'], description: '临床肿瘤学旗舰刊' },
  { id: 'jama-oncol', name: 'JAMA Oncology', impactFactor: 28.4, acceptanceRate: 15, reviewWeeks: 7, casZone: '1区', keywords: ['cancer', 'clinical', 'oncology', 'trial'], description: 'JAMA 子刊，临床研究影响力高' },
  { id: 'cancer-cell', name: 'Cancer Cell', impactFactor: 48.8, acceptanceRate: 10, reviewWeeks: 6, casZone: '1区', keywords: ['mechanism', 'molecular', 'drug', 'resistance'], description: '基础转化研究向' },
  { id: 'ann-oncol', name: 'Annals of Oncology', impactFactor: 50.5, acceptanceRate: 14, reviewWeeks: 5, casZone: '1区', keywords: ['cancer', 'immunotherapy', 'biomarker', 'esmo'], description: 'ESMO 官方期刊' },
  { id: 'nat-rev-clin', name: 'Nature Reviews Clinical Oncology', impactFactor: 81.1, acceptanceRate: 5, reviewWeeks: 10, casZone: '1区', keywords: ['review', 'perspective', 'landscape'], description: '顶级综述刊，仅邀稿为主' },
  { id: 'jto', name: 'Journal of Thoracic Oncology', impactFactor: 21.0, acceptanceRate: 20, reviewWeeks: 5, casZone: '1区', keywords: ['lung', 'thoracic', 'nsclc', 'egfr', 'immunotherapy'], description: '胸部肿瘤专科旗舰刊' },
  { id: 'ccr', name: 'Clinical Cancer Research', impactFactor: 11.5, acceptanceRate: 25, reviewWeeks: 6, casZone: '1区', keywords: ['cancer', 'biomarker', 'targeted', 'phase'], description: '转化研究向' },
  { id: 'cancer-res', name: 'Cancer Research', impactFactor: 11.2, acceptanceRate: 22, reviewWeeks: 7, casZone: '1区', keywords: ['cancer', 'molecular', 'mechanism', 'preclinical'], description: 'AACR 旗舰刊' },
  { id: 'jnci', name: 'JNCI: Journal of the National Cancer Institute', impactFactor: 10.0, acceptanceRate: 20, reviewWeeks: 8, casZone: '1区', keywords: ['cancer', 'epidemiology', 'outcome'], description: '肿瘤流行病学/预后向' },
  { id: 'npj-precis-oncol', name: 'npj Precision Oncology', impactFactor: 6.8, acceptanceRate: 28, reviewWeeks: 6, casZone: '1区', keywords: ['precision', 'genomic', 'mutation', 'biomarker'], description: '精准肿瘤学开放获取' },
  { id: 'lung-cancer', name: 'Lung Cancer', impactFactor: 5.3, acceptanceRate: 32, reviewWeeks: 6, casZone: '2区', keywords: ['lung', 'nsclc', 'sclc', 'egfr', 'chemotherapy'], description: '肺癌专科刊，接收率较高' },
  { id: 'ther-adv-med-oncol', name: 'Therapeutic Advances in Medical Oncology', impactFactor: 4.9, acceptanceRate: 35, reviewWeeks: 5, casZone: '2区', keywords: ['cancer', 'immunotherapy', 'targeted', 'retrospective'], description: '开放获取，接受回顾性研究' },
  { id: 'front-oncol', name: 'Frontiers in Oncology', impactFactor: 4.7, acceptanceRate: 30, reviewWeeks: 4, casZone: '2区', keywords: ['cancer', 'retrospective', 'real-world', 'immunotherapy'], description: '接受真实世界数据/回顾性研究' },
  { id: 'bmc-cancer', name: 'BMC Cancer', impactFactor: 3.4, acceptanceRate: 38, reviewWeeks: 5, casZone: '3区', keywords: ['cancer', 'retrospective', 'cohort'], description: '审稿快，接受率高' },
  { id: 'cancers', name: 'Cancers', impactFactor: 4.5, acceptanceRate: 45, reviewWeeks: 3, casZone: '2区', keywords: ['cancer', 'tumor', 'molecular'], description: 'MDPI 快速发表' },
  { id: 'tlcr', name: 'Translational Lung Cancer Research', impactFactor: 4.0, acceptanceRate: 36, reviewWeeks: 4, casZone: '2区', keywords: ['lung', 'nsclc', 'sclc', 'translational'], description: 'AME 出版肺癌转化刊' },
  { id: 'world-j-surg-oncol', name: 'World Journal of Surgical Oncology', impactFactor: 2.5, acceptanceRate: 45, reviewWeeks: 4, casZone: '3区', keywords: ['surgical', 'cancer', 'retrospective'], description: '外科肿瘤向，接受率高' },
]

/**
 * Keyword-based matching score: the paper's title/abstract keywords against
 * each journal's scope keywords. Title hits weigh double.
 */
export function matchJournals(title: string, abstract: string, limit = 5): Array<{ journal: JournalInfo; score: number; reason: string }> {
  const text = `${title} ${abstract}`.toLowerCase()
  const titleLower = title.toLowerCase()
  const tokens = new Set(
    text.split(/[^a-zA-Z0-9\u4e00-\u9fa5]+/)
      .filter((w) => w.length > 2)
      .map((w) => w.toLowerCase()),
  )

  const scored = JOURNAL_DATABASE.map((journal) => {
    let score = 0
    const hits: string[] = []
    for (const kw of journal.keywords) {
      if (titleLower.includes(kw)) {
        score += 3
        hits.push(kw)
      } else if (tokens.has(kw) || text.includes(kw)) {
        score += 1.5
        hits.push(kw)
      }
    }
    // Chinese keyword hints (期刊方向的中文别名)
    const zhHints: Record<string, string[]> = {
      'lung-cancer': ['肺', '肺癌', 'nsclc', '非小细胞'],
      'jto': ['肺', '肺癌', '胸'],
      'lancet-oncol': ['随机', '三期', '临床试验'],
      'front-oncol': ['回顾性', '真实世界'],
      'bmc-cancer': ['回顾性', '队列'],
    }
    for (const zh of zhHints[journal.id] || []) {
      if (text.includes(zh)) {
        score += 1.5
        hits.push(zh)
      }
    }
    return { journal, score, hits }
  })

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ journal, score, hits }) => ({
      journal,
      score,
      reason: hits.length > 0
        ? `摘要包含 ${hits.slice(0, 4).join(' / ')}，与期刊 scope（${journal.description}）匹配`
        : journal.description,
    }))
}
