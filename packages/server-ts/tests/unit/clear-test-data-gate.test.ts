import { describe, test, expect } from 'vitest'
import { isClearTestDataAllowed } from '../../src/modules/auth/auth.router.js'

/**
 * P1 — clear-test-data 的 Host 头伪造绕过。
 *
 * 修复前只检查请求 Host（localhost/127.0.0.1/staging*）— 生产环境下
 * 客户端发 `Host: localhost` 即可删除自己的全部数据（越过 staging-only
 * 约束）。现在以环境判定为准（#989：APP_ENV/NODE_ENV=production），
 * Host 白名单只作非生产环境的防御纵深。
 */
describe('P1 clear-test-data 环境闸门', () => {
  test('生产环境一律拒绝 — 即使 Host: localhost', () => {
    expect(isClearTestDataAllowed('localhost', { APP_ENV: 'production' } as NodeJS.ProcessEnv)).toBe(false)
    expect(isClearTestDataAllowed('localhost:8001', { NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toBe(false)
    expect(isClearTestDataAllowed('staging.heurion.org', { APP_ENV: 'production' } as NodeJS.ProcessEnv)).toBe(false)
    expect(isClearTestDataAllowed('127.0.0.1', { APP_ENV: 'production' } as NodeJS.ProcessEnv)).toBe(false)
  })

  test('非生产环境保留 Host 白名单（防御纵深）', () => {
    expect(isClearTestDataAllowed('localhost', {} as NodeJS.ProcessEnv)).toBe(true)
    expect(isClearTestDataAllowed('127.0.0.1:5173', {} as NodeJS.ProcessEnv)).toBe(true)
    expect(isClearTestDataAllowed('staging.heurion.org', {} as NodeJS.ProcessEnv)).toBe(true)
    // 非白名单主机（非生产）仍拒绝 — 与旧行为一致
    expect(isClearTestDataAllowed('evil.example.com', {} as NodeJS.ProcessEnv)).toBe(false)
    expect(isClearTestDataAllowed(undefined, {} as NodeJS.ProcessEnv)).toBe(false)
  })
})
