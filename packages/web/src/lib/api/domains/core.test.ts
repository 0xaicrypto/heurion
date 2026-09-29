import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { ApiCore, ApiError } from './core'
import { useAuthStore } from '@/stores/auth'

/**
 * #1147 — core.ts 401 处理测试缺口:401(非 auth 路径)必须登出并派发
 * `nexus:auth-expired`;auth 路径(登录失败)的 401 不得误清会话。
 */
class ProbeApi extends ApiCore {
  probe(path: string) { return this.fetch<unknown>(path) }
}

function res401(): Response {
  return {
    ok: false,
    status: 401,
    statusText: 'Unauthorized',
    text: async () => '{"error":"token expired"}',
    headers: new Headers({ 'content-type': 'application/json' }),
  } as unknown as Response
}

beforeEach(() => {
  useAuthStore.setState({ token: 'tok', isAuthenticated: true })
})
afterEach(() => {
  vi.unstubAllGlobals()
  useAuthStore.getState().clearSession()
})

describe('#1147 core 401 处理', () => {
  test('非 auth 路径 401 → 清会话 + 派发 auth-expired + 抛 ApiError', async () => {
    const events: Event[] = []
    const handler = (e: Event) => events.push(e)
    window.addEventListener('nexus:auth-expired', handler)
    vi.stubGlobal('fetch', vi.fn(async () => res401()))

    await expect(new ProbeApi().probe('/api/v1/docs')).rejects.toBeInstanceOf(ApiError)

    expect(useAuthStore.getState().token).toBeNull()
    expect(useAuthStore.getState().isAuthenticated).toBe(false)
    expect(events).toHaveLength(1)
    window.removeEventListener('nexus:auth-expired', handler)
  })

  test('auth 路径 401（登录失败）→ 不清会话、不派发', async () => {
    const events: Event[] = []
    const handler = (e: Event) => events.push(e)
    window.addEventListener('nexus:auth-expired', handler)
    vi.stubGlobal('fetch', vi.fn(async () => res401()))

    await expect(new ProbeApi().probe('/api/v1/auth/login')).rejects.toBeInstanceOf(ApiError)

    // 已登录用户手动重新登录失败 → 不得被误登出
    expect(useAuthStore.getState().token).toBe('tok')
    expect(useAuthStore.getState().isAuthenticated).toBe(true)
    expect(events).toHaveLength(0)
    window.removeEventListener('nexus:auth-expired', handler)
  })
})
