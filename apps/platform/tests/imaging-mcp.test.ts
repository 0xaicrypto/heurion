import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { issueToken, verifyToken } from '../src/auth/token.ts'
import { ClaimService } from '../src/claims/service.ts'
import { SlideRenderer } from '../src/render/slides.ts'
import { buildMcpServer } from '../src/mcp/server.ts'
import { TurnRegistry } from '../src/mcp/turns.ts'
import { setup } from './helpers.ts'

const SECRET = 'test-secret'

async function connectImagingMcp() {
  const env = setup('# 医学影像科研研究方案\n\n评估新药靶向治疗实体瘤的 RECIST 影像响应。')
  const workspace = mkdtempSync(join(tmpdir(), 'heurion-imaging-test-'))
  const registry = new TurnRegistry()
  const claims = verifyToken(SECRET, issueToken(SECRET, { u: 'u1', d: '*', p: ['read', 'write'], aud: 'mcp', ttlSeconds: 60 }), 'mcp')!

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

  return { env, client, call }
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
})
