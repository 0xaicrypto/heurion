import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { issueToken } from '../src/auth/token.ts'
import { handleLlmProxy, LLM_PREFIX } from '../src/harness/llm-proxy.ts'

const SECRET = 'proxy-test-secret'
const servers: Server[] = []
afterEach(() => { for (const s of servers.splice(0)) s.close() })

async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const s = createServer(handler)
  servers.push(s)
  await new Promise<void>(r => s.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`
}

async function setup(live = true) {
  const seen: Array<{ url: string; key: string | undefined; body: string }> = []
  // 假上游：记录收到的 key 与请求体，按 SSE 分两段回
  const upstream = await listen((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      seen.push({ url: req.url ?? '', key: req.headers['x-api-key'] as string | undefined, body })
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('event: a\ndata: 1\n\n')
      setTimeout(() => res.end('event: b\ndata: 2\n\n'), 20)
    })
  })
  const proxy = await listen((req, res) => void handleLlmProxy({ secret: SECRET, upstream: `${upstream}/anthropic/v1`, apiKey: 'REAL-KEY', isLive: () => live }, req, res))
  return { proxy, seen }
}

const token = (aud: 'llm' | 'mcp' = 'llm', s = 'gen1') => issueToken(SECRET, { u: 'u1', d: [], p: [], aud, ttlSeconds: 60, s })

describe('模型调用代理', () => {
  it('合法令牌：换成真实 key 转发，路径与请求体原样，SSE 流式回传', async () => {
    const t = await setup()
    const res = await fetch(`${t.proxy}${LLM_PREFIX}/messages?beta=1`, { method: 'POST', headers: { 'x-api-key': token(), 'content-type': 'application/json' }, body: '{"model":"m"}' })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('event: a\ndata: 1\n\nevent: b\ndata: 2\n\n')
    expect(t.seen).toEqual([{ url: '/anthropic/v1/messages?beta=1', key: 'REAL-KEY', body: '{"model":"m"}' }])
  })

  it('没有令牌、令牌受众不对、进程已回收：401，不转发', async () => {
    const t = await setup()
    const call = (key?: string) => fetch(`${t.proxy}${LLM_PREFIX}/messages`, { method: 'POST', headers: key ? { 'x-api-key': key } : {}, body: '{}' })
    expect((await call()).status).toBe(401)
    expect((await call(token('mcp'))).status).toBe(401)
    expect((await call('REAL-KEY')).status).toBe(401)
    const dead = await setup(false)
    expect((await fetch(`${dead.proxy}${LLM_PREFIX}/messages`, { method: 'POST', headers: { 'x-api-key': token() }, body: '{}' })).status).toBe(401)
    expect([...t.seen, ...dead.seen]).toEqual([])
  })
})
