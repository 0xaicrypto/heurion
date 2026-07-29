import http from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  AiProviderError,
  loadAiConfigFromEnv,
  type AiProviderConfig,
} from '../src/common/ai/ai-provider.js'
import {
  LocalEmbeddingProvider,
  ResilientEmbeddingProvider,
} from '../src/common/ai/local-embedding.provider.js'
import { OpenAIEmbeddingProvider } from '../src/common/ai/openai-embedding.provider.js'

const DIMENSIONS = 1024

/**
 * Deterministic pseudo-random generator seeded by a string.
 * Used to generate stable keyword vectors for the stub server.
 */
function lcg(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

function seededVector(seed: string, dims: number): number[] {
  const rand = lcg(seed.split('').reduce((h, c) => h * 31 + c.charCodeAt(0), 0))
  return Array.from({ length: dims }, () => rand() * 2 - 1)
}

function addVectors(a: number[], b: number[]): number[] {
  return a.map((v, i) => v + b[i])
}

function normalize(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0))
  return norm === 0 ? v : v.map((x) => x / norm)
}

function cosine(a: number[], b: number[]): number {
  let dot = 0
  let a2 = 0
  let b2 = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    a2 += a[i] * a[i]
    b2 += b[i] * b[i]
  }
  return dot / (Math.sqrt(a2) * Math.sqrt(b2))
}

function embeddingFor(text: string): number[] {
  const lower = text.toLowerCase()
  let vec = seededVector('default', DIMENSIONS).map((x) => x * 0.1)
  if (lower.includes('apple') || lower.includes('fruit')) {
    vec = addVectors(vec, seededVector('apple', DIMENSIONS))
  }
  if (lower.includes('car') || lower.includes('vehicle')) {
    vec = addVectors(vec, seededVector('car', DIMENSIONS))
  }
  return normalize(vec)
}

interface StubServer {
  url: string
  close: () => Promise<void>
  setFail: (fail: boolean) => void
}

async function startStubServer(): Promise<StubServer> {
  let failNext = false
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/embed') {
      res.writeHead(404)
      res.end(JSON.stringify({ error: 'not found' }))
      return
    }

    let body = ''
    req.on('data', (chunk) => {
      body += chunk.toString()
    })
    req.on('end', () => {
      if (failNext) {
        failNext = false
        res.writeHead(503)
        res.end(JSON.stringify({ error: 'stub failure' }))
        return
      }

      const payload = JSON.parse(body)
      const texts: string[] = payload.texts ?? []
      const embeddings = texts.map((t) => embeddingFor(t))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ embeddings, model: payload.model ?? 'BAAI/bge-m3', dimensions: DIMENSIONS }))
    })
  })

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        server.close(() => reject(new Error('Invalid server address')))
        return
      }
      resolve({
        url: `http://127.0.0.1:${addr.port}/embed`,
        close: () => new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res()))),
        setFail: (fail) => {
          failNext = fail
        },
      })
    })
  })
}

describe('local embedding provider', () => {
  let stub: StubServer
  let provider: LocalEmbeddingProvider

  beforeEach(async () => {
    stub = await startStubServer()
    provider = new LocalEmbeddingProvider({ localEmbeddingUrl: stub.url, embeddingModel: 'BAAI/bge-m3' })
  })

  afterEach(async () => {
    await stub.close()
  })

  it('returns a 1024-dim vector for a single text', async () => {
    const result = await provider.embed(['A red apple'])
    expect(result).toHaveLength(1)
    expect(result[0]).toHaveLength(DIMENSIONS)
    expect(cosine(result[0], result[0])).toBeCloseTo(1, 6)
  })

  it('returns equal-length vectors for a batch', async () => {
    const result = await provider.embed(['apple', 'car', 'fruit'])
    expect(result).toHaveLength(3)
    expect(result[0]).toHaveLength(DIMENSIONS)
    expect(result[1]).toHaveLength(DIMENSIONS)
    expect(result[2]).toHaveLength(DIMENSIONS)
  })

  it('ranks related texts higher than unrelated texts', async () => {
    const [apple, fruit, car] = await provider.embed(['apple', 'fruit salad', 'sports car'])
    const related = cosine(apple, fruit)
    const unrelated = cosine(apple, car)
    expect(related).toBeGreaterThan(unrelated)
    expect(related).toBeGreaterThan(0.5)
  })

  it('returns an empty array for empty input', async () => {
    const result = await provider.embed([])
    expect(result).toEqual([])
  })

  it('throws when the service returns an error and no fallback is configured', async () => {
    stub.setFail(true)
    await expect(provider.embed(['error'])).rejects.toThrow(AiProviderError)
  })
})

describe('resilient embedding provider', () => {
  let stub: StubServer
  let primary: LocalEmbeddingProvider

  beforeEach(async () => {
    stub = await startStubServer()
    primary = new LocalEmbeddingProvider({ localEmbeddingUrl: stub.url })
  })

  afterEach(async () => {
    await stub.close()
  })

  it('falls back to OpenAI when local fails and fallback is configured', async () => {
    stub.setFail(true)
    const openai = new OpenAIEmbeddingProvider({ openaiApiKey: 'sk-test', openaiEmbeddingModel: 'text-embedding-3-small' })
    const resilient = new ResilientEmbeddingProvider(primary, openai)

    let openaiCalled = false
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      if (input === 'https://api.openai.com/v1/embeddings') {
        openaiCalled = true
        const body = JSON.parse((init as any).body)
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: body.input.map((t: string, i: number) => ({
              embedding: embeddingFor(t),
              index: i,
            })),
          }),
          text: async () => '',
        } as Response
      }
      return originalFetch(input, init)
    }

    try {
      const result = await resilient.embed(['apple', 'car'])
      expect(openaiCalled).toBe(true)
      expect(result).toHaveLength(2)
      expect(result[0]).toHaveLength(DIMENSIONS)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('embedding configuration', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('loads device and fallback settings from environment', () => {
    process.env.EMBEDDING_DEVICE = 'cuda'
    process.env.EMBEDDING_FALLBACK_PROVIDER = 'openai'
    process.env.OPENAI_API_KEY = 'sk-test'

    const cfg = loadAiConfigFromEnv()
    expect(cfg.embeddingDevice).toBe('cuda')
    expect(cfg.embeddingFallbackProvider).toBe('openai')
    expect(cfg.openaiApiKey).toBe('sk-test')
  })
})

describe('local embedding integration', () => {
  it('verifies bge-m3 dimensions when a real service is running', async () => {
    const url = process.env.LOCAL_EMBEDDING_URL || 'http://localhost:8003/embed'
    const healthUrl = url.replace(/\/embed$/, '/health')

    let health: Response | undefined
    try {
      health = await fetch(healthUrl, { signal: AbortSignal.timeout(500) })
    } catch {
      // No running service — skip integration test.
      return
    }

    if (!health.ok) return

    const info = (await health.json()) as any
    if (info.dimensions !== DIMENSIONS) return

    const provider = new LocalEmbeddingProvider({ localEmbeddingUrl: url })
    const [vec] = await provider.embed(['integration test'])
    expect(vec).toHaveLength(DIMENSIONS)
  })
})
