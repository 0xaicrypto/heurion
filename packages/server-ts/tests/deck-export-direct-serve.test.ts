/**
 * #1101(b) — PPT 导出直出字节工件（所见即所导）。
 *
 * organizedExport（organize=true + 无 slides）在有可读 deckArtifactId 时：
 *   - 跳过 pptxgenjs 重渲 / runRenderJob（plane.enqueue 零调用）；
 *   - 下载卡片直指工件 tokenized URL（deck-artifact.router 同款 issueChartToken）；
 *   - file.fileId = 工件 id，按 URL 拉回字节 === 落库工件字节（富编辑内容保留）；
 *   - 无工件（指针悬空）→ 落回 DeckWire 重渲路径（enqueue 照常）。
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockAiProvider } from './helpers/ai-mock.js'
import { getApp, authHeader, getAuthUserId } from './setup.js'
import { InsertAssetTool } from '../src/tools/insert-asset-tool.js'
import prisma from '../src/common/prisma.js'

vi.mock('../src/common/llm.js', () => mockAiProvider())

beforeEach(() => { vi.stubEnv('DEEPSEEK_API_KEY', 'test-key') })
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

function fakePlane() {
  return {
    enqueue: vi.fn(async () => ({ job_id: 'j1', status: 'pending' })),
    getStatus: vi.fn(async () => ({ job_id: 'j1', status: 'completed', result: { file_id: 'f1', file_name: 'out.pptx' } })),
    fetchFile: vi.fn(async () => Buffer.from('PK\x03\x04fake-pptx')),
  }
}

async function sampleArtifactBytes(): Promise<Buffer> {
  const { serializeDeckWireToPptx } = await import('../src/lib/deck-bytes.js')
  return serializeDeckWireToPptx({
    title: '直出 deck（富编辑后）',
    slides: [
      { title: '页一', notes: '', content: [{ type: 'paragraph', text: '富编辑后的要点内容', style: 'bullet' }] },
      { title: '页二', notes: '', content: [{ type: 'paragraph', text: '第二页数据', style: 'normal' }] },
    ],
  })
}

const createdDocIds: string[] = []

async function createDocWithArtifact(): Promise<{ docId: string; artifactId: string; bytes: Buffer }> {
  const app = await getApp()
  const userId = await getAuthUserId()
  const res = await app.inject({
    method: 'POST', url: '/api/v1/docs',
    headers: { ...(await authHeader()), 'content-type': 'application/json' },
    payload: { title: '直出导出测试' },
  })
  const docId = JSON.parse(res.payload).id
  await app.inject({
    method: 'PUT', url: `/api/v1/docs/${docId}`,
    headers: { ...(await authHeader()), 'content-type': 'application/json' },
    payload: { body: '# 论文\n\n正文内容，不是 slides。' },
  })
  createdDocIds.push(docId)
  const { putDeckArtifact } = await import('../src/lib/deck-bytes.js')
  const bytes = await sampleArtifactBytes()
  const put = await putDeckArtifact({ userId, docId, bytes })
  if (put.conflict || put.error) throw new Error(`putDeckArtifact failed: ${put.error}`)
  return { docId, artifactId: put.artifactId, bytes }
}

describe('#1101(b) export organize=true 工件直出', () => {
  afterEach(async () => {
    const userId = await getAuthUserId().catch(() => null)
    for (const id of createdDocIds.splice(0)) {
      await prisma.doc.deleteMany({ where: { id } }).catch(() => {})
    }
    if (userId) {
      await prisma.fileIndex.deleteMany({ where: { userId, id: { startsWith: 'deck-' } } }).catch(() => {})
      const { uploadsBaseDir } = await import('../src/lib/upload-path.js')
      const fs = await import('fs')
      fs.rmSync(uploadsBaseDir(userId), { recursive: true, force: true })
    }
  })

  test('工件在场 → 直出字节（不 enqueue 渲染），URL 拉回字节 === 工件字节', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const { docId, artifactId, bytes } = await createDocWithArtifact()
    const plane = fakePlane()

    const result = await new InsertAssetTool({ userId, sessionId: `doc-${docId}`, executionPlane: plane, isPluginInstalled: async () => true })
      .execute({ asset_type: 'export', format: 'pptx', organize: true })

    expect(result.success).toBe(true)
    // 直出：零渲染任务。
    expect(plane.enqueue).not.toHaveBeenCalled()
    expect(plane.fetchFile).not.toHaveBeenCalled()

    const { body: newBody, summary, file } = JSON.parse(result.output as string)
    // 下载卡片直指工件 tokenized URL（deck-artifact.router 同款形状）。
    expect(file.fileId).toBe(artifactId)
    expect(file.mimeType).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation')
    expect(file.url).toBe(`/api/v1/files/download/${artifactId}?token=` + file.url.split('token=')[1])
    expect(file.url).toContain(`/api/v1/files/download/${artifactId}?token=`)
    expect(newBody).toContain(`[下载 PPT 版（${file.fileName}）](${file.url})`)
    expect(summary).toContain('已从 deck 导出 PPT')
    expect(summary).toContain('直出工件')

    // 按 URL（token，无鉴权头）拉回字节 === 落库工件字节（所见即所导）。
    const resBytes = await app.inject({ method: 'GET', url: file.url })
    expect(resBytes.statusCode).toBe(200)
    expect(resBytes.rawPayload.equals(bytes)).toBe(true)

    // 卡片已写回草稿持久层。
    const doc = await prisma.doc.findFirst({ where: { id: docId, userId } })
    expect(doc?.body).toContain(`[下载 PPT 版（${file.fileName}）](${file.url})`)
  }, 30000)

  test('工件指针悬空（不可读）→ 落回 DeckWire 重渲路径', async () => {
    const app = await getApp()
    const userId = await getAuthUserId()
    const docId = JSON.parse((await app.inject({
      method: 'POST', url: '/api/v1/docs',
      headers: { ...(await authHeader()), 'content-type': 'application/json' },
      payload: { title: '直出回退测试' },
    })).payload).id
    createdDocIds.push(docId)
    // 有 deck 投影 + 悬空工件指针（FileIndex 行不存在 → getDeckArtifact null）。
    await prisma.doc.update({
      where: { id: docId },
      data: {
        deck: JSON.stringify({
          schemaVersion: 1,
          title: '投影 deck',
          slides: [{ title: '手动改过的页', content: [{ type: 'paragraph', text: 'deck 内容', style: 'bullet' }] }],
        }),
        deckArtifactId: 'deck-missing-artifact.pptx',
      },
    })
    const plane = fakePlane()

    const result = await new InsertAssetTool({ userId, sessionId: `doc-${docId}`, executionPlane: plane, isPluginInstalled: async () => true })
      .execute({ asset_type: 'export', format: 'pptx', organize: true })

    // 回退 legacy：DeckWire 为内容源 → 渲染任务照常 enqueue。
    expect(result.success).toBe(true)
    expect(plane.enqueue).toHaveBeenCalledWith(expect.objectContaining({ type: 'sidecar.generate_pptx' }))
    const payload = (plane.enqueue as any).mock.calls[0][0].payload
    expect(payload.data.title).toBe('投影 deck')
    const { file } = JSON.parse(result.output as string)
    expect(file.fileId).not.toBe('deck-missing-artifact.pptx')
  }, 30000)
})
