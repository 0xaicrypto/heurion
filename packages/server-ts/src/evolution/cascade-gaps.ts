/**
 * P10 — Tool Store (for auto-created tools). P8/P9 (knowledge cascade /
 * gap queue) moved to the Prisma-backed knowledge-gap.service.
 */

export interface ToolRecord {
  id: string
  userId: string
  name: string
  description: string
  language: 'bash'
  script: string
  inputFormat: string
  createdFrom: string
  enabled: boolean
  createdAt: string
}

const toolStore = new Map<string, ToolRecord[]>()

export function getUserTools(userId: string): ToolRecord[] {
  return toolStore.get(userId) || []
}

export function deleteUserTool(userId: string, toolId: string): boolean {
  const tools = toolStore.get(userId) || []
  const idx = tools.findIndex(t => t.id === toolId)
  if (idx === -1) return false
  tools.splice(idx, 1)
  toolStore.set(userId, tools)
  return true
}

export function getEnabledTools(userId: string): ToolRecord[] {
  return getUserTools(userId).filter(t => t.enabled)
}
