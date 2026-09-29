import { describe, test, expect } from 'vitest'
import { validateEnv } from '../../src/common/env-schema.js'

/**
 * #1146 — env 集中校验：非法间隔（'5m'/'abc'）、非法枚举、生产缺 SECRET
 * 必须在启动期被抓；合法/非生产缺 SECRET 不报错。
 */
describe('#1146 validateEnv', () => {
  test('合法配置零错误', () => {
    const r = validateEnv({
      SERVER_PORT: '8001',
      GAP_RESEARCH_INTERVAL_MS: '300000',
      EMBEDDING_BATCH_SIZE: '32',
      ENVIRONMENT: 'development',
      EMBEDDING_PROVIDER: 'local',
    } as NodeJS.ProcessEnv)
    expect(r.errors).toEqual([])
  })

  test('审计实例 5m/abc/0 → 错误；未设项跳过', () => {
    const r = validateEnv({
      GAP_RESEARCH_INTERVAL_MS: '5m',
      EXPERIENCE_SYNTHESIS_MIN_FACTS: 'abc',
      EMBEDDING_BATCH_SIZE: '0',
    } as NodeJS.ProcessEnv)
    expect(r.errors).toHaveLength(3)
    expect(r.errors.join('\n')).toContain('GAP_RESEARCH_INTERVAL_MS')
    expect(r.errors.join('\n')).toContain('EMBEDDING_BATCH_SIZE')
  })

  test('非法枚举 → 错误', () => {
    const r = validateEnv({ ENVIRONMENT: 'prod', EMBEDDING_PROVIDER: 'bert' } as NodeJS.ProcessEnv)
    expect(r.errors).toHaveLength(2)
  })

  test('DEFAULT_LLM_PROVIDER:kimi/zhipu 合法(单一来源名单),大小写不敏感,未知值报错', () => {
    for (const p of ['kimi', 'zhipu', 'Kimi', 'OpenCode', 'GEMINI']) {
      expect(validateEnv({ DEFAULT_LLM_PROVIDER: p } as NodeJS.ProcessEnv).errors).toEqual([])
    }
    const bad = validateEnv({ DEFAULT_LLM_PROVIDER: 'anthropic' } as NodeJS.ProcessEnv)
    expect(bad.errors).toHaveLength(1)
    expect(bad.errors[0]).toContain('DEFAULT_LLM_PROVIDER')
  })

  test('生产缺 SERVER_SECRET → 错误；非生产不报', () => {
    expect(validateEnv({ ENVIRONMENT: 'production' } as NodeJS.ProcessEnv).errors).toContainEqual(
      expect.stringContaining('SERVER_SECRET'),
    )
    expect(validateEnv({ ENVIRONMENT: 'development' } as NodeJS.ProcessEnv).errors).toEqual([])
  })
})
