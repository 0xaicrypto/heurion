import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import Fastify from 'fastify'
import fastifyCors from '@fastify/cors'
import fastifyMultipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import { existsSync, readFileSync } from 'fs'
import { config } from './config.js'
import { authRouter } from './modules/auth/auth.router.js'
import { chatRouter } from './modules/chat/chat.router.js'
import { agentRouter } from './modules/chat/agent.router.js'
import { sessionRouter } from './modules/chat/session.router.js'
import { patientsRouter } from './modules/patients/patients.router.js'
import { researchRouter } from './modules/research/research.router.js'
import { submissionRouter } from './modules/submission/submission.router.js'
import { mcpAdminRouter } from './modules/settings/mcp-admin.router.js'
import { documentsRouter } from './modules/documents/documents.router.js'
// #1101（pptx 字节单一标准）：deck pptx 工件 HTTP 端点（人类保存路径）。
import { deckArtifactRouter } from './modules/documents/deck-artifact.router.js'
// #1039: 写作编辑器评论线程（sidecar 旁路表 + 锚点漂移诊断）。
import { commentsRouter } from './modules/comments/comments.router.js'
import { referencesRouter } from './modules/references/references.router.js'
import { citationsRouter } from './modules/citations/citations.router.js'
import { skillsRouter } from './modules/skills/skills.router.js'
import { settingsRouter } from './modules/settings/settings.router.js'
import { filesRouter } from './modules/files/files.router.js'
import { adminRouter } from './modules/admin/admin.router.js'
import { calendarRouter } from './modules/calendar/calendar.router.js'
import { medicalRecordsRouter } from './modules/medical-records/medical-records.router.js'
import { medicalRecordEntriesRouter } from './modules/medical-records/medical-record-entries.router.js'
import { approvalsRouter } from './modules/approvals/approvals.router.js'
import { ingestionRouter } from './modules/ingestion/ingestion.router.js'
import { brainRouter } from './modules/brain/brain.router.js'
import './modules/ingestion/analyzers/index.js'
import { stubRouter } from './modules/stubs/stubs.router.js'
import { knowledgeRouter } from './modules/knowledge/knowledge.router.js'
import { knowledgeStoresRouter } from './modules/knowledge/knowledge-stores.router.js'
import { figuresRouter } from './modules/figures/figures.router.js'
import { reportRouter } from './modules/report/report.router.js'
import { executionRouter } from './modules/execution/execution.router.js'
import { pluginsRouter } from './modules/plugins/plugins.router.js'
import { externalRouter } from './modules/external/external.router.js'
import { PrismaTelemetryService } from './modules/knowledge/telemetry.service.js'
import { setLlmTelemetryService } from './common/llm.js'
import {
  createDefaultEvolutionQueue,
  type EvolutionQueue,
} from './modules/evolution/evolution.queue.js'
import { processEvolutionTurn } from './modules/evolution/evolution.worker.js'
import { evolutionRouter } from './modules/evolution/evolution.router.js'
import { workflowsRouter } from './modules/workflows/workflows.router.js'
import { memorizationRouter } from './modules/memorization/memorization.router.js'
import { practitionerRouter } from './modules/practitioner/practitioner.router.js'
import { releaseRequestScope, requestScopes, runWithRequestScope } from './common/request-context.js'
import { mapErrorToHttp } from './common/error-mapping.js'
import { releaseUserContext } from './modules/shared/user-context.js'

export interface AppOptions {
  evolutionQueue?: EvolutionQueue
}

