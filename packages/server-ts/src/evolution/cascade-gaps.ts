/**
 * P8 — Knowledge Cascade & P9 — Knowledge Gap Queue
 *
 * P8: When Facts change, mark dependent Knowledge articles as stale.
 * P9: Knowledge Gap detection — when query finds nothing, track gap.
 */

export interface KnowledgeGap {
  id: string
  userId: string
  query: string
  context: string
  detectedAt: string
  status: 'pending' | 'resolved' | 'dismissed'
}

/** In-memory gap store (replace with Prisma/DB in production) */
const gapStore = new Map<string, KnowledgeGap[]>()

export function detectGap(query: string, userId: string, resultsFound: number, context = ''): KnowledgeGap | null {
  if (resultsFound > 0) return null
  const gap: KnowledgeGap = {
    id: `gap_${Date.now()}`,
    userId,
    query: query.slice(0, 200),
    context: context.slice(0, 200),
    detectedAt: new Date().toISOString(),
    status: 'pending',
  }
  const existing = gapStore.get(userId) || []
  existing.push(gap)
  gapStore.set(userId, existing)
  return gap
}

export function getPendingGaps(userId: string): KnowledgeGap[] {
  return (gapStore.get(userId) || []).filter(g => g.status === 'pending')
}

export function resolveGap(userId: string, gapId: string): boolean {
  const gaps = gapStore.get(userId) || []
  const gap = gaps.find(g => g.id === gapId)
  if (gap) { gap.status = 'resolved'; return true }
  return false
}

/**
 * P10 — Tool Store (for auto-created tools)
 */

export interface ToolRecord {
  id: string
  userId: string
  name: string
  description: string
  language: 'python' | 'bash'
  script: string
  inputFormat: string
  createdFrom: string
  enabled: boolean
  createdAt: string
}

const toolStore = new Map<string, ToolRecord[]>()

export function registerTool(tool: Omit<ToolRecord, 'id' | 'createdAt' | 'enabled'>): ToolRecord {
  const record: ToolRecord = {
    ...tool,
    id: `tool_${Date.now()}`,
    enabled: false,
    createdAt: new Date().toISOString(),
  }
  const existing = toolStore.get(tool.userId) || []
  existing.push(record)
  toolStore.set(tool.userId, existing)
  return record
}

export function getUserTools(userId: string): ToolRecord[] {
  return toolStore.get(userId) || []
}

export function enableTool(userId: string, toolId: string): boolean {
  const tools = toolStore.get(userId) || []
  const tool = tools.find(t => t.id === toolId)
  if (tool) { tool.enabled = true; return true }
  return false
}

export function getEnabledTools(userId: string): ToolRecord[] {
  return getUserTools(userId).filter(t => t.enabled)
}
