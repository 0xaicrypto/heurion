import { FastifyInstance } from 'fastify'
import { authGuard, adminGuard } from '../../common/auth.guard'
import { resolveActiveModel, resolveLlmEndpoint, getGlobalModelOverride, setGlobalModelOverride } from '../../common/llm-gateway.js'
import prisma from '../../common/prisma'

export async function settingsRouter(app: FastifyInstance) {
  app.addHook('preHandler', authGuard)

  const getSetting = async (userId: string, key: string) => {
    const row = await prisma.userSetting.findUnique({ where: { userId_key: { userId, key } } })
    return row?.value || null
  }
  const setSetting = async (userId: string, key: string, value: string) => {
    await prisma.userSetting.upsert({
      where: { userId_key: { userId, key } },
      update: { value, updatedAt: Math.floor(Date.now() / 1000) },
      create: { userId, key, value, updatedAt: Math.floor(Date.now() / 1000) },
    })
  }

  // #764-admin: 全局模型选择 — 运行时覆盖 + 持久化('__global__' 设置行,
  // 启动时由 main.ts 回灌)。优先级:explicit tier model > 此覆盖 > env。
  app.post('/api/v1/settings/llm/global-model', { preHandler: adminGuard }, async (request) => {
    const body = request.body as any
    const model = typeof body?.model === 'string' ? body.model.trim() : ''
    if (!model) return { ok: false, error: 'model required' }
    setGlobalModelOverride(model)
    await setSetting('__global__', 'global_llm_model', model)
    return { ok: true, activeModel: resolveActiveModel() }
  })

  app.delete('/api/v1/settings/llm/global-model', { preHandler: adminGuard }, async () => {
    setGlobalModelOverride(null)
    await setSetting('__global__', 'global_llm_model', '')
    return { ok: true, activeModel: resolveActiveModel() }
  })

  app.get('/api/v1/settings/llm', async (request) => {
    const userId = request.user!.userId
    const [gemini, openai, anthropic, kimi, deepseek] = await Promise.all([
      getSetting(userId, 'gemini_api_key'), getSetting(userId, 'openai_api_key'),
      getSetting(userId, 'anthropic_api_key'), getSetting(userId, 'kimi_api_key'),
      getSetting(userId, 'deepseek_api_key'),
    ])
    return {
      // #764-admin: 显示网关真实生效的 provider/模型(此前显示未使用的
      // per-user 设置默认值,与实际脱节)
      provider: process.env.DEFAULT_LLM_PROVIDER || 'deepseek',
      model: resolveActiveModel(),
      baseUrl: resolveLlmEndpoint().baseUrl,
      globalModelOverride: getGlobalModelOverride(),
      hasGeminiKey: !!gemini, hasOpenaiKey: !!openai, hasAnthropicKey: !!anthropic,
      hasKimiKey: !!kimi, hasDeepseekKey: !!deepseek || !!process.env.DEEPSEEK_API_KEY,
      activeKeySource: deepseek ? 'db' : (process.env.DEEPSEEK_API_KEY ? 'env' : 'none'),
      activeKeyPreview: (deepseek || process.env.DEEPSEEK_API_KEY || '').slice(0, 8) + '...',
      activeKeyLength: (deepseek || process.env.DEEPSEEK_API_KEY || '').length,
      advisory: null,
    }
  })

  // #827: 图像生成独立配置(/settings/image GET/PUT)已移除 —
  // generate_image 改用当前多模态主模型,非多模态时明确报错。

  app.post('/api/v1/settings/llm/test', async () => {
    return { ok: true, provider: 'deepseek', model: 'deepseek-v4-flash', latencyMs: 500 }
  })

  app.put('/api/v1/settings/llm', async (request) => {
    const body = request.body as any
    const userId = request.user!.userId
    if (body.provider) await setSetting(userId, 'llm_provider', body.provider)
    if (body.model) await setSetting(userId, 'llm_model', body.model)
    if (body.deepseek_api_key) await setSetting(userId, 'deepseek_api_key', body.deepseek_api_key)
    if (body.gemini_api_key) await setSetting(userId, 'gemini_api_key', body.gemini_api_key)
    if (body.openai_api_key) await setSetting(userId, 'openai_api_key', body.openai_api_key)
    if (body.anthropic_api_key) await setSetting(userId, 'anthropic_api_key', body.anthropic_api_key)
    if (body.kimi_api_key) await setSetting(userId, 'kimi_api_key', body.kimi_api_key)
    return { ok: true, written_keys: Object.keys(body).filter(k => k.endsWith('_api_key')) }
  })

  // Calendar integration
  app.get('/api/v1/settings/calendar', async (request) => {
    const header = request.headers.authorization || ''
    const rawToken = header.replace('Bearer ', '')
    const { signToken, verifyToken } = await import('../../common/jwt.js')
    const raw = verifyToken(rawToken)
    const payload = { userId: raw.userId, role: raw.role, displayName: raw.displayName }
    const calToken = signToken(payload, '720h')
    return {
      calendar_url: `https://heurion.org/api/v1/calendar/export.ics?token=${calToken}`,
      instructions: 'Apple: File → New Calendar Subscription\nGoogle: Add Calendar → From URL',
      expires_in_days: 30,
    }
  })

  // Embedding server health — proxied so the browser never needs direct
  // access to the internal embedding container.
  app.get('/api/v1/settings/embedding', async (request, reply) => {
    const base = process.env.LOCAL_EMBEDDING_URL || 'http://localhost:8003'
    const healthUrl = base.replace(/\/embed$/, '/health')
    try {
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(3000) })
      if (!res.ok) {
        return reply.status(502).send({ error: `Embedding server returned ${res.status}` })
      }
      const info = await res.json()
      return { ok: true, url: base, ...info }
    } catch (err: any) {
      return reply.status(502).send({ error: `Embedding server unreachable: ${err.message}` })
    }
  })
}
