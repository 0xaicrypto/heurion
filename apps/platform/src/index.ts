import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { getRequestListener } from '@hono/node-server'
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
const turns = new TurnService(docs, pool, registry)

const mcpDeps = {
  docs, ops, turns: registry, secret: config.secret,
  pubmed: new PubMedClient(fetch, config.ncbiApiKey, config.contactEmail),
  crossref: new CrossrefClient(fetch, config.contactEmail),
  workspaceDir: (userId: string) => pool.workspaceDir(userId),
}

const app = buildApi({ docs, ops, turns, devToken: config.devToken, devUser: config.devUser })
const page = readFileSync(new URL('./web/index.html', import.meta.url), 'utf8')
app.get('/', c => c.html(page))
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

server.listen(config.port, () => {
  console.log(`heurion platform on http://127.0.0.1:${config.port}`)
  if (!config.deepseekApiKey) console.warn('DEEPSEEK_API_KEY 未设置：AI 回合会失败')
})

const shutdown = async () => {
  server.close()
  await pool.closeAll()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
