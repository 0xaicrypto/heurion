import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TenantService } from '../src/auth/tenants.ts'
import { Store } from '../src/store/db.ts'
import { kekFrom, TenantKeys } from '../src/tenancy/keys.ts'
import { PatientService, type Actor } from '../src/tenancy/patients.ts'

function env() {
  const store = new Store(':memory:')
  const tenants = new TenantService(store, { devMode: false })
  const keys = new TenantKeys(store, kekFrom({ secret: 'test-secret' }))
  const root = mkdtempSync(join(tmpdir(), 'hr-pt-img-'))
  const svc = new PatientService(root, tenants, keys, store)
  const hosp = store.createTenant({ name: '呼吸与重症医学中心', kind: 'org' })
  const user = store.createUser({ username: 'dr_li', display_name: '李医生', password_hash: 'x', tenant: { id: hosp.id, role: 'member' } }).id
  const as = (userId: string, via: Actor['via'] = 'user'): Actor => ({ userId, via })
  return { store, tenants, keys, root, svc, hosp, user, as }
}

describe('患者影像量化分析与病历关联 (Patient Imaging Integration)', () => {
  it('1. addImagingRecord: 支气管扩张与粘液栓分析结果自动加密入库、生成资产并更新患者标签', () => {
    const t = env()
    const a = t.as(t.user)
    const patient = t.svc.create(a, { sex: 'M', birth_year: 1968, tags: ['反复咳嗽', '咳脓痰'] })

    // 创建测试切片 PNG（以有效 PNG 头部为示例）
    const dummyPng = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
      0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
      0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
      0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82
    ])

    const res = t.svc.addImagingRecord(a, patient.id, {
      title: '胸部 HRCT 支气管扩张与粘液栓定量分析',
      report_date: '2026-10-05',
      model_id: 'bronchiectasis_mucus_analyzer',
      sample_id: 'chest_lung_ct',
      modality: 'Chest HRCT',
      metrics: {
        bar_ratio: 1.48,
        signet_ring_sign: true,
        mucus_plug_volume_mm3: 1420.5,
        airway_mucus_occlusion_pct: 3.8,
        high_attenuation_mucus_ham: true,
        ham_volume_mm3: 320.0,
        paired_artery_outer_diameter_mm: 1.62,
        airway_inner_luminal_diameter_mm: 2.40,
        airway_wall_thickness_mm: 0.95,
      },
      findings: [
        '印戒征阳性 (BAR 1.48 > 1.10)',
        '高密度粘液栓 (HAM) 阳性 (320 mm³，提示 ABPA 疑诊)',
        '支气管管腔粘液栓体积 1420.5 mm³',
      ],
      key_slice_png: dummyPng,
      add_tags: ['支气管扩张', 'ABPA疑诊'],
    })

    expect(res.record.kind).toBe('imaging')
    expect(res.record.status).toBe('confirmed')
    expect(res.record.title).toBe('胸部 HRCT 支气管扩张与粘液栓定量分析')
    expect(res.record.report_date).toBe('2026-10-05')
    expect(res.record.file_id).toBeTruthy()
    expect(res.asset_id).toBeTruthy()

    // 检查 Store 中资产是否存在可读取
    const asset = t.store.getAsset(res.asset_id)
    expect(asset).toBeTruthy()
    expect(asset?.mime).toBe('image/png')
    const assetBytes = t.store.getAssetBytes(res.asset_id)
    expect(Buffer.from(assetBytes!).equals(dummyPng)).toBe(true)

    // 检查机构患者库中加密文件与解密
    const file = t.svc.file(a, patient.id, res.file_id)
    expect(file.mime).toBe('image/png')
    expect(Buffer.from(file.bytes).equals(dummyPng)).toBe(true)

    // 读取患者详情：验证 records 中解密的 imaging_data 结构与标签自动合并
    const detail = t.svc.read(a, patient.id)
    expect(detail.tags).toEqual(['反复咳嗽', '咳脓痰', '支气管扩张', 'ABPA疑诊'])

    const imgRec = detail.records.find(r => r.kind === 'imaging')
    expect(imgRec).toBeTruthy()
    expect(imgRec?.imaging_data).toBeTruthy()
    const imgData = imgRec?.imaging_data as any
    expect(imgData.model_id).toBe('bronchiectasis_mucus_analyzer')
    expect(imgData.metrics.bar_ratio).toBe(1.48)
    expect(imgData.metrics.signet_ring_sign).toBe(true)
    expect(imgData.metrics.high_attenuation_mucus_ham).toBe(true)
    expect(imgData.findings.length).toBe(3)
  })

  it('2. RECIST 1.1 肿瘤病灶量化分析关联测试', () => {
    const t = env()
    const a = t.as(t.user)
    const patient = t.svc.create(a, { sex: 'F', birth_year: 1955, tags: ['肺癌靶向治疗'] })

    const dummyPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

    const res = t.svc.addImagingRecord(a, patient.id, {
      title: '胸部 CT 靶病灶 RECIST 1.1 测量',
      report_date: '2026-10-05',
      model_id: 'lung_nodule_segmenter',
      metrics: {
        longest_diameter_mm: 38.6,
        short_axis_mm: 24.2,
        total_volume_cm3: 28.4,
        key_slice_index: 28,
      },
      findings: [
        'RECIST 1.1 靶病灶最大截面长径 38.6 mm (短径 24.2 mm)',
        '3D 病灶体积 28.4 cm³ (关键截面第 #28 层)',
      ],
      key_slice_png: dummyPng,
    })

    const detail = t.svc.read(a, patient.id)
    const imgRec = detail.records[0]
    expect(imgRec).toBeDefined()
    expect(imgRec!.kind).toBe('imaging')
    const imgData = imgRec!.imaging_data as any
    expect(imgData.metrics.longest_diameter_mm).toBe(38.6)
    expect(imgData.metrics.total_volume_cm3).toBe(28.4)
  })

  it('3. HTTP API: GET /api/imaging/status 与 POST /api/patients/:ptid/imaging/analyze 端到端集成', async () => {
    const t = env()
    const a = t.as(t.user)
    const patient = t.svc.create(a, { sex: 'M', birth_year: 1975, tags: ['慢阻肺'] })

    // 探测健康状态
    const statusResp = await fetch('http://127.0.0.1:8004/health').catch(() => null)
    if (!statusResp || !statusResp.ok) {
      console.warn('MONAI worker 未在 8004 端口运行，跳过真实推理端到端测试')
      return
    }

    // 动态构造 mock 或真实 HTTP 请求
    const { buildApi } = await import('../src/http/api.ts')
    const { Documents } = await import('../src/model/runtime.ts')
    const { OpService } = await import('../src/ops/service.ts')
    const { TurnService } = await import('../src/turns/service.ts')
    const { TurnRegistry } = await import('../src/mcp/turns.ts')
    const { PostCheck } = await import('../src/collab/postcheck.ts')
    const { SlideRenderer } = await import('../src/render/slides.ts')
    const { Accounts } = await import('../src/auth/accounts.ts')
    const { issueToken } = await import('../src/auth/token.ts')

    const docs = new Documents(t.store)
    const ops = new OpService(docs)
    const SECRET = 'test-secret'
    const accounts = new Accounts(t.store, { secret: SECRET, devMode: false, devToken: 'dev', devUser: 'dev' })
    const uRow = t.store.getUser(t.user)!
    const token = issueToken(SECRET, { u: t.user, d: '*', p: ['read', 'write'], aud: 'web', ttlSeconds: 300, v: uRow.token_version })

    const app = buildApi({
      docs,
      ops,
      turns: new TurnService(docs, {} as any, new TurnRegistry()),
      postcheck: new PostCheck(docs),
      crossref: {} as any,
      renderer: new SlideRenderer(t.root),
      accounts,
      devMode: false,
      devUser: 'dev',
      patients: t.svc,
    })

    // 测试 GET /api/imaging/status
    const stRes = await app.request('/api/imaging/status', {
      headers: { Authorization: `Bearer ${token}` }
    })
    expect(stRes.status).toBe(200)
    const stJson = await stRes.json()
    expect(stJson.status).toBe('healthy')

    // 测试 POST /api/patients/:ptid/imaging/analyze (使用预置胸部 CT 样本运行支气管扩张量化)
    const analyzeRes = await app.request(`/api/patients/${patient.id}/imaging/analyze`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model_id: 'bronchiectasis_mucus_analyzer',
        sample_id: 'chest_lung_ct',
        bar_cutoff: 1.10,
        mucus_min_hu: 10.0,
        mucus_max_hu: 75.0,
        ham_threshold_hu: 70.0,
        auto_tag: true,
      })
    })

    expect(analyzeRes.status).toBe(201)
    const resJson = await analyzeRes.json()
    expect(resJson.ok).toBe(true)
    expect(resJson.record.kind).toBe('imaging')
    expect(resJson.asset_id).toBeTruthy()
    expect(resJson.file_id).toBeTruthy()
    expect(resJson.metrics).toBeTruthy()
    expect(resJson.metrics.bar_ratio).toBeGreaterThan(0)
    expect(resJson.findings.length).toBeGreaterThan(0)

    // 验证患者信息被更新：标签自动打上「支气管扩张」
    const updatedPatient = t.svc.read(a, patient.id)
    expect(updatedPatient.tags).toContain('支气管扩张')
  }, 30000)
})
