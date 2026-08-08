/**
 * #299: minimal Model Context Protocol (MCP) client — JSON-RPC 2.0 over
 * HTTP, enough to list tools and call them on an external MCP server
 * (EHR / imaging / lab systems). Read/write capability is surfaced so
 * callers can gate writes behind the approval queue (#105).
 */

export interface McpServerConfig {
  url: string
  /** 'read' | 'write' — write calls are gated by the caller. */
  capabilities: Array<'read' | 'write'>
  /** Optional bearer token for the MCP server. */
  token?: string
}

export function parseMcpServers(raw: string | undefined): Record<string, McpServerConfig> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as Record<string, McpServerConfig>
    return Object.fromEntries(
      Object.entries(parsed).filter(([, v]) => v && typeof v.url === 'string'),
    )
  } catch {
    return {}
  }
}

class McpError extends Error {
  constructor(message: string, public code?: number) {
    super(message)
    this.name = 'McpError'
  }
}

async function rpc(url: string, method: string, params: unknown, token?: string): Promise<any> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: controller.signal,
    })
    if (!res.ok) throw new McpError(`MCP HTTP ${res.status}`, res.status)
    const text = await res.text()
    // SSE-framed responses: pick the last `data:` line that is JSON.
    let payload = text
    if (text.includes('event:') || text.includes('data:')) {
      const lines = text.split('\n').filter((l) => l.startsWith('data:'))
      const last = lines[lines.length - 1]
      if (last) payload = last.replace(/^data:\s*/, '')
    }
    const parsed = JSON.parse(payload)
    if (parsed.error) throw new McpError(String(parsed.error.message || 'MCP error'), parsed.error.code)
    return parsed.result
  } catch (err) {
    if (err instanceof McpError) throw err
    throw new McpError(`MCP request failed: ${(err as Error).message.slice(0, 120)}`)
  } finally {
    clearTimeout(timer)
  }
}

export interface McpToolInfo {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
  /** Heurion-side capability: read tools run immediately, writes are gated. */
  isWrite?: boolean
}

export class McpClient {
  constructor(private config: McpServerConfig) {}

  async initialize(): Promise<void> {
    await rpc(this.config.url, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'heurion', version: '1.0.0' },
    }, this.config.token)
  }

  async toolsList(): Promise<McpToolInfo[]> {
    const result = await rpc(this.config.url, 'tools/list', {}, this.config.token)
    const tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown>; annotations?: { readOnlyHint?: boolean } }> =
      Array.isArray(result?.tools) ? result.tools : []
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      isWrite: t.annotations?.readOnlyHint === false,
    }))
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<any> {
    const result = await rpc(this.config.url, 'tools/call', { name, arguments: args }, this.config.token)
    const content = Array.isArray(result?.content) ? result.content : []
    return content.map((c: any) => c?.text || '').join('\n') || JSON.stringify(result)
  }
}
