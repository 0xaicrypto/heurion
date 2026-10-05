import { createServer } from 'node:http'
import { join } from 'node:path'
import { Store } from '@heurion2/platform/src/store/db.ts'
import { Documents } from '@heurion2/platform/src/model/runtime.ts'
import { OpService } from '@heurion2/platform/src/ops/service.ts'
import { SlideRenderer } from '@heurion2/platform/src/render/slides.ts'
import { PubMedClient } from '@heurion2/platform/src/literature/pubmed.ts'
import { CrossrefClient } from '@heurion2/platform/src/literature/crossref.ts'
import { OpenAlexClient } from '@heurion2/platform/src/literature/openalex.ts'
import { buildCanvasHandler } from './app.ts'
import { attachCanvasCollab } from './collab.ts'

const PORT = parseInt(process.env.CANVAS_PORT || process.env.PORT || '8888', 10)
const DB_PATH = process.env.CANVAS_DB_PATH || join(process.cwd(), 'canvas.db')
const SECRET = process.env.AUTH_SECRET || process.env.SECRET || 'omnicanvas-standalone-dev-secret'
const DEV_MODE = process.env.NODE_ENV !== 'production'
const DEV_USER = process.env.DEV_USER || 'editor'

const store = new Store(DB_PATH)
const docs = new Documents(store)
const ops = new OpService(docs)
const renderer = new SlideRenderer(join(process.cwd(), '.canvas-render-cache'))
const pubmed = new PubMedClient(fetch, process.env.NCBI_API_KEY, process.env.CONTACT_EMAIL)
const crossref = new CrossrefClient(fetch, process.env.CONTACT_EMAIL)
const openalex = new OpenAlexClient(fetch, process.env.CONTACT_EMAIL)

const handler = buildCanvasHandler({
  store,
  docs,
  ops,
  renderer,
  secret: SECRET,
  devMode: DEV_MODE,
  devUser: DEV_USER,
  pubmed,
  crossref,
  openalex,
})

const server = createServer(handler)
attachCanvasCollab(server, { docs, secret: SECRET, devMode: DEV_MODE, devUser: DEV_USER })

server.listen(PORT, () => {
  console.log(`
┌─────────────────────────────────────────────────────────────┐
│  🎨 OmniCanvas / AgentDoc AI Native Standalone Service      │
├─────────────────────────────────────────────────────────────┤
│  REST API:      http://localhost:${PORT}/api                  │
│  MCP Endpoint:  http://localhost:${PORT}/mcp                  │
│  CRDT Collab:   ws://localhost:${PORT}/collab/:docId          │
│  Health Check:  http://localhost:${PORT}/health               │
│  Storage:       ${DB_PATH.padEnd(44)}│
└─────────────────────────────────────────────────────────────┘
  `)
})
