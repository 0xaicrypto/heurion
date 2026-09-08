import { describe, expect, it } from 'vitest'
import { getJournalRepository, isSnapshotStale, resetJournalRepository } from '../../src/modules/submission/journal-repository.js'
import { CAS_WARNING_LIST } from '../../src/modules/submission/journal-warning-list.js'

/**
 * #849 — JournalRepository + 数据新鲜度架构。
 * 验收:每条 IF/分区可回查 asOf 与来源;预警刊 listByScope 可见但 warnings 非空;
 * 18 本存量肿瘤刊迁移后数据零丢失。
 */

describe('JournalRepository (#849)', () => {
  it('seed 规模 ~200 本(≥190)且 id 唯一', () => {
    resetJournalRepository()
    const repo = getJournalRepository()
    expect(repo.count).toBeGreaterThanOrEqual(190)
    const ids = repo.listAll().map((j) => j.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('原 18 本肿瘤刊迁移零丢失(IF/接受率/审稿周/分区/关键词/描述逐字段原样)', () => {
    resetJournalRepository()
    const repo = getJournalRepository()
    const legacy: Array<[string, { if_: number; acc: number; wk: number; cas: string; keywords: string[]; desc: string }]> = [
      ['lancet-oncol', { if_: 51.1, acc: 8, wk: 6, cas: '1区', keywords: ['lung', 'cancer', 'oncology', 'trial', 'immunotherapy'], desc: '顶级肿瘤学期刊，适合重大临床突破' }],
      ['jco', { if_: 45.3, acc: 12, wk: 8, cas: '1区', keywords: ['cancer', 'clinical', 'trial', 'chemotherapy', 'survival'], desc: '临床肿瘤学旗舰刊' }],
      ['jama-oncol', { if_: 28.4, acc: 15, wk: 7, cas: '1区', keywords: ['cancer', 'clinical', 'oncology', 'trial'], desc: 'JAMA 子刊，临床研究影响力高' }],
      ['cancer-cell', { if_: 48.8, acc: 10, wk: 6, cas: '1区', keywords: ['mechanism', 'molecular', 'drug', 'resistance'], desc: '基础转化研究向' }],
      ['ann-oncol', { if_: 50.5, acc: 14, wk: 5, cas: '1区', keywords: ['cancer', 'immunotherapy', 'biomarker', 'esmo'], desc: 'ESMO 官方期刊' }],
      ['nat-rev-clin', { if_: 81.1, acc: 5, wk: 10, cas: '1区', keywords: ['review', 'perspective', 'landscape'], desc: '顶级综述刊，仅邀稿为主' }],
      ['jto', { if_: 21.0, acc: 20, wk: 5, cas: '1区', keywords: ['lung', 'thoracic', 'nsclc', 'egfr', 'immunotherapy'], desc: '胸部肿瘤专科旗舰刊' }],
      ['ccr', { if_: 11.5, acc: 25, wk: 6, cas: '1区', keywords: ['cancer', 'biomarker', 'targeted', 'phase'], desc: '转化研究向' }],
      ['cancer-res', { if_: 11.2, acc: 22, wk: 7, cas: '1区', keywords: ['cancer', 'molecular', 'mechanism', 'preclinical'], desc: 'AACR 旗舰刊' }],
      ['jnci', { if_: 10.0, acc: 20, wk: 8, cas: '1区', keywords: ['cancer', 'epidemiology', 'outcome'], desc: '肿瘤流行病学/预后向' }],
      ['npj-precis-oncol', { if_: 6.8, acc: 28, wk: 6, cas: '1区', keywords: ['precision', 'genomic', 'mutation', 'biomarker'], desc: '精准肿瘤学开放获取' }],
      ['lung-cancer', { if_: 5.3, acc: 32, wk: 6, cas: '2区', keywords: ['lung', 'nsclc', 'sclc', 'egfr', 'chemotherapy'], desc: '肺癌专科刊，接收率较高' }],
      ['ther-adv-med-oncol', { if_: 4.9, acc: 35, wk: 5, cas: '2区', keywords: ['cancer', 'immunotherapy', 'targeted', 'retrospective'], desc: '开放获取，接受回顾性研究' }],
      ['front-oncol', { if_: 4.7, acc: 30, wk: 4, cas: '2区', keywords: ['cancer', 'retrospective', 'real-world', 'immunotherapy'], desc: '接受真实世界数据/回顾性研究' }],
      ['bmc-cancer', { if_: 3.4, acc: 38, wk: 5, cas: '3区', keywords: ['cancer', 'retrospective', 'cohort'], desc: '审稿快，接受率高' }],
      ['cancers', { if_: 4.5, acc: 45, wk: 3, cas: '2区', keywords: ['cancer', 'tumor', 'molecular'], desc: 'MDPI 快速发表' }],
      ['tlcr', { if_: 4.0, acc: 36, wk: 4, cas: '2区', keywords: ['lung', 'nsclc', 'sclc', 'translational'], desc: 'AME 出版肺癌转化刊' }],
      ['world-j-surg-oncol', { if_: 2.5, acc: 45, wk: 4, cas: '3区', keywords: ['surgical', 'cancer', 'retrospective'], desc: '外科肿瘤向，接受率高' }],
    ]
    for (const [id, want] of legacy) {
      const j = repo.get(id)
      expect(j, id).not.toBeNull()
      expect(j!.metrics.impactFactor?.value).toBe(want.if_)
      expect(j!.metrics.acceptanceRate?.value).toBe(want.acc)
      expect(j!.metrics.reviewWeeksMedian?.value).toBe(want.wk)
      expect(j!.metrics.casZone?.value).toBe(want.cas)
      expect(j!.keywords).toEqual(want.keywords)
      expect(j!.description).toBe(want.desc)
    }
  })

  it('每条 IF/分区数据可回查 asOf 与来源(D2)', () => {
    resetJournalRepository()
    const repo = getJournalRepository()
    for (const j of repo.listAll()) {
      if (j.metrics.impactFactor) {
        expect(j.metrics.impactFactor.asOf).toMatch(/^\d{4}-\d{2}$/)
        expect(j.metrics.impactFactor.source).toBe('jcr_snapshot')
      }
      if (j.metrics.casZone) {
        expect(j.metrics.casZone.asOf).toMatch(/^\d{4}-\d{2}$/)
        expect(j.metrics.casZone.source).toBe('cas_snapshot')
      }
      expect(j.logo.monogram.length).toBeGreaterThan(0)
      expect(j.logo.color).toMatch(/^#[0-9a-f]{6}$/)
      expect(j.freshness.seed).toBe(true)
    }
  })

  it('预警名单期刊 listByScope 可见但 warnings 非空(D5)', () => {
    resetJournalRepository()
    const repo = getJournalRepository()
    const warned = repo.listWarned()
    expect(warned.length).toBeGreaterThanOrEqual(CAS_WARNING_LIST.entries.length)
    const jOnc = repo.get('j-oncol-hindawi')
    expect(jOnc!.warnings.length).toBeGreaterThan(0)
    expect(jOnc!.warnings[0].kind).toBe('cas_warning_list')
    expect(jOnc!.scope).toContain('oncology')
    expect(repo.listByScope('oncology').some((j) => j.id === 'j-oncol-hindawi')).toBe(true)
    // 名单匹配按归一化刊名 — 大小写/标点不敏感
    expect(repo.listByIssn('0000-0000')).toBeNull()
  })

  it('get/search/listByScope/中文刊目录', () => {
    resetJournalRepository()
    const repo = getJournalRepository()
    expect(repo.get('nejm')!.metrics.impactFactor!.value).toBe(158.4)
    expect(repo.search('lancet oncology').map((j) => j.id)).toContain('lancet-oncol')
    expect(repo.search('中华心血管病').map((j) => j.id)).toContain('zh-xinxueguan')
    expect(repo.listByScope('cardiology').map((j) => j.id)).toContain('circulation')
    const zh = repo.listByScope('chinese')
    expect(zh.length).toBeGreaterThanOrEqual(25)
    for (const j of zh) expect(j.zhName).toBeTruthy()
  })

  it('快照超期 >18 个月 → stale 警示位', () => {
    expect(isSnapshotStale('2024-01-01', new Date('2026-09-08T00:00:00Z'))).toBe(true)
    expect(isSnapshotStale('2025-06-01', new Date('2026-09-08T00:00:00Z'))).toBe(false)
    expect(isSnapshotStale('bogus', new Date('2026-09-08T00:00:00Z'))).toBe(false)
  })
})
