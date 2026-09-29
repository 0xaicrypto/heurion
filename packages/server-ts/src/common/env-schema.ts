/**
 * #1146 — 关键 env 集中校验（zod 依赖已有；纯函数便于单测）。
 * 审计：config.ts 之外 159 处直接读 process.env、55 处自行 parseInt，
 * 非法值静默生效（`GAP_RESEARCH_INTERVAL_MS=5m` → 5ms 热循环、`abc` → NaN）。
 * 这里覆盖启动期高危项：生产环境 errors 直接 fail-fast，非生产只 warn。
 */
import { z } from 'zod'
import { LLM_PROVIDER_NAMES } from './llm-gateway/provider-names.js'

const INT_NAMES = [
  'SERVER_PORT',
  'GAP_RESEARCH_INTERVAL_MS',
  'GAP_RESEARCH_MAX_PER_RUN',
  'GAP_RESEARCH_MIN_AGE_MS',
  'EXPERIENCE_SYNTHESIS_INTERVAL_MS',
  'EXPERIENCE_SYNTHESIS_MIN_FACTS',
  'EXPERIENCE_SYNTHESIS_MAX_CANDIDATES',
  'SKILL_INDUCE_INTERVAL_MS',
  'EMBEDDING_BATCH_SIZE',
  'EMBEDDING_DIMENSIONS',
  'UPLOAD_CHUNK_MAX_BYTES',
  'MAX_CHUNKED_UPLOAD_BYTES',
  'SHUTDOWN_GRACE_MS',
] as const

const ENUMS: Record<string, readonly string[]> = {
  ENVIRONMENT: ['development', 'test', 'staging', 'production'],
  EMBEDDING_PROVIDER: ['local', 'openai', 'none'],
  EMBEDDING_FALLBACK_PROVIDER: ['openai', 'none'],
  EMBEDDING_DEVICE: ['cpu', 'cuda', 'mps', 'wasm'],
}

const intSchema = z.string().regex(/^\d+$/, 'must be an integer').transform(Number)
  .refine((n) => n >= 1, 'must be >= 1')

export interface EnvCheckResult {
  errors: string[]
  warnings: string[]
}

export function validateEnv(env: NodeJS.ProcessEnv = process.env): EnvCheckResult {
  const errors: string[] = []
  const warnings: string[] = []

  for (const name of INT_NAMES) {
    const raw = env[name]
    if (raw === undefined || raw.trim() === '') continue
    const parsed = intSchema.safeParse(raw.trim())
    if (!parsed.success) {
      errors.push(`${name}=${JSON.stringify(raw)} — ${parsed.error.issues[0]?.message ?? 'invalid integer'}`)
    }
  }

  for (const [name, values] of Object.entries(ENUMS)) {
    const raw = env[name]
    if (raw === undefined || raw.trim() === '') continue
    if (!values.includes(raw)) {
      errors.push(`${name}=${JSON.stringify(raw)} — must be one of: ${values.join(' | ')}`)
    }
  }

  // #1150-followup: DEFAULT_LLM_PROVIDER 走 provider 名单单一来源,大小写
  // 不敏感(运行时 currentLlmProvider 亦 toLowerCase)。
  {
    const raw = env.DEFAULT_LLM_PROVIDER
    if (raw !== undefined && raw.trim() !== '' && !(LLM_PROVIDER_NAMES as readonly string[]).includes(raw.trim().toLowerCase())) {
      errors.push(`DEFAULT_LLM_PROVIDER=${JSON.stringify(raw)} — must be one of: ${LLM_PROVIDER_NAMES.join(' | ')}`)
    }
  }

  const isProd = env.APP_ENV === 'production' || env.ENVIRONMENT === 'production'
  if (isProd && !env.SERVER_SECRET) {
    errors.push('SERVER_SECRET is required when APP_ENV/ENVIRONMENT=production')
  }
  if (isProd && !env.CORS_ALLOW_ORIGINS) {
    warnings.push('CORS_ALLOW_ORIGINS is not set in production — falling back to localhost defaults')
  }
  return { errors, warnings }
}
