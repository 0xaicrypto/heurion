import { describe, test, expect, vi, afterEach } from 'vitest'
import {
  resolveServerSecret,
  resolveChartTokenSecret,
  assertProductionSecrets,
  DEV_SECRET_FALLBACK,
} from '../../src/common/secrets.js'
import { issueChartToken, verifyChartToken } from '../../src/common/chart-token.js'

/**
 * Rule 4 / P0 — 密钥 fail-closed。
 *
 * 修复前：SERVER_SECRET/CHART_TOKEN_SECRET 缺失时静默回退 'dev-secret-key'，
 * 生产启动不检查 — 漏配即可用公开默认值签发管理员 JWT / 伪造文件直链。
 * 修复后：生产（NODE_ENV 或 APP_ENV=production）缺失或仍是 dev 默认 → 抛错。
 */
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('P0 Rule 4: SERVER_SECRET fail-closed', () => {
  test('生产缺 SERVER_SECRET → 抛错', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('SERVER_SECRET', '')
    expect(() => resolveServerSecret()).toThrow(/SERVER_SECRET/)
  })

  test('生产仍用 dev 默认值 → 抛错（默认值不可用）', () => {
    vi.stubEnv('APP_ENV', 'production')
    vi.stubEnv('SERVER_SECRET', DEV_SECRET_FALLBACK)
    expect(() => resolveServerSecret()).toThrow(/dev-secret-key/)
  })

  test('生产配置真实密钥 → 返回；开发缺配 → dev 回退（本地零配置可跑）', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('SERVER_SECRET', 'real-secret-from-openssl')
    expect(resolveServerSecret()).toBe('real-secret-from-openssl')

    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('APP_ENV', '')
    vi.stubEnv('SERVER_SECRET', '')
    expect(resolveServerSecret()).toBe(DEV_SECRET_FALLBACK)
  })

  test('assertProductionSecrets：生产缺配抛错，开发放行', () => {
    vi.stubEnv('APP_ENV', 'production')
    vi.stubEnv('SERVER_SECRET', '')
    vi.stubEnv('CHART_TOKEN_SECRET', '')
    expect(() => assertProductionSecrets()).toThrow(/SERVER_SECRET/)

    vi.stubEnv('APP_ENV', 'development')
    expect(() => assertProductionSecrets()).not.toThrow()
  })
})

describe('P0 Rule 4: CHART_TOKEN_SECRET 不再以默认值签名', () => {
  test('生产缺配 → issueChartToken 抛错（不签发可伪造直链）', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('SERVER_SECRET', '')
    vi.stubEnv('CHART_TOKEN_SECRET', '')
    expect(() => issueChartToken('file-1', 'user-1')).toThrow(/SERVER_SECRET/)
  })

  test('开发兜底令牌仍可签/验（行为不变）', () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('SERVER_SECRET', '')
    vi.stubEnv('CHART_TOKEN_SECRET', '')
    const token = issueChartToken('file-1', 'user-1')
    expect(verifyChartToken('file-1', token)).toBe('user-1')
    expect(verifyChartToken('file-2', token)).toBeNull()
  })
})
