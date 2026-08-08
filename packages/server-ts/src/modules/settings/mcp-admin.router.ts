/**
 * #417: MCP server management — frontend-configurable connectors stored in
 * the DB (token encrypted via plugin-settings-encryption), replacing the
 * env-only MCP_SERVERS. Write-calls flow through the approval queue (#105):
 * WRITE-GATED requests create an ApprovalRequest; an admin confirmation
 * executes the call.
 */
import { FastifyInstance } from 'fastify'
import { authGuard } from '../../common/auth.guard'
import prisma from '../../common/prisma'
import { encryptSettingValue, decryptSettingValue } from '../plugins/plugin-settings-encryption.service.js'
import { McpClient } from '../../tools/mcp-client.js'

function parseCaps(raw: string): Array<'read' | 'write'> {
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((c) => c === 'read' || c === 'write') : ['read']
  } catch {
    return ['read']
  }
}

export async function mcpAdminRouter(app: FastifyInstance) {
  app.addHook('preHandler', authGuard)

  // ── CRUD ──
  app.get('/api/v1/settings/mcp-servers', async (request) => {
    const rows = await (prisma as any).mcpServer.findMany({
      where: { userId: request.user!.userId },
      orderBy: { createdAt: 'desc' },
    })
    return {
      servers: rows.map((r: any) => ({
        id: r.id, name: r.name, url: r.url,
        capabilities: parseCaps(r.capabilities), enabled: r.enabled === 1,
        has_token: !!r.tokenEnc, created_at: r.createdAt,
      })),
    }
  })

  app.post('/api/v1/settings/mcp-servers', async (request, reply) => {
    const { name, url, capabilities, token } = request.body as any
    if (!name || !String(name).trim()) return reply.status(400).send({ error: 'name required' })
    if (!url || !/^https?:\/\//.test(String(url))) return reply.status(400).send({ error: 'url must start with http(s)://' })
    const caps = Array.isArray(capabilities) ? capabilities.filter((c) => c === 'read' || c === 'write') : ['read']
    const now = new Date().toISOString()
    const row = await (prisma as any).mcpServer.create({
      data: {
        userId: request.user!.userId,
        name: String(name).trim(),
        url: String(url).trim(),
        capabilities: JSON.stringify(caps),
        tokenEnc: token ? encryptSettingValue(String(token)) : null,
        enabled: 1, createdAt: now, updatedAt: now,
      },
    })
    return { server: { id: row.id, name: row.name, url: row.url, capabilities: caps, enabled: true } }
  })

  app.delete('/api/v1/settings/mcp-servers/:id', async (request, reply) => {
    const { id } = request.params as any
    const row = await (prisma as any).mcpServer.findFirst({ where: { id, userId: request.user!.userId } })
    if (!row) return reply.status(404).send({ error: 'server not found' })
    await (prisma as any).mcpServer.delete({ where: { id } })
    return { deleted: true }
  })

  // ── Test connection + list tools ───────────────────────────────────
  app.post('/api/v1/settings/mcp-servers/:id/test', async (request, reply) => {
    const { id } = request.params as any
    const row = await (prisma as any).mcpServer.findFirst({ where: { id, userId: request.user!.userId } })
    if (!row) return reply.status(404).send({ error: 'server not found' })
    try {
      const client = new McpClient({ url: row.url, capabilities: parseCaps(row.capabilities), token: row.tokenEnc ? decryptSettingValue(row.tokenEnc) : undefined })
      await client.initialize()
      const tools = await client.toolsList()
      return { ok: true, tools: tools.map((t) => ({ name: t.name, description: t.description, is_write: !!t.isWrite })) }
    } catch (err) {
      return reply.status(502).send({ error: `Connection failed: ${(err as Error).message.slice(0, 200)}` })
    }
  })

  // ── Write-approval: execute a write call after admin confirmation ──
  app.post('/api/v1/settings/mcp-servers/:id/call', async (request, reply) => {
    const { id } = request.params as any
    const { tool, arguments: toolArgs } = request.body as any
    // Own-server access only — the write-gate lives in the tool layer (#105).
    const row = await (prisma as any).mcpServer.findFirst({ where: { id, userId: request.user!.userId } })
    if (!row) return reply.status(404).send({ error: 'server not found' })
    if (!tool) return reply.status(400).send({ error: 'tool required' })
    try {
      const client = new McpClient({ url: row.url, capabilities: parseCaps(row.capabilities), token: row.tokenEnc ? decryptSettingValue(row.tokenEnc) : undefined })
      await client.initialize()
      const result = await client.callTool(String(tool), (toolArgs as Record<string, unknown>) || {})
      return { ok: true, result: String(result).slice(0, 8000) }
    } catch (err) {
      return reply.status(502).send({ error: `Call failed: ${(err as Error).message.slice(0, 200)}` })
    }
  })
}
