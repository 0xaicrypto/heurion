import { FastifyInstance } from 'fastify'
import { authGuard } from '../../common/auth.guard'
import { getUserContext } from '../shared/user-context.js'
import { memoryImportSchema } from '../shared/chat.dto.js'


export async function chatRouter(app: FastifyInstance) {
  app.addHook('preHandler', authGuard)

  // #6: Memory export
  app.get('/api/v1/memory/export', async (request, reply) => {
    const ctx = getUserContext(request.user!.userId)
    reply.header('Content-Type', 'application/json')
    reply.header('Content-Disposition', 'attachment; filename="heurion-memory.json"')
    return {
      exported_at: new Date().toISOString(),
      facts: ctx.facts.all(),
      episodes: ctx.episodes.all(),
      skills: ctx.skills.all(),
      event_log_count: ctx.eventLog.count(),
    }
  })

  // #6: Memory import
  // #839 白名单例外(唯一登记的直写点):用户显式批量迁移自有数据,走闸门
  // 会以数百条 pending 淹没审核队列;dedup 由导入方数据自洽保证。
  app.post('/api/v1/memory/import', async (request, reply) => {
    const ctx = getUserContext(request.user!.userId)
    // #349: zod-validated import payload.
    const parsed = memoryImportSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: `Invalid import: ${parsed.error.issues[0]?.message || 'validation failed'}` })
    }
    const data = parsed.data
    let imported = 0
    if (data.facts && Array.isArray(data.facts)) {
      for (const f of data.facts) {
        ctx.memory.addFact(
          {
            content: f.content,
            category: f.category,
            importance: f.importance,
            sourceType: f.sourceType,
            patientHash: f.patientHash,
            studyId: f.studyId,
          },
          'import',
        )
        imported++
      }
    }
    if (data.episodes && Array.isArray(data.episodes)) {
      for (const e of data.episodes) { ctx.episodes.upsert(e.sessionId || '', e.summary || '', e.turnCount || 0); imported++ }
    }
    ctx.facts.commit()
    ctx.episodes.commit()
    return { imported, facts_count: ctx.facts.all().length, episodes_count: ctx.episodes.all().length }
  })
}

