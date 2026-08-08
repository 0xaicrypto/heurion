/**
 * #299: MCP connector tools — access external systems (EHR/imaging/lab)
 * through the Model Context Protocol instead of bespoke integrations.
 * Read calls run immediately; write calls are gated behind the approval
 * queue (#105) and reported instead of executed.
 */
import { BaseTool, ToolResult } from './base-tool.js'
import { McpClient, parseMcpServers } from './mcp-client.js'

export function configuredMcpServers(): string[] {
  return Object.keys(parseMcpServers(process.env.MCP_SERVERS))
}

// #417: prefer DB-managed servers (frontend-configurable); env stays a fallback.
async function dbServers(): Promise<Map<string, { url: string; capabilities: Array<'read' | 'write'>; token?: string }>> {
  try {
    const prisma = (await import('../common/prisma.js')).default
    const { decryptSettingValue } = await import('../modules/plugins/plugin-settings-encryption.service.js')
    const rows = await (prisma as any).mcpServer.findMany({ where: { enabled: 1 } })
    const map = new Map<string, { url: string; capabilities: Array<'read' | 'write'>; token?: string }>()
    for (const r of rows) {
      let caps: Array<'read' | 'write'> = ['read']
      try { caps = JSON.parse(r.capabilities).filter((c: string) => c === 'read' || c === 'write') } catch { /* default */ }
      map.set(r.name, { url: r.url, capabilities: caps, token: r.tokenEnc ? decryptSettingValue(r.tokenEnc) : undefined })
    }
    return map
  } catch {
    return new Map()
  }
}

async function getClient(name: string): Promise<McpClient | null> {
  const db = await dbServers()
  const dbCfg = db.get(name)
  if (dbCfg) return new McpClient({ url: dbCfg.url, capabilities: dbCfg.capabilities, token: dbCfg.token })
  const cfg = parseMcpServers(process.env.MCP_SERVERS)[name]
  if (!cfg) return null
  return new McpClient(cfg)
}

/** #299: list tools exposed by a configured external MCP server. */
export class McpListToolsTool extends BaseTool {
  get name(): string { return 'mcp_list_tools' }
  get description(): string {
    const names = configuredMcpServers()
    return `List tools exposed by a configured external system (MCP). Configured servers: ${names.length ? names.join(', ') : 'none (set MCP_SERVERS env)'}. Read-only.`
  }
  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Configured MCP server name' },
      },
      required: ['server'],
    }
  }
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const name = String(args.server || '')
    const client = await getClient(name)
    if (!client) {
      return { success: false, error: `MCP server "${name}" is not configured (add it in Settings → Integrations, or set MCP_SERVERS env)` }
    }
    try {
      await client.initialize()
      const tools = await client.toolsList()
      if (tools.length === 0) return { success: true, output: `No tools exposed by ${name}` }
      const lines = tools.map((t) => {
        const write = t.isWrite ? ' [WRITE — requires approval]' : ''
        return `- ${t.name}${write}: ${t.description || ''}`
      })
      return { success: true, output: `Tools on ${name}:\n${lines.join('\n')}` }
    } catch (err) {
      return { success: false, error: `mcp_list_tools failed: ${(err as Error).message.slice(0, 200)}` }
    }
  }
}

/** #299: call a tool on a configured external MCP server. */
export class McpCallToolTool extends BaseTool {
  get name(): string { return 'mcp_call_tool' }
  get description(): string {
    return 'Call a tool on an external system via MCP (EHR/imaging/lab connectors). Read tools execute immediately; write tools are NOT executed — they return an approval-required notice (Gatekeeper, #105). Use mcp_list_tools first to discover names and capabilities.'
  }
  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'Configured MCP server name' },
        tool: { type: 'string', description: 'Tool name from mcp_list_tools' },
        arguments: { type: 'object', description: 'Tool arguments' },
      },
      required: ['server', 'tool'],
    }
  }
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const name = String(args.server || '')
    const tool = String(args.tool || '')
    const toolArgs = (args.arguments as Record<string, unknown>) || {}
    const client = await getClient(name)
    if (!client) return { success: false, error: `MCP server "${name}" is not configured (add it in Settings → Integrations, or set MCP_SERVERS env)` }

    try {
      await client.initialize()
      const tools = await client.toolsList()
      const info = tools.find((t) => t.name === tool)
      if (!info) return { success: false, error: `Tool "${tool}" not found on ${name}` }

      // Gatekeeper: write calls require approval — report instead of run.
      if (info.isWrite) {
        return {
          success: true,
          output: `[WRITE-GATED] "${tool}" is a write operation on ${name}. It was NOT executed. Submit it for approval (审批队列) before running.`,
        }
      }

      const result = await client.callTool(tool, toolArgs)
      return { success: true, output: String(result).slice(0, 8000) }
    } catch (err) {
      return { success: false, error: `mcp_call_tool failed: ${(err as Error).message.slice(0, 200)}` }
    }
  }
}
