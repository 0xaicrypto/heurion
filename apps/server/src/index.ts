import { createServer } from 'node:http'
import { relative } from 'node:path'
import { getRequestListener } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { config } from './config.ts'
import { Store } from './db.ts'
import { TurnService } from './docs/turn.ts'
import { DocFiles } from './docs/workspace.ts'
import { HarnessPool } from './harness/pool.ts'
import { CrossrefClient } from './literature/crossref.ts'
import { handleMcpRequest } from './literature/mcp.ts'
import { PubMedClient } from './literature/pubmed.ts'
import { buildApi } from './routes/api.ts'

const store = new Store(config.dbPath)
const files = new DocFiles(store, config.workspacesDir, config.versionsDir)
const pool = new HarnessPool(config, id => files.workspaceDir(id))
const turns = new TurnService(store, files, pool)
const literature = {
  store,
  pubmed: new PubMedClient(fetch, config.ncbiApiKey, config.contactEmail),
  crossref: new CrossrefClient(fetch, config.contactEmail),
  secret: config.secret,
}
const app = buildApi({ store, files, pool, turns, devToken: config.devToken })
// 容器里由 server 直接托管前端构建产物（WEB_DIST）；本地开发走 vite dev server。
if (process.env.WEB_DIST) app.use('*', serveStatic({ root: relative(process.cwd(), process.env.WEB_DIST) }))
const api = getRequestListener(app.fetch)

// /mcp 给 dsh 进程回连（Node 原生 req/res，MCP SDK 的 transport 需要）；其余交给 Hono。
const server = createServer((req, res) => {
  if (req.url?.startsWith('/mcp')) {
    res.on('finish', () => console.log(`[mcp] ${req.method} ${res.statusCode}`))
    handleMcpRequest(literature, req, res).catch(err => {
      if (!res.headersSent) res.writeHead(500).end(String(err))
    })
    return
  }
  void api(req, res)
})

server.listen(config.port, () => {
  console.log(`heurion2 server on http://127.0.0.1:${config.port}`)
  if (!config.deepseekApiKey) console.warn('DEEPSEEK_API_KEY 未设置：AI 回合会失败')
  if (!config.primaryRuntime) console.warn('DSH_PRIMARY_RUNTIME 未设置：office 技能未加载（见 docs/DESIGN.md §5）')
})

const shutdown = async () => {
  server.close()
  await pool.closeAll()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
