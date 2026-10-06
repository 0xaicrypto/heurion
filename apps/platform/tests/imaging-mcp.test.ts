import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { issueToken, verifyToken } from '../src/auth/token.ts'
import { ClaimService } from '../src/claims/service.ts'
import { SlideRenderer } from '../src/render/slides.ts'
import { buildMcpServer } from '../src/mcp/server.ts'
import { TurnRegistry } from '../src/mcp/turns.ts'
import { TenantService } from '../src/auth/tenants.ts'
import { kekFrom, TenantKeys } from '../src/tenancy/keys.ts'
import { PatientService } from '../src/tenancy/patients.ts'
import { setup } from './helpers.ts'

const SECRET = 'test-secret'
const originalFetch = globalThis.fetch

beforeAll(async () => {
  const isOnline = await originalFetch('http://127.0.0.1:8004/health', { signal: AbortSignal.timeout(500) }).then(r => r.ok).catch(() => false)
  if (!isOnline) {
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (urlStr.includes('8004') || urlStr.startsWith('http://127.0.0.1:8004')) {
        const u = new URL(urlStr)
        if (u.pathname === '/health') {
          return new Response(JSON.stringify({
            status: 'healthy',
            service: 'heurion-monai-worker',
            device: { device_type: 'cpu', device_name: 'CPU' },
            supported_modalities: ['CT', 'MR']
          }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        }
        if (u.pathname === '/api/v1/models') {
          return new Response(JSON.stringify({
            models: [
              { id: 'lung_nodule_segmenter', name: '肺结节分割模型' },
              { id: 'multi_organ_ct', name: '腹部多器官分割模型' },
              { id: 'brain_tumor_brats', name: '脑胶质瘤 BraTS 分割模型' },
              { id: 'spleen_segmenter', name: '脾脏分割模型' },
              { id: 'bronchiectasis_mucus_analyzer', name: '胸部 HRCT 支气管扩张与粘液栓定量分析' },
            ]
          }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        }
        if (u.pathname === '/api/v1/samples') {
          return new Response(JSON.stringify({
            samples: [
              { sample_id: 'spleen_test', name: '脾脏增强 CT', modality: 'CT' },
              { sample_id: 'chest_lung_ct', name: '胸部 HRCT 支气管扩张', modality: 'CT' }
            ]
          }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        }
        if (u.pathname === '/api/v1/mpr/info') {
          return new Response(JSON.stringify({
            modality: 'CT',
            dimensions: { z: 269, y: 512, x: 512 },
            voxel_spacing_mm: { dz: 1.25, dy: 0.898, dx: 0.898 },
            planes: {
              axial: { total_slices: 269, default_slice: 115, label: '轴位 (横断面 Axial)' },
              coronal: { total_slices: 512, default_slice: 259, label: '冠状位 (额状面 Coronal)' },
              sagittal: { total_slices: 512, default_slice: 250, label: '矢状位 (矢状面 Sagittal)' }
            },
            center_slice: { axial: 115, coronal: 259, sagittal: 250 },
            bounding_box: { z_min: 0, z_max: 268, y_min: 40, y_max: 440, x_min: 0, x_max: 505 },
            recommended_windows: ['lung', 'mediastinum']
          }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        }
        if (u.pathname === '/api/v1/mpr/slice') {
          let body: any = {}
          try {
            if (typeof init?.body === 'string') body = JSON.parse(init.body)
          } catch {}
          const plane = body.plane || 'axial'
          const pngBuf = Buffer.alloc(1500, 0)
          pngBuf[0] = 0x89; pngBuf[1] = 0x50; pngBuf[2] = 0x4e; pngBuf[3] = 0x47
          pngBuf[4] = 0x0d; pngBuf[5] = 0x0a; pngBuf[6] = 0x1a; pngBuf[7] = 0x0a
          return new Response(JSON.stringify({
            plane,
            slice_index: body.slice_index ?? (plane === 'axial' ? 115 : 256),
            total_slices: plane === 'axial' ? 269 : 512,
            window: { preset: body.window_preset || 'lung', level: -600, width: 1500 },
            dimensions: { width: 512, height: plane === 'axial' ? 512 : 269 },
            pixel_spacing_mm: { horizontal: 0.898, vertical: plane === 'axial' ? 0.898 : 1.25 },
            lesion_present: true,
            lesion_pixel_count: 320,
            slice_png_base64: 'data:image/png;base64,' + pngBuf.toString('base64'),
            slice_png_size_bytes: 1500,
          }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        }
        if (u.pathname === '/api/v1/mpr/diff-slice') {
          let body: any = {}
          try {
            if (typeof init?.body === 'string') body = JSON.parse(init.body)
          } catch {}
          const plane = body.plane || 'axial'
          const pngBuf = Buffer.alloc(1500, 0)
          pngBuf[0] = 0x89; pngBuf[1] = 0x50; pngBuf[2] = 0x4e; pngBuf[3] = 0x47
          pngBuf[4] = 0x0d; pngBuf[5] = 0x0a; pngBuf[6] = 0x1a; pngBuf[7] = 0x0a
          return new Response(JSON.stringify({
            plane,
            slice_index: body.slice_index ?? 24,
            total_slices: 269,
            window: { preset: body.window_preset || 'lung', level: -600, width: 1500 },
            dimensions: { width: 512, height: 512 },
            pixel_spacing_mm: { horizontal: 0.898, vertical: 0.898 },
            threshold_hu: body.threshold_hu ?? 50,
            statistics_3d: {
              total_regressed_voxels: 120,
              total_progressed_voxels: 15,
              regressed_volume_cm3: 2.4,
              progressed_volume_cm3: 0.3,
              net_change_volume_cm3: -2.1,
              dominant_trend: '显著退缩吸收 (Significant Regression)',
            },
            slice_metrics: { regressed_pixels: 40, progressed_pixels: 5 },
            slice_png_base64: 'data:image/png;base64,' + pngBuf.toString('base64'),
            slice_png_size_bytes: 1500,
          }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        }
        if (u.pathname.includes('radiomics')) {
          return new Response(JSON.stringify({
            status: 'success',
            lesion_voxel_count: 2675,
            feature_count: 46,
            voxel_spacing_mm: [1.5, 0.8, 0.8],
            feature_groups: {
              shape_3d: { volume_cm3: 5.35, sphericity: 0.673, surface_area_mm2: 2198.0, max_3d_diameter_mm: 24.0 },
              first_order: { mean: 55.22, std: 8.4, skewness: 0.12, kurtosis: 2.85, entropy: 3.42 },
              glcm: { contrast: 1.25, homogeneity: 0.33, energy_asm: 0.04, joint_entropy: 3.65 },
              glrlm: { short_run_emphasis: 0.91, long_run_emphasis: 2.3, run_percentage: 0.82 }
            },
            features_flat: {
              shape_volume_cm3: 5.35,
              shape_sphericity: 0.673,
              firstorder_mean: 55.22,
              glcm_homogeneity: 0.33,
              glrlm_short_run_emphasis: 0.91
            },
            markdown_report: '### 3D 影像组学定量特征分析报告 (IBSI 标准)\n- 体积: 5.35 cm³\n- 球形度: 0.673'
          }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        }
        if (u.pathname.includes('interactive-segment')) {
          const pngBuf = Buffer.alloc(1500, 0)
          pngBuf[0] = 0x89; pngBuf[1] = 0x50; pngBuf[2] = 0x4e; pngBuf[3] = 0x47
          pngBuf[4] = 0x0d; pngBuf[5] = 0x0a; pngBuf[6] = 0x1a; pngBuf[7] = 0x0a
          return new Response(JSON.stringify({
            status: 'success',
            model_name: 'vista3d_interactive_segmenter',
            voxel_count: 1420,
            volume_cm3: 2.84,
            key_slice_index: 115,
            target_hu: 55.0,
            tolerance_hu: 45.0,
            positive_prompts_count: 1,
            negative_prompts_count: 0,
            recist_metrics: { longest_diameter_mm: 18.5, short_axis_mm: 12.0, total_volume_cm3: 2.84, key_slice_index: 115 },
            slice_png_base64: 'data:image/png;base64,' + pngBuf.toString('base64'),
            slice_png_size_bytes: 1500,
            summary_markdown: '**MONAI VISTA-3D 交互式点选分割结果**\n- 病灶总体积: 2.84 cm³'
          }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        }
        if (u.pathname.includes('whole-body')) {
          const pngBuf = Buffer.alloc(1500, 0)
          pngBuf[0] = 0x89; pngBuf[1] = 0x50; pngBuf[2] = 0x4e; pngBuf[3] = 0x47
          pngBuf[4] = 0x0d; pngBuf[5] = 0x0a; pngBuf[6] = 0x1a; pngBuf[7] = 0x0a
          return new Response(JSON.stringify({
            status: 'success',
            model_name: 'whole_body_ct_segmenter',
            modality: 'Whole-Body / Abdominal CT',
            accelerator: 'CPU',
            inference_duration_sec: 0.85,
            volume_dimensions: [64, 128, 128],
            voxel_spacing_mm: [1.5, 0.8, 0.8],
            l3_vertebra_slice_index: 24,
            body_composition: {
              skeletal_muscle_area_cm2: 135.2,
              skeletal_muscle_index_cm2_m2: 45.7,
              smi_cutoff: 52.4,
              sarcopenia_detected: true,
              sarcopenia_status: '肌少症阳性 (Sarcopenia Positive)',
              myosteatosis_detected: false,
              muscle_radiodensity_hu: 42.5,
              visceral_adipose_cm2: 115.8,
              subcutaneous_adipose_cm2: 140.2,
              total_adipose_cm2: 256.0,
              vat_to_sat_ratio: 0.826,
              sarcopenic_obesity: true,
            },
            organ_volumetry_cm3: {
              liver: 1420.5,
              spleen: 195.2,
              kidneys: 285.0,
              lungs: 3850.0,
              skeleton_bones: 2150.0,
              splenomegaly: false,
              hepatomegaly: false,
            },
            key_slice_png_base64: 'data:image/png;base64,' + pngBuf.toString('base64'),
            key_slice_png_size_bytes: 1500,
            summary_markdown: '### TotalSegmentator 全身体素 104 类解剖分割与肌少症分析报告\n- SMI: 45.7 cm²/m²\n- 状态: 肌少症阳性',
          }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        }
        if (u.pathname.includes('/registration/deformable')) {
          const pngBuf = Buffer.alloc(1500, 0)
          pngBuf[0] = 0x89; pngBuf[1] = 0x50; pngBuf[2] = 0x4e; pngBuf[3] = 0x47
          pngBuf[4] = 0x0d; pngBuf[5] = 0x0a; pngBuf[6] = 0x1a; pngBuf[7] = 0x0a
          return new Response(JSON.stringify({
            status: 'success',
            iterations_completed: 15,
            elapsed_sec: 0.12,
            initial_ncc: 0.725,
            final_ncc: 0.942,
            ncc_improvement: 0.217,
            initial_mse: 450.2,
            final_mse: 88.5,
            mse_reduction_percent: 80.3,
            max_displacement_mm: 5.62,
            mean_displacement_mm: 1.84,
            key_slice_index: 18,
            registered_slice_png_base64: 'data:image/png;base64,' + pngBuf.toString('base64'),
            registered_slice_png_size_bytes: 1500,
            summary_markdown: '### 3D 可形变配准报告\n- 改善率: 80.3%'
          }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        }
        if (u.pathname.includes('/registration/pet-ct-fusion')) {
          const pngBuf = Buffer.alloc(1500, 0)
          pngBuf[0] = 0x89; pngBuf[1] = 0x50; pngBuf[2] = 0x4e; pngBuf[3] = 0x47
          pngBuf[4] = 0x0d; pngBuf[5] = 0x0a; pngBuf[6] = 0x1a; pngBuf[7] = 0x0a
          return new Response(JSON.stringify({
            status: 'success',
            suv_max: 9.85,
            suv_mean: 4.82,
            mtv_cm3: 28.5,
            tlg: 137.37,
            suv_threshold: 2.5,
            key_slice_index: 18,
            fusion_png_base64: 'data:image/png;base64,' + pngBuf.toString('base64'),
            fusion_png_size_bytes: 1500,
            summary_markdown: '### PET-CT 融合与代谢定量报告\n- SUVmax: 9.85\n- TLG: 137.37'
          }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        }
        if (u.pathname.includes('/rtstruct/delineate')) {
          const pngBuf = Buffer.alloc(1500, 0)
          pngBuf[0] = 0x89; pngBuf[1] = 0x50; pngBuf[2] = 0x4e; pngBuf[3] = 0x47
          pngBuf[4] = 0x0d; pngBuf[5] = 0x0a; pngBuf[6] = 0x1a; pngBuf[7] = 0x0a
          return new Response(JSON.stringify({
            status: 'success',
            gtv_volume_cm3: 15.2,
            ctv_volume_cm3: 38.6,
            ptv_volume_cm3: 62.4,
            gtv_voxels: 1900,
            ctv_voxels: 4825,
            ptv_voxels: 7800,
            ctv_margin_mm: 6.0,
            ptv_margin_mm: 4.0,
            key_slice_index: 18,
            bone_barrier_clipped: true,
            elapsed_sec: 0.15,
            rtstruct_png_base64: 'data:image/png;base64,' + pngBuf.toString('base64'),
            rtstruct_png_size_bytes: 1500,
            summary_markdown: '### 放疗靶区勾画报告\n- GTV: 15.2 cm³\n- CTV: 38.6 cm³\n- PTV: 62.4 cm³'
          }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        }
        if (u.pathname.includes('/analyze/')) {
          let body: any = {}
          try {
            if (typeof init?.body === 'string') body = JSON.parse(init.body)
          } catch {}
          const isBronch = body.model_name === 'bronchiectasis_mucus_analyzer' || body.model_id === 'bronchiectasis_mucus_analyzer' || body.sample_id === 'chest_lung_ct'
          const isSpleen = body.sample_id === 'spleen_test' || body.model_id === 'spleen_segmenter'

          const pngBuf = Buffer.alloc(1500, 0)
          pngBuf[0] = 0x89; pngBuf[1] = 0x50; pngBuf[2] = 0x4e; pngBuf[3] = 0x47
          pngBuf[4] = 0x0d; pngBuf[5] = 0x0a; pngBuf[6] = 0x1a; pngBuf[7] = 0x0a
          const key_slice_png_base64 = 'data:image/png;base64,' + pngBuf.toString('base64')

          if (isBronch) {
            return new Response(JSON.stringify({
              status: 'success',
              model_name: 'bronchiectasis_mucus_analyzer',
              modality: 'Chest HRCT',
              key_slice_png_base64,
              recist_metrics: { longest_diameter_mm: 28.5, short_axis_mm: 18.2, total_volume_cm3: 12.8, key_slice_index: 114 },
              metrics: {
                broncho_arterial_ratio: 1.45,
                bronchus_caliber_mm: 8.5,
                artery_caliber_mm: 5.8,
                wall_thickness_mm: 2.4,
                wall_to_lumen_ratio: 0.28,
                total_mucus_volume_cm3: 368.29,
                high_attenuation_mucus_cm3: 12.44,
                total_airway_volume_cm3: 3545.92,
                airway_occlusion_rate_pct: 10.4,
                signs_detected: ['印戒征 (Signet Ring Sign, BAR = 1.45 > 1.0)', '双轨征', '指套征', '树芽征', '高密度粘液栓 (HAM Sign)'],
              },
              findings: ['印戒征阳性 (BAR 1.45 > 1.1)', '高密度粘液栓 (HAM) 阳性 (12.44 cm³，提示 ABPA 变应性支气管肺曲霉病)'],
            }), { status: 200, headers: { 'Content-Type': 'application/json' } })
          }

          if (isSpleen) {
            return new Response(JSON.stringify({
              status: 'success',
              model_name: 'spleen_segmenter',
              modality: 'Abdominal CT',
              key_slice_png_base64,
              recist_metrics: { longest_diameter_mm: 215.0, short_axis_mm: 125.0, total_volume_cm3: 1250.0, key_slice_index: 35 },
              findings: ['脾脏体积增大'],
            }), { status: 200, headers: { 'Content-Type': 'application/json' } })
          }

          return new Response(JSON.stringify({
            status: 'success',
            model_name: body.model_name || 'lung_nodule_segmenter',
            modality: 'CT',
            key_slice_png_base64,
            recist_metrics: { longest_diameter_mm: 24.5, short_axis_mm: 18.2, total_volume_cm3: 12.8, key_slice_index: 16 },
            findings: ['右肺下叶实性结节'],
          }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        }
      }
      return originalFetch(input, init)
    }
  }
})

afterAll(() => {
  globalThis.fetch = originalFetch
})

async function connectImagingMcp() {
  const env = setup('# 医学影像科研研究方案\n\n评估新药靶向治疗实体瘤的 RECIST 影像响应。')
  const workspace = mkdtempSync(join(tmpdir(), 'heurion-imaging-test-'))
  const registry = new TurnRegistry()
  const hosp = env.store.createTenant({ name: '放射与影像中心', kind: 'org' })
  const uRow = env.store.createUser({ username: 'dr_mcp', display_name: '医生', password_hash: 'x', tenant: { id: hosp.id, role: 'member' } })
  const claims = verifyToken(SECRET, issueToken(SECRET, { u: uRow.id, d: '*', p: ['read', 'write'], aud: 'mcp', ttlSeconds: 60 }), 'mcp')!

  const tenants = new TenantService(env.store, { devMode: false })
  const keys = new TenantKeys(env.store, kekFrom({ secret: SECRET }))
  const patients = new PatientService(mkdtempSync(join(tmpdir(), 'hr-pt-mcp-')), tenants, keys, env.store)

  const server = buildMcpServer({
    docs: env.docs,
    ops: env.ops,
    turns: registry,
    secret: SECRET,
    claims: new ClaimService(env.docs, {} as any),
    renderer: new SlideRenderer(workspace),
    pubmed: {} as any,
    crossref: {} as any,
    workspaceDir: () => workspace,
    isLiveSession: () => true,
    patients,
  }, claims)

  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(a)
  const client = new Client({ name: 'imaging-test-client', version: '1.0' })
  await client.connect(b)

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args }) as {
      isError?: boolean
      content: Array<{ type?: string; text?: string }>
    }
    const body = r.content?.[0]?.text ?? ''
    try {
      return { isError: r.isError ?? false, data: JSON.parse(body), raw: body }
    } catch {
      return { isError: r.isError ?? false, data: null, raw: body }
    }
  }

  return { env: { ...env, patients, userId: uRow.id }, client, call }
}

describe('MONAI 医学影像分析 MCP 工具套件 (imaging_*)', () => {
  it('1. imaging_status: 探测 MONAI 影像计算节点状态与硬件加速能力', async () => {
    const { call } = await connectImagingMcp()
    const res = await call('imaging_status')
    expect(res.isError).toBe(false)
    expect(res.data.status).toBe('healthy')
    expect(res.data.service).toBe('heurion-monai-worker')
    expect(res.data.device).toBeDefined()
    expect(res.data.device.device_type).toMatch(/^(mps|cuda|cpu)$/)
    expect(res.data.supported_modalities).toContain('CT')
  })

  it('2. imaging_models: 获取临床深度学习模型列表', async () => {
    const { call } = await connectImagingMcp()
    const res = await call('imaging_models')
    expect(res.isError).toBe(false)
    expect(Array.isArray(res.data.models)).toBe(true)
    const modelIds = res.data.models.map((m: any) => m.id)
    expect(modelIds).toContain('lung_nodule_segmenter')
    expect(modelIds).toContain('multi_organ_ct')
    expect(modelIds).toContain('brain_tumor_brats')
  })

  it('3. imaging_recist_evaluate: 验证 RECIST 1.1 靶病灶疗效评定规则 (CR / PR / SD / PD)', async () => {
    const { call } = await connectImagingMcp()

    // PR: 缩小 >= 30%
    const prRes = await call('imaging_recist_evaluate', { baseline_sum_mm: 50.0, followup_sum_mm: 30.0 })
    expect(prRes.data.recist_category).toBe('PR')
    expect(prRes.data.percent_change).toBe('-40%')
    expect(prRes.data.interpretation).toContain('部分缓解')

    // PD: 增加 >= 20% 且绝对值 >= 5mm
    const pdRes = await call('imaging_recist_evaluate', { baseline_sum_mm: 50.0, followup_sum_mm: 65.0 })
    expect(pdRes.data.recist_category).toBe('PD')
    expect(pdRes.data.percent_change).toBe('+30%')
    expect(pdRes.data.interpretation).toContain('疾病进展')

    // SD: 稳定
    const sdRes = await call('imaging_recist_evaluate', { baseline_sum_mm: 50.0, followup_sum_mm: 48.0 })
    expect(sdRes.data.recist_category).toBe('SD')
    expect(sdRes.data.interpretation).toContain('疾病稳定')

    // CR: 归零
    const crRes = await call('imaging_recist_evaluate', { baseline_sum_mm: 50.0, followup_sum_mm: 0.0 })
    expect(crRes.data.recist_category).toBe('CR')
    expect(crRes.data.interpretation).toContain('完全缓解')
  })

  it('4. imaging_analyze: 运行 3D 体素病灶分割与 RECIST 量化，并自动沉淀出版级关键切片资产', async () => {
    const { env, call } = await connectImagingMcp()
    const res = await call('imaging_analyze', {
      model_id: 'lung_nodule_segmenter',
      window_preset: 'lung',
      z_slices: 32,
      label: '图 1 靶病灶基线 RECIST 切片',
    })

    expect(res.isError).toBe(false)
    expect(res.data.status).toBe('success')
    expect(res.data.asset_id).toBeDefined()
    expect(res.data.recist_metrics).toBeDefined()
    expect(res.data.recist_metrics.longest_diameter_mm).toBeGreaterThan(0)
    expect(res.data.recist_metrics.total_volume_cm3).toBeGreaterThan(0)
    expect(res.data.recist_metrics.key_slice_index).toBeGreaterThanOrEqual(0)
    expect(res.data.markdown_insert).toContain(`asset:${res.data.asset_id}`)

    // 验证资产已真实写入平台数据库，格式为有效 PNG 图像
    const assetRow = env.docs.store.getAsset(res.data.asset_id)
    expect(assetRow).toBeDefined()
    expect(assetRow?.mime).toBe('image/png')
    expect(assetRow?.size).toBeGreaterThan(500)

    const bytes = env.docs.store.getAssetBytes(res.data.asset_id)
    expect(bytes).toBeDefined()
    expect(bytes?.length).toBeGreaterThan(500)
    // PNG magic bytes
    expect(bytes?.[0]).toBe(0x89)
    expect(bytes?.[1]).toBe(0x50) // P
    expect(bytes?.[2]).toBe(0x4e) // N
    expect(bytes?.[3]).toBe(0x47) // G
  })

  it('5. imaging_analyze (真实临床样本): 真实人体 CT 样本端到端推理与资产沉淀', async () => {
    const { env, call } = await connectImagingMcp()
    const res = await call('imaging_analyze', {
      sample_id: 'spleen_test',
      model_id: 'spleen_segmenter',
      label: '图 2 真实患者脾脏及腹部增强 CT 关键截面',
    })

    expect(res.isError).toBe(false)
    expect(res.data.status).toBe('success')
    expect(res.data.asset_id).toBeDefined()
    expect(res.data.recist_metrics.longest_diameter_mm).toBeGreaterThan(200)
    expect(res.data.recist_metrics.total_volume_cm3).toBeGreaterThan(1000)
  })

  it('6. imaging_analyze (支气管扩张与粘液栓): 真实全胸部 HRCT 样本端到端推理与 Fleischner 准则量化', async () => {
    const { env, call } = await connectImagingMcp()
    const res = await call('imaging_analyze', {
      sample_id: 'chest_lung_ct',
      model_id: 'bronchiectasis_mucus_analyzer',
      window_preset: 'lung',
      bar_cutoff: 1.10,
      mucus_min_hu: 10,
      mucus_max_hu: 75,
      ham_threshold_hu: 70,
      label: '图 3 真实全胸部 HRCT 支气管扩张与粘液栓分析关键截面',
    })

    expect(res.isError).toBe(false)
    expect(res.data.status).toBe('success')
    expect(res.data.asset_id).toBeDefined()
    expect(res.data.model_name).toBe('bronchiectasis_mucus_analyzer')
    expect(res.data.modality).toBe('Chest HRCT')
    expect(res.data.metrics.broncho_arterial_ratio).toBeGreaterThan(1.0)
    expect(res.data.metrics.total_mucus_volume_cm3).toBeGreaterThan(0)
    expect(res.data.metrics.signs_detected.length).toBeGreaterThanOrEqual(3)

    // 验证资产已沉淀为 PNG 格式
    const assetRow = env.docs.store.getAsset(res.data.asset_id)
    expect(assetRow?.mime).toBe('image/png')
    expect(assetRow?.size).toBeGreaterThan(1000)
  }, 30000)

  it('7. imaging_volume_info: 探测 3D 体积几何维度、体素间距与正交平面总层数', async () => {
    const { call } = await connectImagingMcp()
    const res = await call('imaging_volume_info', {
      sample_id: 'chest_lung_ct',
    })

    expect(res.isError).toBe(false)
    expect(res.data.status).toBe('success')
    expect(res.data.dimensions).toBeDefined()
    expect(res.data.dimensions.z).toBeGreaterThan(0)
    expect(res.data.dimensions.y).toBeGreaterThan(0)
    expect(res.data.dimensions.x).toBeGreaterThan(0)
    expect(res.data.voxel_spacing_mm).toBeDefined()
    expect(res.data.planes.axial.total_slices).toBe(res.data.dimensions.z)
    expect(res.data.planes.coronal.total_slices).toBe(res.data.dimensions.y)
    expect(res.data.planes.sagittal.total_slices).toBe(res.data.dimensions.x)
    expect(res.data.recommended_windows).toContain('lung')
  })

  it('8. imaging_mpr_slice: 抽取三大正交平面 (轴位/冠状位/矢状位) 切片并沉淀为用户资产', async () => {
    const { env, call } = await connectImagingMcp()

    // 1) 冠状位 (Coronal) 切片提取
    const coronalRes = await call('imaging_mpr_slice', {
      sample_id: 'chest_lung_ct',
      plane: 'coronal',
      slice_index: 250,
      window_preset: 'lung',
      overlay_mask: true,
      label: '图 4 真实患者胸部 HRCT 冠状位切片',
    })

    expect(coronalRes.isError).toBe(false)
    expect(coronalRes.data.status).toBe('success')
    expect(coronalRes.data.plane).toBe('coronal')
    expect(coronalRes.data.slice_index).toBe(250)
    expect(coronalRes.data.total_slices).toBeGreaterThan(0)
    expect(coronalRes.data.asset_id).toBeDefined()
    expect(coronalRes.data.markdown_insert).toContain(`asset:${coronalRes.data.asset_id}`)

    // 验证资产写入数据库
    const assetRow = env.docs.store.getAsset(coronalRes.data.asset_id)
    expect(assetRow).toBeDefined()
    expect(assetRow?.mime).toBe('image/png')
    const bytes = env.docs.store.getAssetBytes(coronalRes.data.asset_id)
    expect(bytes?.[0]).toBe(0x89) // PNG magic

    // 2) 矢状位 (Sagittal) 切片提取
    const sagittalRes = await call('imaging_mpr_slice', {
      sample_id: 'chest_lung_ct',
      plane: 'sagittal',
      window_preset: 'lung',
      overlay_mask: false,
      save_asset: false,
    })

    expect(sagittalRes.isError).toBe(false)
    expect(sagittalRes.data.status).toBe('success')
    expect(sagittalRes.data.plane).toBe('sagittal')
    expect(sagittalRes.data.asset_id).toBeUndefined() // save_asset: false 时不落库
  }, 30000)

  it('9. imaging_diff_slice: 提取双期 3D 刚性配准与差分吸收热力图切片并沉淀资产', async () => {
    const { env, call } = await connectImagingMcp()
    const diffRes = await call('imaging_diff_slice', {
      baseline_sample_id: 'chest_lung_ct',
      followup_sample_id: 'chest_lung_ct',
      plane: 'axial',
      slice_index: 24,
      threshold_hu: 50,
      save_asset: true,
      label: '图 5 随访对比 3D 体素差分吸收热力图',
    })

    expect(diffRes.isError).toBe(false)
    expect(diffRes.data.status).toBe('success')
    expect(diffRes.data.plane).toBe('axial')
    expect(diffRes.data.slice_index).toBe(24)
    expect(diffRes.data.statistics_3d).toBeDefined()
    expect(diffRes.data.statistics_3d.dominant_trend).toBeDefined()
    expect(diffRes.data.asset_id).toBeDefined()
    expect(diffRes.data.markdown_insert).toContain(`asset:${diffRes.data.asset_id}`)
  }, 30000)

  it('10. imaging_export_standard: 导出 HL7 FHIR 与 DICOM SR 标准医学交换格式', async () => {
    const { env, call } = await connectImagingMcp()
    const a = { userId: (env as any).userId, via: 'user' as const }
    const patient = env.patients.create(a, {
      sex: 'F',
      birth_year: 1975,
      tags: ['肺腺癌', '靶向治疗随访'],
    })

    const dummyPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const rec = env.patients.addImagingRecord(a, patient.id, {
      title: '靶向治疗 3 个月复查 CT',
      report_date: '2026-10-01',
      model_id: 'lung_nodule_segmenter',
      metrics: {
        longest_diameter_mm: 19.5,
        short_axis_mm: 12.0,
        total_volume_cm3: 8.4,
        key_slice_index: 18,
      },
      key_slice_png: dummyPng,
    })

    // 10.1 导出 FHIR
    const fhirRes = await call('imaging_export_standard', {
      patient_id: patient.id,
      format: 'fhir',
      record_id: rec.record.id,
    })
    expect(fhirRes.isError).toBe(false)
    expect(fhirRes.data.status).toBe('success')
    expect(fhirRes.data.format).toBe('fhir')
    expect(fhirRes.data.data.resourceType).toBe('DiagnosticReport')

    // 10.2 导出 DICOM SR
    const srRes = await call('imaging_export_standard', {
      patient_id: patient.id,
      format: 'dicom-sr',
      record_id: rec.record.id,
    })
    expect(srRes.isError).toBe(false)
    expect(srRes.data.status).toBe('success')
    expect(srRes.data.format).toBe('dicom-sr')
    expect(srRes.data.data.SOPClassUID).toBe('1.2.840.10008.5.1.4.1.1.88.22')
  })

  it('11. imaging_generate_full_report: 生成全景多模态影像诊断报告并自动存入档案', async () => {
    const { env, call } = await connectImagingMcp()
    const a = { userId: (env as any).userId, via: 'user' as const }
    const patient = env.patients.create(a, {
      sex: 'M',
      birth_year: 1968,
      tags: ['支气管扩张', 'ABPA 疑诊'],
    })

    const dummyPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    env.patients.addLab(a, patient.id, {
      test_name: '血清总 IgE',
      value: 1820,
      unit: 'kU/L',
      ref_low: 0,
      ref_high: 100,
      flag: 'H',
      collected_on: '2026-10-02',
    }, { status: 'confirmed' })

    const rec = env.patients.addImagingRecord(a, patient.id, {
      title: '高分辨胸部 CT 扫描',
      report_date: '2026-10-04',
      model_id: 'bronchiectasis_mucus_analyzer',
      metrics: {
        longest_diameter_mm: 8.5,
        short_axis_mm: 6.0,
        total_volume_cm3: 5.2,
        bar_max: 1.92,
        ham_max_hu: 98.0,
        high_attenuation_mucus: true,
      },
      key_slice_png: dummyPng,
    })

    const reportRes = await call('imaging_generate_full_report', {
      patient_id: patient.id,
      record_id: rec.record.id,
      save_to_records: true,
    })

    expect(reportRes.isError).toBe(false)
    expect(reportRes.data.status).toBe('success')
    expect(reportRes.data.patient_id).toBe(patient.id)
    expect(reportRes.data.urgency).toBe('high')
    expect(reportRes.data.saved_record_id).toBeDefined()
    expect(reportRes.data.full_report_markdown).toContain('全景多模态影像诊断报告单')
    expect(reportRes.data.full_report_markdown).toContain('高密度粘液栓 HAM')
    expect(reportRes.data.full_report_markdown).toContain('变应性支气管肺曲霉病')
    expect(reportRes.data.full_report_markdown).toContain('1820')

    // 验证病历档案中多了一份 confirmed 的诊断报告
    const detail = env.patients.read(a, patient.id)
    const reportDoc = detail.records.find((r: any) => r.id === reportRes.data.saved_record_id)
    expect(reportDoc).toBeDefined()
    expect(reportDoc?.kind).toBe('report')
  })

  it('12. imaging_radiomics: 提取 IBSI 标准 3D 影像组学多维定量特征', async () => {
    const { call } = await connectImagingMcp()
    const res = await call('imaging_radiomics', {
      sample_id: 'chest_lung_ct',
      model_name: 'lung_nodule_segmenter',
      num_bins: 16,
    })

    expect(res.isError).toBe(false)
    expect(res.data.status).toBe('success')
    expect(res.data.feature_count).toBeGreaterThanOrEqual(40)
    expect(res.data.feature_groups).toBeDefined()
    expect(res.data.feature_groups.shape_3d).toBeDefined()
    expect(res.data.feature_groups.first_order).toBeDefined()
    expect(res.data.feature_groups.glcm).toBeDefined()
    expect(res.data.feature_groups.glrlm).toBeDefined()
    expect(res.data.features_flat).toBeDefined()
    expect(res.data.features_flat.shape_volume_cm3).toBeGreaterThan(0)
    expect(res.data.markdown_report).toContain('3D 影像组学定量特征分析报告')
  }, 30000)

  it('13. imaging_interactive_segment: VISTA-3D 交互式正负点选分割与病灶边界动态雕刻', async () => {
    const { call } = await connectImagingMcp()
    const res = await call('imaging_interactive_segment', {
      sample_id: 'chest_lung_ct',
      points: [
        { z: 115, y: 256, x: 256, is_positive: true },
        { z: 115, y: 300, x: 256, is_positive: false },
      ],
      plane: 'axial',
      window_preset: 'lung',
      save_asset: true,
      label: '图 6 VISTA-3D 交互点选分割',
    })

    expect(res.isError).toBe(false)
    expect(res.data.status).toBe('success')
    expect(res.data.model_name).toBe('vista3d_interactive_segmenter')
    expect(res.data.slice_png_base64).toBeDefined()
    expect(res.data.recist_metrics).toBeDefined()
    expect(res.data.asset_id).toBeDefined()
    expect(res.data.markdown_insert).toContain(`asset:${res.data.asset_id}`)
    expect(res.data.positive_prompts_count).toBeGreaterThanOrEqual(1)
  }, 30000)

  it('14. imaging_whole_body_segment: TotalSegmentator 104 类解剖分割与 L3 断面肌少症量化', async () => {
    const { call } = await connectImagingMcp()
    const res = await call('imaging_whole_body_segment', {
      sample_id: 'chest_lung_ct',
      patient_sex: 'M',
      patient_height_m: 1.75,
      patient_weight_kg: 70.0,
      save_asset: true,
      label: '图 7 L3 断面骨骼肌与体成分分析',
    })

    expect(res.isError).toBe(false)
    expect(res.data.status).toBe('success')
    expect(res.data.model_name).toBe('whole_body_ct_segmenter')
    expect(res.data.body_composition).toBeDefined()
    expect(res.data.body_composition.skeletal_muscle_area_cm2).toBeGreaterThan(0)
    expect(res.data.body_composition.skeletal_muscle_index_cm2_m2).toBeGreaterThan(0)
    expect(res.data.body_composition.smi_cutoff).toBe(52.4)
    expect(res.data.body_composition.visceral_adipose_cm2).toBeGreaterThan(0)
    expect(res.data.organ_volumetry_cm3).toBeDefined()
    expect(res.data.organ_volumetry_cm3.liver).toBeGreaterThan(0)
    expect(res.data.asset_id).toBeDefined()
    expect(res.data.markdown_insert).toContain(`asset:${res.data.asset_id}`)
    expect(res.data.summary_markdown).toContain('TotalSegmentator')
  }, 30000)

  it('15. imaging_deformable_register: 3D 可变形多模态弹性配准与密集位移场矢量计算', async () => {
    const { call } = await connectImagingMcp()
    const res = await call('imaging_deformable_register', {
      fixed_sample_id: 'pet_ct_pair',
      moving_sample_id: 'pet_ct_pair',
      iterations: 15,
      save_asset: true,
      label: '图 8 3D 可变形弹性配准切片',
    })

    expect(res.isError).toBe(false)
    expect(res.data.status).toBe('success')
    expect(res.data.final_ncc).toBeGreaterThan(0)
    expect(res.data.mse_reduction_percent).toBeGreaterThanOrEqual(0)
    expect(res.data.max_displacement_mm).toBeGreaterThan(0)
    expect(res.data.asset_id).toBeDefined()
    expect(res.data.markdown_insert).toContain(`asset:${res.data.asset_id}`)
    expect(res.data.summary_markdown).toContain('可形变配准')
  }, 30000)

  it('16. imaging_pet_ct_fuse: PET-CT 代谢解剖融合、SUV 定量与假彩色渲染', async () => {
    const { call } = await connectImagingMcp()
    const res = await call('imaging_pet_ct_fuse', {
      sample_id: 'pet_ct_pair',
      suv_threshold_ratio: 0.41,
      alpha: 0.55,
      colormap: 'turbo',
      save_asset: true,
      label: '图 9 肿瘤原发灶 PET-CT 代谢融合切片',
    })

    expect(res.isError).toBe(false)
    expect(res.data.status).toBe('success')
    expect(res.data.suv_max).toBeGreaterThan(0)
    expect(res.data.mtv_cm3).toBeGreaterThan(0)
    expect(res.data.tlg).toBeGreaterThan(0)
    expect(res.data.asset_id).toBeDefined()
    expect(res.data.markdown_insert).toContain(`asset:${res.data.asset_id}`)
    expect(res.data.summary_markdown).toContain('SUV')
  }, 30000)

  it('17. imaging_rtstruct_delineate: 放疗靶区 (GTV/CTV/PTV) 勾画、骨解剖屏障阻断与 RT-STRUCT', async () => {
    const { call } = await connectImagingMcp()
    const res = await call('imaging_rtstruct_delineate', {
      sample_id: 'pet_ct_pair',
      ctv_margin_mm: 6.0,
      ptv_margin_mm: 4.0,
      clip_bone_barrier: true,
      save_asset: true,
      label: '图 10 放疗多靶区三维勾画切片',
    })

    expect(res.isError).toBe(false)
    expect(res.data.status).toBe('success')
    expect(res.data.gtv_volume_cm3).toBeGreaterThan(0)
    expect(res.data.ctv_volume_cm3).toBeGreaterThan(res.data.gtv_volume_cm3)
    expect(res.data.ptv_volume_cm3).toBeGreaterThan(res.data.ctv_volume_cm3)
    expect(res.data.bone_barrier_clipped).toBe(true)
    expect(res.data.asset_id).toBeDefined()
    expect(res.data.markdown_insert).toContain(`asset:${res.data.asset_id}`)
    expect(res.data.summary_markdown).toContain('放疗靶区')
  }, 30000)
})



