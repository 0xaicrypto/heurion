/**
 * #1101（pptx 字节单一标准）— deck 工件 HTTP 端点（人类保存路径）。
 *
 * 覆盖：GET/POST /api/v1/docs/:docId/deck-artifact —
 * 1. 未认证 → 401；他人 doc → 404（反枚举）。
 * 2. POST round-trip：字节上传 → 工件落 FileIndex → GET 返回同 artifactId
 *    + tokenized download URL → 按 URL 拉回同字节 → Doc.deck 投影已重建。
 * 3. X-Deck-Base 乐观锁：过期基线 → 409。
 * 4. 非法字节 → 400。
 */
import { describe, test, expect, afterAll } from 'vitest'
import { getApp, authHeader, getAuthUserId, registerSecondUser } from './setup.js'

async function getPrisma() {
  const { default: prisma } = await import('../src/common/prisma.js')
  return prisma
}

const createdDocIds: string[] = []

async function createDoc(): Promise<string> {
  const prisma = await getPrisma()
  const userId = await getAuthUserId()
  const id = `doc_${Math.random().toString(16).slice(2, 10).padEnd(16, '0').slice(0, 16)}`
  const now = new Date().toISOString()
  await prisma.doc.create({ data: { id, userId, title: 'Deck artifact test doc', body: '正文', createdAt: now, updatedAt: now } })
  createdDocIds.push(id)
  return id
}

async function samplePptxBytes(title: string): Promise<Buffer> {
  const { serializeDeckWireToPptx } = await import('../src/lib/deck-bytes.js')
  return serializeDeckWireToPptx({
    title,
    slides: [
      { title: '页一', notes: '页一备注', content: [{ type: 'paragraph', text: '页一要点', style: 'bullet' }] },
      { title: '页二', content: [{ type: 'paragraph', text: '页二要点', style: 'normal' }] },
    ],
  })
}

