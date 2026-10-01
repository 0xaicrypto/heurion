import { Hono } from 'hono'
import { request } from 'node:http'
import type { DocKind, Store } from '../db.ts'
import { canonicalFileName, type DocFiles } from '../docs/workspace.ts'
import type { HarnessPool } from '../harness/pool.ts'
import { signDocToken, verifyDocToken } from '../literature/token.ts'
import type { Config } from '../config.ts'

/**
 * 最小 WOPI host（#4 spike → S4 编辑面）：让 Collabora CODE 打开/回存我们的文档。
 *
 * 协议面只实现 CODE 依赖的三个入口：
 * - CheckFileInfo   GET  /wopi/files/:docId
 * - GetFile         GET  /wopi/files/:docId/contents
 * - PutFile         POST /wopi/files/:docId/contents
 *
 * 版本守卫映射（DESIGN.md §4.3）：LastModifiedTime = head 版本时间；
 * PutFile 带 X-COOL-WOPI-Timestamp 且与 head 不一致 → 409 {COOLStatusCode:1010}
 * —— 即「用户编辑期间 AI 落了新版本」时由 CODE 弹覆盖/重载询问，用户优先。
 * AI 回合进行中（busy）直接 409，同理。
 *
 * 鉴权：access_token = 按文档签发的 HMAC 令牌（复用 MCP 令牌），token 里绑 docId，
 * 与路径参数双重校验。
 */

/** WOPI 名义文件名（CODE 用扩展名选组件，且要求无路径分隔符）。 */
function wopiFileName(title: string, kind: DocKind): string {
  const base = (title.replace(/\.(docx|pptx)$/i, '').replace(/[/\\]+/g, '_') || 'document').slice(0, 80)
  return `${base}.${kind}`
}

const WOPI_MIME: Record<DocKind, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

/** 从 discovery XML 取某类文档的 urlsrc（按 MIME 匹配 app，取 name="edit" 的 action）。 */
function pickUrlSrc(discoveryXml: string, kind: DocKind): string | null {
  const app = new RegExp(`<app name="${WOPI_MIME[kind]}"[^>]*>([\\s\\S]*?)</app>`, 'i').exec(discoveryXml)
  if (!app) return null
  const action = /<action[^>]*name="edit"[^>]*urlsrc="([^"]+)"/i.exec(app[1]!)
    ?? /urlsrc="([^"]+)"/i.exec(app[1]!)
  return action?.[1] ?? null
}

function fetchXml(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'GET' }, res => {
      const chunks: Buffer[] = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    })
    req.on('error', reject)
    req.end()
  })
}

export interface WopiDeps {
  store: Store
  files: DocFiles
  pool: HarnessPool
  config: Config
}

export function buildWopi(deps: WopiDeps): Hono {
  const { store, files, pool, config } = deps
  const app = new Hono()
  let discoveryCache: { at: number; xml: string } | null = null

  const auth = (docId: string, token: string | undefined): boolean => {
    const from = verifyDocToken(config.secret, token ?? '')
    return from === docId
  }

  const lastModified = (docId: string): string | null =>
    store.getDoc(docId)!.head_seq > 0 ? store.getVersion(docId, store.getDoc(docId)!.head_seq)!.created_at : null

  // CheckFileInfo
  app.get('/wopi/files/:docId', c => {
    const docId = c.req.param('docId')
    const doc = store.getDoc(docId)
    if (!doc || !auth(docId, c.req.query('access_token'))) return c.json({ error: 'unauthorized' }, 401)
    if (doc.head_seq === 0) return c.json({ error: 'no file yet' }, 404)
    const head = store.getVersion(docId, doc.head_seq)!
    return c.json({
      BaseFileName: wopiFileName(doc.title, doc.kind),
      OwnerId: 'heurion',
      UserId: 'dev',
      UserFriendlyName: 'Developer',
      Size: files.readVersion(docId, doc.head_seq).byteLength,
      UserCanWrite: true,
      UserCanNotWriteRelative: true,
      LastModifiedTime: head.created_at,
      PostMessageOrigin: '*',
    })
  })

  // GetFile
  app.get('/wopi/files/:docId/contents', c => {
    const docId = c.req.param('docId')
    const doc = store.getDoc(docId)
    if (!doc || !auth(docId, c.req.query('access_token'))) return c.json({ error: 'unauthorized' }, 401)
    if (doc.head_seq === 0) return c.json({ error: 'no file yet' }, 404)
    const bytes = files.readVersion(docId, doc.head_seq)
    return c.body(Buffer.from(bytes), 200, { 'Content-Type': 'application/octet-stream' })
  })

  // PutFile：用户在编辑面保存 → 落一个用户版本（与 AI 落版同一条投影/审计管线）。
  app.post('/wopi/files/:docId/contents', async c => {
    const docId = c.req.param('docId')
    const doc = store.getDoc(docId)
    if (!doc || !auth(docId, c.req.query('access_token'))) return c.json({ error: 'unauthorized' }, 401)
    if (doc.head_seq === 0) return c.json({ error: 'no file yet' }, 404)
    if (pool.isBusy(docId)) return c.json({ COOLStatusCode: 1010 }, 409)

    // 外部变更检测：编辑期间 head 变了（AI 落版/回滚）→ 让 CODE 问用户。
    const sent = c.req.header('X-COOL-WOPI-Timestamp') ?? c.req.header('X-LOOL-WOPI-Timestamp')
    const current = lastModified(docId)!
    if (sent && !Number.isNaN(Date.parse(sent)) && sent !== current) {
      return c.json({ COOLStatusCode: 1010 }, 409)
    }

    const bytes = new Uint8Array(await c.req.arrayBuffer())
    if (bytes.length === 0) return c.json({ error: 'empty body' }, 400)
    const version = files.saveUserSave(docId, bytes, '编辑保存')
    return c.body(null, 200, { 'X-COOL-WOPI-Timestamp': version.created_at, 'X-HEURION-VERSION': String(version.seq) })
  })

  // 编辑面 URL 组装（前端 iframe 用）：发现文档 + WOPISrc + 按文档令牌。
  app.get('/api/docs/:id/editor', async c => {
    const docId = c.req.param('id')
    const doc = store.getDoc(docId)
    if (!doc) return c.json({ error: 'not found' }, 404)
    if (doc.head_seq === 0) return c.json({ error: 'no file yet' }, 409)
    if (!discoveryCache || Date.now() - discoveryCache.at > 60 * 60_000) {
      try {
        discoveryCache = { at: Date.now(), xml: await fetchXml(`${config.collaboraUrl}/hosting/discovery`) }
      } catch {
        return c.json({ error: 'collabora 不可达：请先启动 CODE 容器（见 docs/SPIKE_COLLABORA.md）' }, 502)
      }
    }
    const urlsrc = pickUrlSrc(discoveryCache.xml, doc.kind)
    if (!urlsrc) return c.json({ error: 'discovery 中没有该类型的 urlsrc' }, 502)
    // CODE 广播的是它在网络里的自身地址（如 heurion2-collabora:9980）——
    // iframe 是浏览器加载的，重写成浏览器可达的地址。
    const browserUrlsrc = urlsrc.replace(/^https?:\/\/[^/]+/, config.collaboraBrowserUrl)
    return c.json({
      urlsrc: browserUrlsrc,
      access_token: signDocToken(config.secret, docId),
      wopisrc: `${config.publicUrl}/wopi/files/${docId}`,
    })
  })

  return app
}
