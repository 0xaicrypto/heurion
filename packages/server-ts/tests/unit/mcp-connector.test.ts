import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { McpListToolsTool, McpCallToolTool } from '../../src/tools/mcp-tools.js'
import { parseMcpServers } from '../../src/tools/mcp-client.js'

function jsonRpcResponse(body: string): { ok: boolean; status: number; text: () => Promise<string> } {
  return { ok: true, status: 200, text: async () => body }
}

/**
 * #299: MCP connector — tools/list + tools/call against a mocked external
 * server, read-now/write-gated behavior, unconfigured degradation.
 */
describe('MCP connector (#299)', () => {
  beforeEach(() => {
    vi.stubEnv('MCP_SERVERS', JSON.stringify({
      'ehr': { url: 'https://mock-ehr.example/mcp', capabilities: ['read'] },
      'imaging': { url: 'https://mock-img.example/mcp', capabilities: ['read', 'write'] },
    }))
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  test('parseMcpServers reads config from env', () => {
    const servers = parseMcpServers(process.env.MCP_SERVERS)
    expect(Object.keys(servers)).toEqual(['ehr', 'imaging'])
  })

  test('mcp_list_tools lists read/write annotations', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock
      .mockResolvedValueOnce(jsonRpcResponse(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })) as any) // initialize
      .mockResolvedValueOnce(jsonRpcResponse(JSON.stringify({
        jsonrpc: '2.0', id: 1,
        result: { tools: [
          { name: 'get_lab_results', description: 'Fetch lab results', inputSchema: {} },
          { name: 'write_note', description: 'Write a note', inputSchema: {}, annotations: { readOnlyHint: false } },
        ] },
      })) as any)

    const tool = new McpListToolsTool()
    const res = await tool.execute({ server: 'ehr' })
    expect(res.success).toBe(true)
    expect(res.output).toContain('get_lab_results')
    expect(res.output).toContain('[WRITE — requires approval]')
  })

  test('read tool calls execute immediately', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock
      .mockResolvedValueOnce(jsonRpcResponse(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })) as any)
      .mockResolvedValueOnce(jsonRpcResponse(JSON.stringify({
        jsonrpc: '2.0', id: 1,
        result: { tools: [{ name: 'get_lab_results', description: 'x' }] },
      })) as any)
      .mockResolvedValueOnce(jsonRpcResponse(JSON.stringify({
        jsonrpc: '2.0', id: 1,
        result: { content: [{ type: 'text', text: '{"wbc": 8.1}' }] },
      })) as any)

    const tool = new McpCallToolTool()
    const res = await tool.execute({ server: 'ehr', tool: 'get_lab_results', arguments: { patient: 'p1' } })
    expect(res.success).toBe(true)
    expect(res.output).toContain('wbc')
    // third call = tools/call
    const callBody = JSON.parse(String(fetchMock.mock.calls[2][1]?.body))
    expect(callBody.method).toBe('tools/call')
    expect(callBody.params.name).toBe('get_lab_results')
  })

  test('write tools are gated — reported, never executed', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock
      .mockResolvedValueOnce(jsonRpcResponse(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })) as any)
      .mockResolvedValueOnce(jsonRpcResponse(JSON.stringify({
        jsonrpc: '2.0', id: 1,
        result: { tools: [{ name: 'write_note', description: 'w', annotations: { readOnlyHint: false } }] },
      })) as any)

    const tool = new McpCallToolTool()
    const res = await tool.execute({ server: 'ehr', tool: 'write_note', arguments: { text: 'x' } })
    expect(res.success).toBe(true)
    expect(res.output).toContain('WRITE-GATED')
    expect(res.output).toContain('NOT executed')
    // No tools/call was issued.
    expect(fetchMock.mock.calls.length).toBe(2)
  })

  test('unconfigured server degrades with a clear error', async () => {
    const tool = new McpListToolsTool()
    const res = await tool.execute({ server: 'missing' })
    expect(res.success).toBe(false)
    expect(res.error).toContain('not configured')
  })
})
