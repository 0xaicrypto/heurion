import { describe, expect, it } from 'vitest'
import { matchCriteria, parseCriteria, type PatientRow, type LabRow } from '../src/tenancy/patients.ts'

describe('科研队列高级筛选与相对时间轴（Track B）', () => {
  const p1: PatientRow = {
    id: 'p1',
    code: 'P001',
    sex: 'M',
    birth_year: 1980,
    name: null,
    status: 'active',
    tags: ['糖尿病', '1型糖尿病'],
    created_by: 'u1',
    created_at: '2024-01-01',
    updated_at: '2024-01-01',
  }

  const p2: PatientRow = {
    id: 'p2',
    code: 'P002',
    sex: 'F',
    birth_year: 1985,
    name: null,
    status: 'active',
    tags: ['糖尿病', '2型糖尿病', '高血压'],
    created_by: 'u1',
    created_at: '2024-01-01',
    updated_at: '2024-01-01',
  }

  const labsP2 = [
    {
      id: 'l1',
      patient_id: 'p2',
      record_id: 'r1',
      test_name: '丙氨酸氨基转移酶',
      test_key: 'alt',
      value_num: 80,
      value_text: null,
      unit: 'U/L',
      std_value: 80,
      std_unit: 'U/L',
      std_ref_low: 9,
      std_ref_high: 50,
      ref_low: 9,
      ref_high: 50,
      ref_text: '9-50',
      flag: 'H' as const,
      collected_on: '2024-01-10',
      collected_at: null,
      replaces: null,
      locator: null,
      source: 'extracted' as const,
      status: 'confirmed' as const,
      converted: false,
      unknown_unit: false,
      created_by: 'u1',
      created_at: '2024-01-10',
      confirmed_by: 'u1',
      confirmed_at: '2024-01-10',
    },
    {
      id: 'l2',
      patient_id: 'p2',
      record_id: 'r2',
      test_name: '丙氨酸氨基转移酶',
      test_key: 'alt',
      value_num: 40,
      value_text: null,
      unit: 'U/L',
      std_value: 40,
      std_unit: 'U/L',
      std_ref_low: 9,
      std_ref_high: 50,
      ref_low: 9,
      ref_high: 50,
      ref_text: '9-50',
      flag: null,
      collected_on: '2024-02-10',
      collected_at: null,
      replaces: null,
      locator: null,
      source: 'extracted' as const,
      status: 'confirmed' as const,
      converted: false,
      unknown_unit: false,
      created_by: 'u1',
      created_at: '2024-02-10',
      confirmed_by: 'u1',
      confirmed_at: '2024-02-10',
    },
  ] as LabRow[]

  it('tags_exclude: 复合排除逻辑（包含糖尿病且排除1型）', () => {
    const cr = parseCriteria({
      tags_any: ['糖尿病'],
      tags_exclude: ['1型'],
    })

    // p1 包含1型糖尿病，应被排除
    expect(matchCriteria(cr, p1, [], 2024)).toBeNull()

    // p2 包含2型糖尿病，符合条件
    const m2 = matchCriteria(cr, p2, [], 2024)
    expect(m2).toBeTruthy()
    expect(m2).toContain('标签「糖尿病」')
  })

  it('lab_changes: 按化验指标动态演变趋势筛选（ALT 下降幅度 >= 30%）', () => {
    // 基线 80 -> 最近 40，变化百分比为 -50%
    const crDrop = parseCriteria({
      lab_changes: [
        {
          test: 'ALT',
          change_type: 'pct',
          op: '<=',
          value: -30,
        },
      ],
    })

    const m = matchCriteria(crDrop, p2, labsP2, 2024)
    expect(m).toBeTruthy()
    expect(m![0]).toContain('丙氨酸氨基转移酶 变化 -50.0%')

    // 如果要求变化 >= 0（未下降），则应失配
    const crRise = parseCriteria({
      lab_changes: [
        {
          test: 'ALT',
          change_type: 'diff',
          op: '>=',
          value: 0,
        },
      ],
    })
    expect(matchCriteria(crRise, p2, labsP2, 2024)).toBeNull()
  })

  it('relative_days: 生成宽表与长表数据集时支持以入组日为 Day 0 的相对时间轴', async () => {
    const { mkdtempSync, copyFileSync, readFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { Store } = await import('../src/store/db.ts')
    const { TenantService } = await import('../src/auth/tenants.ts')
    const { TenantKeys, kekFrom } = await import('../src/tenancy/keys.ts')
    const { PatientService } = await import('../src/tenancy/patients.ts')
    const { DatasetService, parseCsv } = await import('../src/datasets/service.ts')
    const { StudyService } = await import('../src/research/service.ts')
    const { CohortService } = await import('../src/research/cohort.ts')

    const store = new Store(':memory:')
    const tenants = new TenantService(store, { devMode: false })
    const keys = new TenantKeys(store, kekFrom({ secret: 'test-secret' }))
    const patients = new PatientService(mkdtempSync(join(tmpdir(), 'co-adv-pt-')), tenants, keys, store)
    const ingest = async (_owner: string, src: string) => {
      const dir = mkdtempSync(join(tmpdir(), 'co-adv-ing-'))
      copyFileSync(src, join(dir, 'data.csv'))
      const recs = parseCsv(readFileSync(src, 'utf8')) as string[][]
      const header = recs[0] ?? []
      return {
        csv: join(dir, 'data.csv'), cleanup: () => {},
        profile: { ok: true as const, rows: recs.length - 1, truncated: false, columns: header.map(name => ({ name, type: 'text' as const, missing: 0, unique: 1 })) },
      }
    }
    const datasets = new DatasetService(store, mkdtempSync(join(tmpdir(), 'co-adv-ds-')), ingest)
    const studies = new StudyService(store, datasets)
    const cohort = new CohortService(studies, patients, datasets)

    const hosp = store.createTenant({ name: '测试医院', kind: 'org' })
    const user = store.createUser({ username: 'doc1', display_name: '医生', password_hash: 'x', tenant: { id: hosp.id, role: 'member' } }).id
    const actor = { userId: user, via: 'user' as const }
    const study = studies.create(user, { title: '前瞻队列研究', design: 'prospective_cohort' })

    const pt = patients.create(actor, { sex: 'M', birth_year: 1990, tags: ['研究入组'] })
    const f1 = patients.addFile(actor, pt.id, { name: '基线化验.pdf', mime: 'application/pdf', bytes: Uint8Array.from([1, 2, 3]), report_date: '2024-03-01' })
    patients.addRecordLab(actor, pt.id, f1.record.id, { test_name: '肌酐', value: 90, unit: 'µmol/L' })
    patients.resolveRecord(actor, pt.id, f1.record.id, { accept: true })

    const f2 = patients.addFile(actor, pt.id, { name: '随访化验.pdf', mime: 'application/pdf', bytes: Uint8Array.from([4, 5, 6]), report_date: '2024-03-15' })
    patients.addRecordLab(actor, pt.id, f2.record.id, { test_name: '肌酐', value: 110, unit: 'µmol/L' })
    patients.resolveRecord(actor, pt.id, f2.record.id, { accept: true })

    // 入组患者
    cohort.enroll(actor, study.id, { patient_ids: [pt.id] })

    // 生成带 relative_days 的宽表
    const resWide = await cohort.dataset(actor, study.id, { shape: 'wide', relative_days: true })
    const prevWide = datasets.preview(user, resWide.dataset.id)
    expect(prevWide.header).toContain('creatinine_baseline_day_rel')
    expect(prevWide.header).toContain('creatinine_latest_day_rel')
    expect(resWide.dataset.labels.creatinine_baseline_day_rel).toBe('肌酐 基线相对入组天数')

    // 生成带 relative_days 的长表
    const resLong = await cohort.dataset(actor, study.id, { shape: 'long', relative_days: true })
    const prevLong = datasets.preview(user, resLong.dataset.id)
    expect(prevLong.header).toContain('day_rel')
    expect(resLong.dataset.labels.day_rel).toBe('相对入组天数')
  })
})