export async function createApp(opts: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: true })

  // ── Wire up LLM cost telemetry once per process ──
  setLlmTelemetryService(new PrismaTelemetryService())

  // ── Evolution queue (BullMQ/Redis in prod, in-memory in tests/offline) ──
  const evolutionQueue = opts.evolutionQueue ?? (await createDefaultEvolutionQueue())
  evolutionQueue.setProcessor?.(processEvolutionTurn)

  // #1146: 请求级作用域 — requestId 关联日志;contextRefs 记录本请求取用的
  // user-context(长回合跨 TTL 不被 GC 驱逐,避免新旧 EventLog 双写)。
  app.addHook('onRequest', (request, _reply, done) => {
    const scope = { requestId: request.id, contextRefs: new Set<string>() }
    requestScopes.set(request, scope)
    // #1150-followup: 客户端中途断开(SSE 取消/网络断)时 onResponse 不触发,
    // 仅靠它释放会让该用户的 context 引用计数永不归零 → 永不 GC。
    // raw close 与 onResponse 共用幂等释放。
    const releaseOnce = () => {
      releaseRequestScope(scope, releaseUserContext)
      requestScopes.delete(request)
    }
    request.raw.on('close', releaseOnce)
    runWithRequestScope(scope, done)
  })
  app.addHook('onResponse', (request, _reply, done) => {
    const scope = requestScopes.get(request)
    if (scope) {
      releaseRequestScope(scope, releaseUserContext)
      requestScopes.delete(request)
    }
    done()
  })

  // ── Global error handler ──
  // #1155: 映射规则集中到 common/error-mapping（可单测）— 4xx/领域错误 →
  // 原状态码;5xx 记录日志并回通用文案(不回传内部细节)。
  app.setErrorHandler((err: Error, req: FastifyRequest, reply: FastifyReply) => {
    const mapped = mapErrorToHttp(err)
    if (mapped) return reply.status(mapped.status).send(mapped.body)
    req.log.error({ err }, 'unhandled server error')
    return reply.status(500).send({ error: 'Internal server error' })
  })

  // ── Plugins ──
  await app.register(fastifyCors, { origin: config.corsAllowOrigins, credentials: true })
  await app.register(fastifyMultipart, { limits: { fileSize: 100 * 1024 * 1024 } })

  // ── Health + Config ──
  app.get('/healthz', async () => 'ok')
  app.get('/api/v1/config', async () => ({
    appName: 'Heurion', apiVersion: 1, minClientApiVersion: 1, billingEnabled: false,
  }))

  // ── Routes ──
  await app.register(authRouter)
  await app.register(sessionRouter)
  await app.register(agentRouter, { evolutionQueue })
  await app.register(chatRouter)
  await app.register(researchRouter)
  await app.register(submissionRouter)
  await app.register(mcpAdminRouter)
  await app.register(documentsRouter)
  await app.register(deckArtifactRouter)
  await app.register(commentsRouter)
  await app.register(referencesRouter)
  await app.register(citationsRouter)
  await app.register(skillsRouter)
  await app.register(settingsRouter)
  await app.register(filesRouter)
  await app.register(adminRouter)
  await app.register(calendarRouter)
  await app.register(patientsRouter)
  await app.register(medicalRecordEntriesRouter)
  await app.register(approvalsRouter)
  await app.register(ingestionRouter)
  await app.register(brainRouter)
  await app.register(medicalRecordsRouter)
  await app.register(knowledgeRouter)
  await app.register(knowledgeStoresRouter)
  await app.register(figuresRouter)
  await app.register(evolutionRouter, { evolutionQueue })
  await app.register(stubRouter)
  await app.register(reportRouter)
  await app.register(pluginsRouter)
  await app.register(executionRouter)
  await app.register(externalRouter)
  await app.register(workflowsRouter)
  await app.register(memorizationRouter)
  await app.register(practitionerRouter)

  // ── Serve web frontend for local/dev/testing (SPA fallback on non-/api routes) ──
  const webDistDir = process.env.WEB_DIST_DIR || './web-dist'
  const resolvedDistDir = webDistDir.startsWith('/') ? webDistDir : require('path').resolve(webDistDir)
  if (existsSync(resolvedDistDir)) {
    // #530: VitePress 用户指南目录(/docs) — 无尾斜杠直接 302,避免
    // SPA fallback 把 /docs 渲染成 web 首页。
    await app.get('/docs', async (_req: any, reply: any) => {
      reply.redirect('/docs/')
    })
    await app.register(fastifyStatic, {
      root: resolvedDistDir,
      prefix: '/',
      wildcard: false,
      // Rolling-deploy safety: the HTML entry must never be cached (a stale
      // HTML referencing a since-removed hashed bundle 404s the app for the
      // whole cache lifetime). Hashed assets are immutable by content.
      setHeaders: (res: any, path: string) => {
        if (path.endsWith('.html')) {
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
        } else if (path.includes('/assets/')) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
        } else if (path.includes('/partners/')) {
          // #534-followup: 品牌 logo 会随合作伙伴调整而增删 — 短缓存,
          // 避免 CDN/浏览器缓存已删除的旧文件(broken link)。
          res.setHeader('Cache-Control', 'public, max-age=600')
        }
      },
    })
    app.setNotFoundHandler((req: FastifyRequest, reply: FastifyReply) => {
      const url = req.url.split('?')[0]
      // Assets must 404 (never SPA-fallback): a stale/cached HTML response
      // served as "application/javascript" breaks module loading for days.
      if (url.startsWith('/assets/') || url.startsWith('/api/') || url.startsWith('/healthz')) {
        reply.status(404).send({ error: 'Not found' })
      } else {
        reply.header('Content-Type', 'text/html')
        reply.header('Cache-Control', 'no-cache, no-store, must-revalidate')
        reply.send(readFileSync(`${resolvedDistDir}/index.html`, 'utf-8'))
      }
    })
  }

  return app
}