describe('#1101 deck-artifact API', () => {
  afterAll(async () => {
    const prisma = await getPrisma()
    const userId = await getAuthUserId().catch(() => null)
    for (const id of createdDocIds) {
      await prisma.doc.deleteMany({ where: { id } }).catch(() => {})
      if (userId) {
        await prisma.fileIndex.deleteMany({ where: { userId, id: { startsWith: 'deck-' } } }).catch(() => {})
      }
    }
    if (userId) {
      const { uploadsBaseDir } = await import('../src/lib/upload-path.js')
      await import('fs').then((fs) => fs.rmSync(uploadsBaseDir(userId), { recursive: true, force: true }))
    }
  })

  test('未认证 → 401', async () => {
    const app = await getApp()
    const docId = await createDoc()
    const res = await app.inject({ method: 'GET', url: `/api/v1/docs/${docId}/deck-artifact` })
    expect(res.statusCode).toBe(401)
  })

  test('无工件 → 404；他人 doc → 404（反枚举同语义）', async () => {
    const app = await getApp()
    const docId = await createDoc()
    const res = await app.inject({ method: 'GET', url: `/api/v1/docs/${docId}/deck-artifact`, headers: await authHeader() })
    expect(res.statusCode).toBe(404)
    // 他人访问 → 404（不泄露存在性）
    const other = await registerSecondUser()
    const resOther = await app.inject({ method: 'GET', url: `/api/v1/docs/${docId}/deck-artifact`, headers: { authorization: `Bearer ${other.token}` } })
    expect(resOther.statusCode).toBe(404)
    const resOtherPost = await app.inject({ method: 'POST', url: `/api/v1/docs/${docId}/deck-artifact`, headers: { authorization: `Bearer ${other.token}`, 'content-type': 'application/octet-stream' }, payload: Buffer.alloc(10) })
    expect(resOtherPost.statusCode).toBe(404)
  })

  test('POST round-trip：字节上传 → GET 同工件 + download URL 拉回同字节 + 投影重建', async () => {
    const app = await getApp()
    const docId = await createDoc()
    const bytes = await samplePptxBytes('roundtrip')

    // POST 字节（octet-stream）→ 200 { ok, artifact_id, version }
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/docs/${docId}/deck-artifact`,
      headers: { ...await authHeader(), 'content-type': 'application/octet-stream' },
      payload: bytes,
    })
    expect(res.statusCode).toBe(200)
    const data = JSON.parse(res.payload)
    expect(data.ok).toBe(true)
    expect(data.artifact_id).toMatch(/^deck-/)
    // #review-8: 保存响应同步真实页数（投影重建结果）。
    expect(data.slide_count).toBe(2)

    // GET 返回同工件 + download URL + 与工件版本一致的真实页数。
    const resGet = await app.inject({ method: 'GET', url: `/api/v1/docs/${docId}/deck-artifact`, headers: await authHeader() })
    expect(resGet.statusCode).toBe(200)
    const got = JSON.parse(resGet.payload)
    expect(got.artifact_id).toBe(data.artifact_id)
    expect(got.version).toBe(data.version)
    expect(got.slide_count).toBe(2)
    expect(got.download_url).toContain('/api/v1/files/download/')

    // download URL（token，无鉴权头）拉回同字节。
    const resBytes = await app.inject({ method: 'GET', url: got.download_url })
    expect(resBytes.statusCode).toBe(200)
    expect(resBytes.rawPayload.equals(bytes)).toBe(true)

    // 投影已重建（extractor）+ 指针落库。
    const prisma = await getPrisma()
    const doc = await prisma.doc.findUnique({ where: { id: docId } })
    expect(doc!.deckArtifactId).toBe(data.artifact_id)
    const projection = JSON.parse(String(doc!.deck))
    expect(projection.slides).toHaveLength(2)
  })

  test('X-Deck-Base 乐观锁：过期基线 → 409；匹配基线 → 200', async () => {
    const app = await getApp()
    const docId = await createDoc()
    const bytes = await samplePptxBytes('lock')
    const first = await app.inject({
      method: 'POST', url: `/api/v1/docs/${docId}/deck-artifact`,
      headers: { ...await authHeader(), 'content-type': 'application/octet-stream' }, payload: bytes,
    })
    const version = JSON.parse(first.payload).version

    // 过期基线（服务端工件已推进）→ 409。
    const bytesV2 = await samplePptxBytes('lock-v2')
    const stale = await app.inject({
      method: 'POST', url: `/api/v1/docs/${docId}/deck-artifact`,
      headers: { ...await authHeader(), 'content-type': 'application/octet-stream', 'x-deck-base': 'deck-stale-1.pptx' },
      payload: bytesV2,
    })
    expect(stale.statusCode).toBe(409)

    // 同版本再传不同字节（内容变化）→ 新工件（version 随内容推进）。
    const second = await app.inject({
      method: 'POST', url: `/api/v1/docs/${docId}/deck-artifact`,
      headers: { ...await authHeader(), 'content-type': 'application/octet-stream', 'x-deck-base': version },
      payload: bytesV2,
    })
    expect(second.statusCode).toBe(200)
    expect(JSON.parse(second.payload).artifact_id).not.toBe(version)
  })

  test('非法字节 → 400（真相源纪律：垃圾不入库）', async () => {
    const app = await getApp()
    const docId = await createDoc()
    const res = await app.inject({
      method: 'POST', url: `/api/v1/docs/${docId}/deck-artifact`,
      headers: { ...await authHeader(), 'content-type': 'application/octet-stream' },
      payload: Buffer.from('not a pptx at all'),
    })
    expect(res.statusCode).toBe(400)
    const prisma = await getPrisma()
    const doc = await prisma.doc.findUnique({ where: { id: docId } })
    expect(doc!.deckArtifactId).toBeNull()
  })

  // #1101 §5: 工件上传后创建 deck_slide 评论 → create 流程解析 pptx 原生
  // shapeId（findText 首个命中 elementId）落库并随序列化带出。
  test('工件在场创建 deck_slide 评论 → anchorShapeId 解析落库', async () => {
    const app = await getApp()
    const docId = await createDoc()
    const bytes = await samplePptxBytes('anchor')
    const put = await app.inject({
      method: 'POST', url: `/api/v1/docs/${docId}/deck-artifact`,
      headers: { ...await authHeader(), 'content-type': 'application/octet-stream' }, payload: bytes,
    })
    expect(put.statusCode).toBe(200)

    const created = await app.inject({
      method: 'POST', url: `/api/v1/docs/${docId}/comments`,
      headers: { ...(await authHeader()), 'content-type': 'application/json' },
      payload: JSON.stringify({ target: 'deck_slide', slide_index: 1, anchor_text: '页一要点', text: '这页要补充数据来源' }),
    })
    expect(created.statusCode).toBe(201)
    const comment = JSON.parse(created.payload)
    // elementId = part path + shape 序位（spike #1102 实测的稳定标识形状）
    expect(comment.anchor_shape_id).toMatch(/^ppt\/slides\/slide\d+\.xml-shape-\d+$/)

    // 落库持久化
    const prisma = await getPrisma()
    const row = await prisma.docComment.findUnique({ where: { id: comment.id } })
    expect(row?.anchorShapeId).toBe(comment.anchor_shape_id)
  })
})
