import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { MiniLruCache } from '../../src/lib/lru-cache.js'

/**
 * #922 — 通用 mini-LRU(泛化自 document-extractor 的两个手写缓存,
 * inflight 合并参照 tools/external-fetch.ts #860 模式)。
 */
describe('MiniLruCache', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  test('get/set/TTL 惰性过期', () => {
    const c = new MiniLruCache<string>(10, 1000)
    c.set('k', 'v')
    expect(c.get('k')).toBe('v')
    vi.advanceTimersByTime(1001)
    expect(c.get('k')).toBe(undefined)
    // 过期删除后再 set 可重新写入。
    c.set('k', 'v2')
    expect(c.get('k')).toBe('v2')
  })

  test('容量满时淘汰 at 最旧(与原手写扫描同口径)', () => {
    const c = new MiniLruCache<string>(2, 60_000)
    c.set('a', '1')
    vi.advanceTimersByTime(10)
    c.set('b', '2')
    vi.advanceTimersByTime(10)
    c.set('c', '3') // 容量 2 满 → 淘汰最旧的 a
    expect(c.get('a')).toBe(undefined)
    expect(c.get('b')).toBe('2')
    expect(c.get('c')).toBe('3')
  })

  test('刷新已有 key 会更新 at(晚写入者存活)', () => {
    const c = new MiniLruCache<string>(2, 60_000)
    c.set('a', '1')
    vi.advanceTimersByTime(10)
    c.set('b', '2')
    vi.advanceTimersByTime(10)
    c.set('a', '1b') // a 刷新 at → b 成为最旧
    c.set('c', '3')
    expect(c.get('a')).toBe('1b')
    expect(c.get('b')).toBe(undefined)
    expect(c.get('c')).toBe('3')
  })

  test('shouldStore 为 false 的值不落库但正常返回', () => {
    const c = new MiniLruCache<string>(10, 60_000, (v) => v !== 'skip')
    c.set('k', 'skip')
    expect(c.get('k')).toBe(undefined)
  })

  test('load: 同 key 并发合并,loader 只跑一次(#860 inflight 模式)', async () => {
    const c = new MiniLruCache<string>(10, 60_000)
    let release: (() => void) | null = null
    const gate = new Promise<void>((r) => { release = r })
    const loader = vi.fn(async () => {
      await gate // 挂起 — 并发调用应全部合并到同一 promise
      return 'result'
    })
    const p1 = c.load('k', loader)
    const p2 = c.load('k', loader)
    const p3 = c.load('k', loader)
    release!()
    const [a, b, c2] = await Promise.all([p1, p2, p3])
    expect(a).toBe('result')
    expect(b).toBe('result')
    expect(c2).toBe('result')
    expect(loader).toHaveBeenCalledTimes(1)
    // 完成后 inflight 清理,再取直接命中缓存。
    expect(await c.load('k', loader)).toBe('result')
    expect(loader).toHaveBeenCalledTimes(1)
  })

  test('load: 失败不缓存,inflight 清理后可重试', async () => {
    const c = new MiniLruCache<string>(10, 60_000)
    let attempts = 0
    const loader = vi.fn(async () => {
      attempts++
      if (attempts === 1) throw new Error('boom')
      return 'ok'
    })
    await expect(c.load('k', loader)).rejects.toThrow('boom')
    await expect(c.load('k', loader)).resolves.toBe('ok')
    expect(loader).toHaveBeenCalledTimes(2)
  })

  test('load: 不同 key 不互相合并', async () => {
    const c = new MiniLruCache<string>(10, 60_000)
    const calls: string[] = []
    const loaderFor = (name: string) => async () => {
      calls.push(name)
      return name
    }
    const [a, b] = await Promise.all([c.load('x', loaderFor('x')), c.load('y', loaderFor('y'))])
    expect(a).toBe('x')
    expect(b).toBe('y')
    expect(calls).toEqual(['x', 'y'])
  })
})
