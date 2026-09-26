import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Rule 4 / P0 — MCP 服务器租户隔离 + 写操作 fail-closed。
 *
 * 修复前：
 *  1) dbServers() 查全部 enabled=1 的 MCP 服务器 — 用户 B 能调用 A 配置的
 *     服务器并带上 A 的 token；
 *  2) isWrite = annotations.readOnlyHint === false — 未声明注解的工具被当成
 *     只读直接执行（write 审批门形同虚设）。
 */
const mocks = vi.hoisted(() => ({
  mcpServerFindMany: vi.fn(),
}))

vi.mock('../../src/common/prisma.js', () => ({
  default: { mcpServer: { findMany: mocks.mcpServerFindMany } },
}))

import { McpListToolsTool, McpCallToolTool } from '../../src/tools/mcp-tools.js'
import { McpClient } from '../../src/tools/mcp-client.js'
import type { ToolContext } from '../../src/tools/tool-registry.js'

function ctxFor(userId: string): ToolContext {
  return { userId, eventLog: { append: vi.fn(), query: () => [] } } as unknown as ToolContext
}

const A_SERVER = { name: 'ehr', url: 'https://ehr.example.com/mcp', capabilities: '["read"]', tokenEnc: null }
const ALL_SERVERS = [{ ...A_SERVER, userId: 'userA' }]

beforeEach(() => {
  vi.clearAllMocks()
  // 模拟 DB 归属语义：where.userId 缺失 → 全表（修复前行为）。
  mocks.mcpServerFindMany.mockImplementation(async (args: { where?: { userId?: string } } = {}) => {
    const rows = args.where?.userId ? ALL_SERVERS.filter((r) => r.userId === args.where!.userId) : ALL_SERVERS
    return rows
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('P0 Rule 4: MCP 服务器按 userId 过滤', () => {
  test('用户 B 看不到 A 配置的服务器（不触发网络、不泄露 token）', async () => {
    const result = await new McpListToolsTool(ctxFor('userB')).execute({ server: 'ehr' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('not configured')
    expect(mocks.mcpServerFindMany).toHaveBeenCalledWith({ where: { enabled: 1, userId: 'userB' } })
  })

  test('McpCallToolTool 同样带 userId 过滤（B 无法借 A 的服务器执行）', async () => {
    const result = await new McpCallToolTool(ctxFor('userB')).execute({ server: 'ehr', tool: 'anything' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('not configured')
    expect(mocks.mcpServerFindMany).toHaveBeenCalledWith({ where: { enabled: 1, userId: 'userB' } })
  })
})

describe('P0 Rule 4: MCP 写操作 fail-closed（无注解 = 写，必须审批）', () => {
  test('toolsList: 未声明 readOnlyHint 的工具视为写', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      result: {
        tools: [
          { name: 'no_annotations' },
          { name: 'explicit_read', annotations: { readOnlyHint: true } },
          { name: 'explicit_write', annotations: { readOnlyHint: false } },
        ],
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })))

    const client = new McpClient({ url: 'https://mcp.example.com', capabilities: ['read'] })
    const tools = await client.toolsList()
    expect(tools.find((t) => t.name === 'no_annotations')?.isWrite).toBe(true)
    expect(tools.find((t) => t.name === 'explicit_read')?.isWrite).toBe(false)
    expect(tools.find((t) => t.name === 'explicit_write')?.isWrite).toBe(true)
  })

  test('mcp_call_tool: 无注解工具返回 WRITE-GATED，绝不发 tools/call', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}')) as { method?: string }
      calls.push(body.method || '')
      if (body.method === 'tools/list') {
        return new Response(JSON.stringify({ result: { tools: [{ name: 'danger', description: 'no hints' }] } }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ result: {} }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))

    const result = await new McpCallToolTool(ctxFor('userA')).execute({ server: 'ehr', tool: 'danger', arguments: {} })
    expect(result.success).toBe(true)
    expect(result.output).toContain('WRITE-GATED')
    expect(calls).not.toContain('tools/call')
  })
})
