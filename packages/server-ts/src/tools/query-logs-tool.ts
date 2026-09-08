import { BaseTool, ToolResult } from './base-tool.js'
import prisma from '../common/prisma.js'
import { queryLoki, type LogQueryFilters } from '../common/log-query.js'

/**
 * #801 — query_logs: AI 排障一等能力。「查日志」不再需要人工 SSH +
 * python 解析:agent 直接以语义过滤键检索 Loki(容器重建不丢,30d 保留)。
 * 仅管理员可用(日志含跨用户数据);非 admin 从工具列表即被剔除
 * (tool-registry getDefinitionsForUser),execute 里再校验一次兜底。
 */
export async function isUserAdmin(userId: string): Promise<boolean> {
  try {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } })
    return u?.role === 'admin'
  } catch {
    return false
  }
}

export class QueryLogsTool extends BaseTool {
  constructor(private ctx: { userId: string }) {
    super()
  }

  get name(): string { return 'query_logs' }

  get description(): string {
    return [
      'Query production server logs (last 30 days, survives restarts) for debugging. Admin-only.',
      'Semantic filters — no query syntax needed: container (nexus-server/nexus-worker/nexus-caddy/…), module (e.g. files.download, chat.tool-loop, llm-gateway, chart-token), level (info/warn/error), session_id, doc_id, file_id, tool, q (full-text substring), since ("30m"/"2h"/"1d" or ISO time), limit (max 500).',
      'Examples: "why are images broken" → container=nexus-server module=files.download; "did the LLM time out" → q="LLM" level=error.',
      'Combine module/level with a time window for precise triage. Returns compact JSON lines (newest first).',
    ].join(' ')
  }

  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        container: { type: 'string', description: 'Container name filter (regex). e.g. nexus-server' },
        module: { type: 'string', description: 'App module, e.g. files.download, chat.tool-loop, llm-gateway' },
        level: { type: 'string', enum: ['info', 'warn', 'error'], description: 'Minimum severity filter' },
        session_id: { type: 'string', description: 'Chat/doc session id' },
        doc_id: { type: 'string', description: 'Document id' },
        file_id: { type: 'string', description: 'File id' },
        tool: { type: 'string', description: 'Tool name (tool_call events)' },
        q: { type: 'string', description: 'Full-text substring in the log line' },
        since: { type: 'string', description: 'Time window: "30m"/"2h"/"1d" or ISO timestamp (default 1h, max 7d)' },
        limit: { type: 'number', description: 'Max lines (default 200, max 500)' },
      },
      required: [],
    }
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    if (!(await isUserAdmin(this.ctx.userId))) {
      return { success: false, error: 'query_logs is admin-only (logs contain cross-user data)' }
    }
    const str = (k: string) => (typeof args[k] === 'string' ? (args[k] as string).trim() || undefined : undefined)
    const filters: LogQueryFilters = {
      container: str('container'),
      module: str('module'),
      level: str('level'),
      sessionId: str('session_id'),
      docId: str('doc_id'),
      fileId: str('file_id'),
      tool: str('tool'),
      q: str('q'),
      since: str('since'),
      limit: typeof args.limit === 'number' ? args.limit : 200,
    }
    const { lines, total, error } = await queryLoki(filters)
    if (error) return { success: false, error }
    if (lines.length === 0) {
      return { success: true, output: 'no matching log lines — widen the time window (since), drop filters, or check container/module spelling.' }
    }
    const body = lines.slice(0, 120).map((l) => {
      const tag = [l.module, l.level].filter(Boolean).join('/')
      return `${l.ts} [${l.container}${tag ? ` ${tag}` : ''}] ${l.line}`
    }).join('\n')
    const hint = total > 120 ? `\n(showing 120/${total} — narrow with module/level/q or lower since)` : ''
    return { success: true, output: `${body}${hint}` }
  }
}
