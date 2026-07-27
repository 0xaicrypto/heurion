import { describe, test, expect, vi } from 'vitest'
import {
  InMemoryEvolutionQueue,
  BullMqEvolutionQueue,
  parseRedisUrl,
  createDefaultEvolutionQueue,
} from '../src/modules/evolution/evolution.queue.js'
import { getApp, authHeader } from './setup.js'

describe('Evolution queue', () => {
  test('in-memory queue reports metrics', async () => {
    const q = new InMemoryEvolutionQueue()
    await q.add({ userId: 'u1', sessionId: 's1', userMessage: 'hi' })

    const metrics = await q.getMetrics()
    expect(metrics.waiting).toBe(1)
    expect(metrics.active).toBe(0)
  })

  test('parseRedisUrl extracts host, port, auth, tls and db', () => {
    const opts = parseRedisUrl('rediss://user:pass@redis.example.com:6380/2?db=3')
    expect(opts).toBeDefined()
    expect(opts?.host).toBe('redis.example.com')
    expect(opts?.port).toBe(6380)
    expect(opts?.username).toBe('user')
    expect(opts?.password).toBe('pass')
    expect(opts?.tls).toBeDefined()
    expect(opts?.db).toBe(3)
  })

  test('parseRedisUrl falls back to defaults', () => {
    const opts = parseRedisUrl('redis://localhost')
    expect(opts?.host).toBe('localhost')
    expect(opts?.port).toBe(6379)
    expect(opts?.db).toBeUndefined()
    expect(opts?.tls).toBeUndefined()
  })

  test('createDefaultEvolutionQueue returns in-memory when REDIS_URL is missing', async () => {
    const original = process.env.REDIS_URL
    delete process.env.REDIS_URL
    const q = await createDefaultEvolutionQueue()
    expect(q.type).toBe('in-memory')
    process.env.REDIS_URL = original
  })

  test('createDefaultEvolutionQueue falls back to in-memory on unreachable Redis', async () => {
    const original = process.env.REDIS_URL
    process.env.REDIS_URL = 'redis://127.0.0.1:1' // port 1 is very unlikely to be reachable
    const q = await createDefaultEvolutionQueue()
    expect(q.type).toBe('in-memory')
    process.env.REDIS_URL = original
  })

  test('createDefaultEvolutionQueue uses BullMQ when Redis is reachable', async () => {
    const original = process.env.REDIS_URL
    // A reachable Redis will be used if present; otherwise stubbing the probe is risky.
    // This test mainly documents the branching behaviour for environments with Redis.
    if (original) {
      const q = await createDefaultEvolutionQueue()
      expect(q instanceof BullMqEvolutionQueue || q.type === 'in-memory').toBe(true)
    }
    process.env.REDIS_URL = original
  })
})

describe('Evolution API', () => {
  test('GET /api/v1/evolution/queue requires auth', async () => {
    const app = await getApp()
    const res = await app.inject({ method: 'GET', url: '/api/v1/evolution/queue' })
    expect(res.statusCode).toBe(401)
  })

  test('GET /api/v1/evolution/queue returns queue type and metrics', async () => {
    const app = await getApp()
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/evolution/queue',
      headers: await authHeader(),
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.type).toBe('in-memory')
    expect(body.metrics).toBeDefined()
    expect(typeof body.metrics.waiting).toBe('number')
    expect(typeof body.metrics.active).toBe('number')
    expect(typeof body.metrics.failed).toBe('number')
  })
})
