import { existsSync, readFileSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { getRequestListener } from '@hono/node-server'
import { Accounts } from './auth/accounts.ts'
import { createMailer } from './auth/mailer.ts'
import { SearchIndex } from './model/search-index.ts'
import { HttpEmbedder } from './kb/embedder.ts'
import { localOcr } from './kb/ocr.ts'
import { KbService } from './kb/service.ts'
import { MemoryService } from './memory/service.ts'
import { ClaimService } from './claims/service.ts'
import { SlideRenderer } from './render/slides.ts'
import { attachCollab } from './collab/gateway.ts'
import { PostCheck } from './collab/postcheck.ts'
import { config } from './config.ts'
import { HarnessPool } from './harness/pool.ts'
import { buildApi } from './http/api.ts'
import { CrossrefClient } from './literature/crossref.ts'
import { PubMedClient } from './literature/pubmed.ts'
import { handleMcp } from './mcp/server.ts'
import { TurnRegistry } from './mcp/turns.ts'
import { Documents } from './model/runtime.ts'
import { OpService } from './ops/service.ts'
import { Store } from './store/db.ts'
import { TurnService } from './turns/service.ts'

const store = new Store(config.dbPath)
const docs = new Documents(store)
const ops = new OpService(docs)
const registry = new TurnRegistry()
const pool = new HarnessPool(config)
const postcheck = new PostCheck(docs)

const pubmed = new PubMedClient(fetch, config.ncbiApiKey, config.contactEmail)
const crossref = new CrossrefClient(fetch, config.contactEmail)
const claims = new ClaimService(docs, pubmed)
const renderer = new SlideRenderer(config.renderDir)
// 参考资料库：本地嵌入服务（apps/embedder）可选，不在时只用关键词检索
const embedder = config.embeddingUrl ? new HttpEmbedder(config.embeddingUrl) : null
const kb = new KbService(store, embedder, localOcr(resolve(config.dataDir, 'ocr-cache')))
kb.resume()
// 记忆（R3）：相似去重与按相关度注入用同一个嵌入服务，不在时按文本
const memory = new MemoryService(store, embedder)
const turns = new TurnService(docs, pool, registry, { idleTimeoutMs: config.turnIdleTimeoutMs, memory })
const mcpDeps = {
  docs, ops, claims, renderer, turns: registry, secret: config.secret,
  pubmed,
  crossref,
  workspaceDir: (userId: string) => pool.workspaceDir(userId),
  kb,
  memory,
  isLiveSession: (userId: string, generation: string) => pool.isLive(userId, generation),
}

const mailer = createMailer({ resendApiKey: config.resendApiKey, from: config.emailFrom, production: process.env.NODE_ENV === 'production' })
const accounts = new Accounts(store, { secret: config.secret, devMode: config.devMode, devToken: config.devToken, devUser: config.devUser, mailer })
const search = new SearchIndex(docs)
const indexed = search.backfill()
if (indexed) console.log(`全文索引：补齐 ${indexed} 份文档`)
// 回收站：30 天后自动彻底删除（启动时一次，之后每 12 小时）
const purge = () => { for (const id of store.purgeTrash(30)) { docs.unload(id); store.unindexDoc(id) } }
purge()
setInterval(purge, 12 * 3600_000).unref()
const app = buildApi({ docs, ops, turns, postcheck, crossref, renderer, accounts, devMode: config.devMode, devUser: config.devUser, search, kb, memory })

// 页面：web/ 的构建产物（pnpm --filter @heurion2/platform build）；开发时用 vite（dev:web）
const DIST = fileURLToPath(new URL('../dist-web/', import.meta.url))
const MIME: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' }
app.get('/assets/:file', c => {
  const file = join(DIST, 'assets', basename(c.req.param('file')))
  if (!existsSync(file)) return c.notFound()
  return c.body(readFileSync(file), 200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'public, max-age=31536000, immutable' })
})
app.get('/', c => existsSync(join(DIST, 'index.html'))
  ? c.html(readFileSync(join(DIST, 'index.html'), 'utf8'))
  : c.text('页面未构建：运行 pnpm --filter @heurion2/platform build，或用 dev:web 开发服务器（http://127.0.0.1:5173）', 503))
const api = getRequestListener(app.fetch)

// /mcp 用 Node 原生 req/res（MCP SDK transport 需要），其余交给 Hono
const server = createServer((req, res) => {
  if (req.url?.startsWith('/mcp')) {
    handleMcp(mcpDeps, req, res).catch(err => {
      console.error('[mcp]', err)
      if (!res.headersSent) res.writeHead(500).end(String(err))
    })
    return
  }
  void api(req, res)
})

attachCollab(server, { docs, authenticate: token => accounts.userFor(token) })

const restored = turns.restore()
if (restored.interrupted || restored.requeued) console.log(`回合队列：${restored.interrupted} 个中断，${restored.requeued} 个继续排队`)
server.listen(config.port, () => {
  console.log(`heurion platform on http://127.0.0.1:${config.port}`)
  if (!config.deepseekApiKey) console.warn('DEEPSEEK_API_KEY 未设置：AI 回合会失败')
})

const shutdown = async () => {
  docs.flushAll()
  server.close()
  await pool.closeAll()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
