import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { getApp, authHeader } from '../setup.js'
import prisma from '../../src/common/prisma.js'

/**
 * #417: MCP server management — DB-backed CRUD, encrypted token, test
 * connection, and the admin write-call endpoint.
 */
describe('MCP admin (#417)', () => {
  beforeEach(async () => {
    await (prisma as any).mcpServer.deleteMany({})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function jsonRpcResponse(body: string): any {
    return { ok: true, status: 200, text: async () => body }
  }

  test('CRUD: add, list, delete a server; token is stored encrypted', async () => {
    const app = await getApp()
    const h = { ...await authHeader(), 'content-type': 'application/json' }

    const add = await app.inject({
      method: 'POST', url: '/api/v1/settings/mcp-servers',
      headers: h,
      payload: JSON.stringify({ name: 'ehr', url: 'https://ehr.example.com/mcp', capabilities: ['read'], token: 'secret-token' }),
    })
    expect(add.statusCode).toBe(200)
    const id = JSON.parse(add.payload).server.id

    const list = await app.inject({ method: 'GET', url: '/api/v1/settings/mcp-servers', headers: await authHeader() })
    const servers = JSON.parse(list.payload).servers
    expect(servers.length).toBe(1)
    expect(servers[0].name).toBe('ehr')
    expect(servers[0].has_token).toBe(true)
    expect(servers[0].url).not.toContain('secret')

    // Token is encrypted at rest (not plaintext in the DB).
    const row = await (prisma as any).mcpServer.findFirst({ where: { name: 'ehr' } })
    expect(row.tokenEnc).toBeTruthy()
    expect(String(row.tokenEnc)).not.toContain('secret-token')

    const del = await app.inject({ method: 'DELETE', url: `/api/v1/settings/mcp-servers/${id}`, headers: await authHeader() })
    expect(del.statusCode).toBe(200)
  })

  test('validation: bad url rejected', async () => {
    const app = await getApp()
    const h = { ...await authHeader(), 'content-type': 'application/json' }
    const res = await app.inject({
      method: 'POST', url: '/api/v1/settings/mcp-servers',
      headers: h, payload: JSON.stringify({ name: 'x', url: 'not-a-url' }),
    })
    expect(res.statusCode).toBe(400)
  })

  test('test endpoint lists remote tools', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonRpcResponse(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })) as any)
      .mockResolvedValueOnce(jsonRpcResponse(JSON.stringify({
        jsonrpc: '2.0', id: 1,
        result: { tools: [{ name: 'get_lab', description: 'fetch labs' }, { name: 'write', annotations: { readOnlyHint: false } }] },
      })) as any)

    const app = await getApp()
    const h = { ...await authHeader(), 'content-type': 'application/json' }
    const add = await app.inject({
      method: 'POST', url: '/api/v1/settings/mcp-servers',
      headers: h, payload: JSON.stringify({ name: 'lab', url: 'https://lab.example.com/mcp' }),
    })
    const id = JSON.parse(add.payload).server.id

    const test = await app.inject({ method: 'POST', url: `/api/v1/settings/mcp-servers/${id}/test`, headers: h, payload: JSON.stringify({}) })
    expect(test.statusCode).toBe(200)
    const body = JSON.parse(test.payload)
    expect(body.ok).toBe(true)
    expect(body.tools.map((t: any) => t.name)).toContain('get_lab')
    expect(body.tools.find((t: any) => t.name === 'write').is_write).toBe(true)
  })

  test('admin write-call executes a tool', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonRpcResponse(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })) as any)
      .mockResolvedValueOnce(jsonRpcResponse(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'written ok' }] } })) as any)

    const app = await getApp()
    const h = { ...await authHeader(), 'content-type': 'application/json' }
    const add = await app.inject({
      method: 'POST', url: '/api/v1/settings/mcp-servers',
      headers: h, payload: JSON.stringify({ name: 'ehr', url: 'https://ehr.example.com/mcp', capabilities: ['read', 'write'] }),
    })
    const id = JSON.parse(add.payload).server.id

    const call = await app.inject({
      method: 'POST', url: `/api/v1/settings/mcp-servers/${id}/call`,
      headers: h, payload: JSON.stringify({ tool: 'write_note', arguments: { text: 'x' } }),
    })
    expect(call.statusCode).toBe(200)
    expect(JSON.parse(call.payload).result).toContain('written ok')
  })
})
