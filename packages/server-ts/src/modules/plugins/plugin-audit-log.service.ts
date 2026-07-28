import prisma from '../../common/prisma.js'

export interface PluginAuditInput {
  userId: string
  pluginId: string
  toolName: string
  jobId: string
  status: string
  durationMs: number
  inputSummary?: string
  errorMessage?: string
}

export interface PluginAuditLogQuery {
  pluginId?: string
  status?: string
  limit?: number
  offset?: number
}

export async function listPluginAuditLogs(userId: string, query: PluginAuditLogQuery = {}) {
  const where: Record<string, unknown> = { userId }
  if (query.pluginId) where.pluginId = query.pluginId
  if (query.status) where.status = query.status

  const [logs, total] = await Promise.all([
    prisma.pluginAuditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: query.limit ?? 50,
      skip: query.offset ?? 0,
    }),
    prisma.pluginAuditLog.count({ where }),
  ])

  return { logs, total }
}

export async function recordPluginInvocation(audit: PluginAuditInput): Promise<void> {
  await prisma.pluginAuditLog.create({
    data: {
      userId: audit.userId,
      pluginId: audit.pluginId,
      toolName: audit.toolName,
      jobId: audit.jobId,
      status: audit.status,
      durationMs: audit.durationMs,
      inputSummary: audit.inputSummary ?? '',
      errorMessage: audit.errorMessage ?? '',
      createdAt: new Date().toISOString(),
    },
  })
}

export function buildInputSummary(payload: Record<string, unknown>): string {
  const summary: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(payload)) {
    if (key === 'data' || key === 'patient' || key.startsWith('patient_')) {
      summary[key] = '<redacted>'
      continue
    }

    if (typeof value === 'string') {
      summary[key] = value.slice(0, 200)
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      summary[key] = value
    } else if (value === null || value === undefined) {
      summary[key] = value
    } else if (Array.isArray(value)) {
      summary[key] = `[array:${value.length}]`
    } else if (typeof value === 'object') {
      summary[key] = '<object>'
    }
  }

  try {
    return JSON.stringify(summary)
  } catch {
    return ''
  }
}
