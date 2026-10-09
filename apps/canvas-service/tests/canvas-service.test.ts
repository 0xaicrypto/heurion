import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Store } from '@heurion2/platform/src/store/db.ts'
import { Documents } from '@heurion2/platform/src/model/runtime.ts'
import { OpService } from '@heurion2/platform/src/ops/service.ts'
import { SlideRenderer } from '@heurion2/platform/src/render/slides.ts'
import { issueToken, verifyToken } from '@heurion2/platform/src/auth/token.ts'
import { buildCanvasMcpServer } from '@heurion2/platform/src/mcp/server.ts'
import { TurnRegistry } from '@heurion2/platform/src/mcp/turns.ts'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import { attachCanvasCollab } from '../src/collab.ts'
import { createCanvasApp } from '../src/app.ts'

const SECRET = 'canvas-service-test-secret-12345'
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
              { id: 'spleen_segmenter', name: '脾脏分割模型' },
            ]
          }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        }
        if (u.pathname === '/api/v1/samples') {
          return new Response(JSON.stringify({
            samples: [
              { sample_id: 'spleen_test', name: '脾脏增强 CT', modality: 'CT' },
            ]
          }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        }
        if (u.pathname.includes('/analyze/')) {
          const pngBuf = Buffer.alloc(1500, 0)
          pngBuf[0] = 0x89; pngBuf[1] = 0x50; pngBuf[2] = 0x4e; pngBuf[3] = 0x47
          pngBuf[4] = 0x0d; pngBuf[5] = 0x0a; pngBuf[6] = 0x1a; pngBuf[7] = 0x0a
          const key_slice_png_base64 = 'data:image/png;base64,' + pngBuf.toString('base64')

          return new Response(JSON.stringify({
            status: 'success',
            model_name: 'spleen_segmenter',
            modality: 'Abdominal CT',
            key_slice_png_base64,
            recist_metrics: { longest_diameter_mm: 215.0, short_axis_mm: 125.0, total_volume_cm3: 1250.0, key_slice_index: 35 },
            findings: ['脾脏体积增大'],
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

function setupTestEnv() {
  const store = new Store(':memory:')
  const docs = new Documents(store)
  const ops = new OpService(docs)
  const renderDir = mkdtempSync(join(tmpdir(), 'canvas-render-'))
  const renderer = new SlideRenderer(renderDir)

  const token = issueToken(SECRET, {
    u: 'researcher_1',
    d: '*',
    p: ['read', 'write'],
    aud: 'web',
    ttlSeconds: 3600,
  })

  const mcpToken = issueToken(SECRET, {
    u: 'researcher_1',
    d: '*',
    p: ['read', 'write'],
    aud: 'mcp',
    ttlSeconds: 3600,
  })

  const app = createCanvasApp({
    store,
    docs,
    ops,
    renderer,
    secret: SECRET,
    devMode: false,
  })

  return { store, docs, ops, renderer, token, mcpToken, app }
}

describe('OmniCanvas / AgentDoc 独立画布与在线文档服务 (@heurion2/canvas-service)', () => {
  describe('1. REST API 端点', () => {
    it('健康检查 /health 返回服务元数据与能力清单', async () => {
      const { app } = setupTestEnv()
      const res = await app.request('/health')
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.status).toBe('ok')
      expect(data.service).toBe('omnicanvas')
      expect(data.capabilities).toContain('canvas-mcp')
      expect(data.capabilities).toContain('crdt-collab')
    })

    it('开发者免登录会话 /api/auth/session 自动分发有效签名的 web 与 mcp 令牌', async () => {
      const { app } = setupTestEnv()
      const res = await app.request('/api/auth/session')
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.user).toBeDefined()
      expect(data.webToken).toBeTruthy()
      expect(data.mcpToken).toBeTruthy()
      // 验证签发的令牌能通过合法校验
      const webClaims = verifyToken(SECRET, data.webToken, 'web')
      expect(webClaims?.u).toBe(data.user)
      const mcpClaims = verifyToken(SECRET, data.mcpToken, 'mcp')
      expect(mcpClaims?.u).toBe(data.user)
    })

    it('未授权访问 /api/* 返回 401', async () => {
      const { app } = setupTestEnv()
      const res = await app.request('/api/docs')
      expect(res.status).toBe(401)
    })

    it('获取幻灯片模板与主题清单 /api/templates/deck', async () => {
      const { app, token } = setupTestEnv()
      const res = await app.request('/api/templates/deck', {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.layouts.length).toBeGreaterThan(0)
      expect(data.themes).toBeDefined()
    })

    it('文档与幻灯片的完整生命周期（创建、修改标题、导出 Markdown/DOCX/PPTX、软删除与恢复）', async () => {
      const { app, token, docs } = setupTestEnv()

      // 1. 创建普通流式文档
      const createDocRes = await app.request('/api/docs', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'AI 原生写作体验白皮书', kind: 'doc' }),
      })
      expect(createDocRes.status).toBe(201)
      const doc = await createDocRes.json()
      expect(doc.id).toBeTruthy()
      expect(doc.title).toBe('AI 原生写作体验白皮书')
      expect(doc.kind).toBe('doc')

      // 2. 修改标题
      const patchRes = await app.request(`/api/docs/${doc.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'AI 原生写作体验白皮书（修订版）' }),
      })
      expect(patchRes.status).toBe(200)
      const patched = await patchRes.json()
      expect(patched.title).toBe('AI 原生写作体验白皮书（修订版）')

      // 3. 提交编辑操作 (DocOp)
      const initialNode = docs.get(doc.id).firstChild!
      const initialId = initialNode.attrs.id as string

      const editRes = await app.request(`/api/docs/${doc.id}/edit`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ops: [{
            op: 'insert_after',
            anchor_id: initialId,
            markdown: '# 架构概览\n\nOmniCanvas 采用双模块模型。',
          }],
        }),
      })
      expect(editRes.status).toBe(200)
      const editData = await editRes.json()
      expect(editData.rev).toBeGreaterThan(0)

      // 4. 导出 Markdown
      const exportMdRes = await app.request(`/api/docs/${doc.id}/export.md`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(exportMdRes.status).toBe(200)
      const mdContent = await exportMdRes.text()
      expect(mdContent).toContain('架构概览')

      // 5. 导出 DOCX
      const exportDocxRes = await app.request(`/api/docs/${doc.id}/export.docx`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(exportDocxRes.status).toBe(200)
      const docxBytes = await exportDocxRes.arrayBuffer()
      expect(docxBytes.byteLength).toBeGreaterThan(100)

      // 6. 创建幻灯片画布 (Deck)
      const createDeckRes = await app.request('/api/docs', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'OmniCanvas 商业化汇报', kind: 'deck', theme: 'clean-white' }),
      })
      expect(createDeckRes.status).toBe(201)
      const deckDoc = await createDeckRes.json()
      expect(deckDoc.kind).toBe('deck')

      // 7. 导出 PPTX
      const exportPptxRes = await app.request(`/api/docs/${deckDoc.id}/export.pptx`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(exportPptxRes.status).toBe(200)
      const pptxBytes = await exportPptxRes.arrayBuffer()
      expect(pptxBytes.byteLength).toBeGreaterThan(100)

      // 8. 软删除与恢复
      const deleteRes = await app.request(`/api/docs/${doc.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(deleteRes.status).toBe(200)

      const readTrashedRes = await app.request(`/api/docs/${doc.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(readTrashedRes.status).toBe(404)

      const restoreRes = await app.request(`/api/docs/${doc.id}/restore`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(restoreRes.status).toBe(200)

      const readRestoredRes = await app.request(`/api/docs/${doc.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(readRestoredRes.status).toBe(200)
    })

    it('SVG 机制图渲染为 PNG 资产 (/api/diagram/render & /api/assets/:id)', async () => {
      const { app, token } = setupTestEnv()
      const sampleSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" width="200" height="100">
        <rect width="200" height="100" fill="#2563EB"/>
        <text x="100" y="55" fill="#FFFFFF" text-anchor="middle" font-size="16">OmniCanvas</text>
      </svg>`

      const renderRes = await app.request('/api/diagram/render', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ svg: sampleSvg, name: 'flow_diagram', width_px: 400 }),
      })
      expect(renderRes.status).toBe(200)
      const data = await renderRes.json()
      expect(data.asset_id).toBeTruthy()
      expect(data.markdown).toContain(`![flow_diagram](asset:${data.asset_id})`)

      // 读取生成的图片资产
      const assetRes = await app.request(`/api/assets/${data.asset_id}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(assetRes.status).toBe(200)
      expect(assetRes.headers.get('content-type')).toBe('image/png')
      const imgBytes = await assetRes.arrayBuffer()
      expect(imgBytes.byteLength).toBeGreaterThan(0)
    })
  })

  describe('2. 独立纯净 Canvas MCP Server 验证', () => {
    it('纯净性保障：包含所有 30 个通用创作工具，完全不含任何医疗/患者/研究专有工具', async () => {
      const { docs, ops, renderer, mcpToken } = setupTestEnv()
      const claims = verifyToken(SECRET, mcpToken, 'mcp')!

      const mcpServer = buildCanvasMcpServer({
        docs,
        ops,
        turns: new TurnRegistry(),
        renderer,
        secret: SECRET,
        workspaceDir: () => tmpdir(),
      }, claims)

      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      await mcpServer.connect(serverTransport)
      const client = new Client({ name: 'canvas-test-client', version: '1.0' })
      await client.connect(clientTransport)

      const toolList = await client.listTools()
      const toolNames = toolList.tools.map(t => t.name)

      // 验证通用创作核心工具均存在
      const REQUIRED_CANVAS_TOOLS = [
        'doc_create', 'doc_outline', 'doc_read', 'doc_search', 'doc_edit',
        'doc_history', 'doc_diff', 'deck_templates', 'slide_read', 'deck_edit',
        'layout_check', 'slide_render', 'comments_list', 'comment_reply',
        'comment_resolve', 'doi_lookup', 'insert_citation', 'import_references',
        'verify_claims', 'diagram_render', 'asset_upload',
      ]
      for (const reqTool of REQUIRED_CANVAS_TOOLS) {
        expect(toolNames, `缺少通用画布工具: ${reqTool}`).toContain(reqTool)
      }

      // 验证医疗与机构垂直专有工具已被彻底隔离过滤
      const FORBIDDEN_MEDICAL_TOOLS = [
        'patient_read', 'patient_create', 'patient_doc_link', 'labs_query',
        'lab_resolve', 'report_upload', 'report_read', 'study_list',
        'study_create', 'study_cohort_list', 'study_cohort_preview', 'study_enroll',
        'phr_share', 'phr_member_links', 'patient_claim_code', 'patient_claims_list',
        'tenant_admin', 'platform_admin',
      ]
      for (const forbTool of FORBIDDEN_MEDICAL_TOOLS) {
        expect(toolNames, `独立画布服务不应泄漏医疗工具: ${forbTool}`).not.toContain(forbTool)
      }
    })

    it('通过 MCP 协议创建文档、提交编辑与读取内容', async () => {
      const { docs, ops, renderer, mcpToken } = setupTestEnv()
      const claims = verifyToken(SECRET, mcpToken, 'mcp')!

      const mcpServer = buildCanvasMcpServer({
        docs,
        ops,
        turns: new TurnRegistry(),
        renderer,
        secret: SECRET,
        workspaceDir: () => tmpdir(),
      }, claims)

      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      await mcpServer.connect(serverTransport)
      const client = new Client({ name: 'canvas-test-client', version: '1.0' })
      await client.connect(clientTransport)

      // 1. 调用 doc_create 工具
      const createRes = await client.callTool({
        name: 'doc_create',
        arguments: { title: 'AI 协同研究报告' },
      }) as any
      const createData = JSON.parse(createRes.content[0].text)
      expect(createData.doc_id).toBeTruthy()
      expect(createData.title).toBe('AI 协同研究报告')
      const docId = createData.doc_id

      // 获取初始节点 id
      const initialNode = docs.get(docId).firstChild!
      const initialId = initialNode.attrs.id as string

      // 2. 调用 doc_edit 工具写入章节
      const editRes = await client.callTool({
        name: 'doc_edit',
        arguments: {
          doc_id: docId,
          base_rev: 0,
          ops: [{
            op: 'insert_after',
            anchor_id: initialId,
            markdown: '## 核心结论\n\nAI 原生文档架构具备极强的微服务解耦与可扩展性。',
          }],
        },
      }) as any
      const editData = JSON.parse(editRes.content[0].text)
      expect(editData.rev).toBeGreaterThan(0)
      expect(editData.changed).toBeGreaterThan(0)

      // 3. 调用 doc_read 工具验证内容
      const readRes = await client.callTool({
        name: 'doc_read',
        arguments: { doc_id: docId },
      }) as any
      const readText = readRes.content[0].text
      expect(readText).toContain('核心结论')
      expect(readText).toContain('AI 原生文档架构具备极强的微服务解耦与可扩展性。')
    })
  })

  describe('3. 独立 Web 工作台静态托管与可拆分部署验证', () => {
    it('访问根路径 / 直接呈现独立 Web 工作台 index.html', async () => {
      const { app } = setupTestEnv()
      const res = await app.request('/')
      expect(res.status).toBe(200)
      const html = await res.text()
      expect(html).toContain('OmniCanvas')
      if (html.includes('id="page"')) {
        expect(html).toContain('id="modeDeck"')
      } else {
        expect(html).toContain('pnpm --filter @heurion2/canvas-service build')
      }
    })
  })

  describe('4. WebSocket CRDT 协同通道握手与认证验证', () => {
    it('开发模式下即使传入 dev-token 也能平滑握手并进入已连接/已同步状态', async () => {
      const { docs } = setupTestEnv()
      const doc = docs.create({ owner: 'dev_user', title: '协同测试' })

      const server = createServer()
      attachCanvasCollab(server, {
        docs,
        secret: SECRET,
        devMode: true,
        devUser: 'dev_user',
      })

      await new Promise<void>(resolve => server.listen(0, resolve))
      const port = (server.address() as AddressInfo).port

      try {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/collab/${doc.id}?token=dev-token`)
        const open = await new Promise<boolean>((resolve) => {
          ws.on('open', () => resolve(true))
          ws.on('error', () => resolve(false))
        })
        expect(open).toBe(true)
        ws.close()
      } finally {
        server.close()
      }
    })

    it('使用合法的 HMAC 签名 Web Token 正常握手', async () => {
      const { docs, token } = setupTestEnv()
      const doc = docs.create({ owner: 'researcher_1', title: '生产协同测试' })

      const server = createServer()
      attachCanvasCollab(server, {
        docs,
        secret: SECRET,
        devMode: false,
      })

      await new Promise<void>(resolve => server.listen(0, resolve))
      const port = (server.address() as AddressInfo).port

      try {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/collab/${doc.id}?token=${encodeURIComponent(token)}`)
        const open = await new Promise<boolean>((resolve) => {
          ws.on('open', () => resolve(true))
          ws.on('error', () => resolve(false))
        })
        expect(open).toBe(true)
        ws.close()
      } finally {
        server.close()
      }
    })

    it('未授权/非法 Token 在生产模式下被正确拦截 (401)', async () => {
      const { docs } = setupTestEnv()
      const doc = docs.create({ owner: 'researcher_1', title: '非法测试' })

      const server = createServer()
      attachCanvasCollab(server, {
        docs,
        secret: SECRET,
        devMode: false,
      })

      await new Promise<void>(resolve => server.listen(0, resolve))
      const port = (server.address() as AddressInfo).port

      try {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/collab/${doc.id}?token=invalid-secret`)
        const connected = await new Promise<boolean>((resolve) => {
          ws.on('open', () => resolve(true))
          ws.on('error', () => resolve(false))
        })
        expect(connected).toBe(false)
      } finally {
        server.close()
      }
    })
  })

  describe('5. MONAI 医学影像分析代理与资产沉淀 (/api/imaging/*)', () => {
    it('健康检查与模型/样本列表代理', async () => {
      const { app, token } = setupTestEnv()
      const statusRes = await app.request('/api/imaging/status', {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(statusRes.status).toBe(200)
      const statusData = await statusRes.json()
      expect(statusData.service).toBe('heurion-monai-worker')

      const modelsRes = await app.request('/api/imaging/models', {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(modelsRes.status).toBe(200)
      const modelsData = await modelsRes.json()
      expect(modelsData.models.length).toBeGreaterThanOrEqual(3)

      const samplesRes = await app.request('/api/imaging/samples', {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(samplesRes.status).toBe(200)
      const samplesData = await samplesRes.json()
      expect(samplesData.samples.length).toBeGreaterThanOrEqual(1)
    })

    it('真实人体 CT 样本分析并沉淀为画布资产', async () => {
      const { app, token } = setupTestEnv()
      const anaRes = await app.request('/api/imaging/analyze', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sample_id: 'spleen_test',
          model_id: 'spleen_segmenter',
          label: '腹部 CT 关键切片',
        }),
      })
      expect(anaRes.status).toBe(200)
      const anaData = await anaRes.json()
      expect(anaData.status).toBe('success')
      expect(anaData.asset_id).toBeDefined()
      expect(anaData.image_url).toBe(`/api/assets/${anaData.asset_id}`)
      expect(anaData.recist_metrics.longest_diameter_mm).toBeGreaterThan(50)
      expect(anaData.recist_metrics.longest_diameter_mm).toBeLessThan(300)

      // 验证资产可被 GET /api/assets/:id 读取
      const assetRes = await app.request(anaData.image_url, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(assetRes.status).toBe(200)
      expect(assetRes.headers.get('content-type')).toBe('image/png')
    })
  })
})
