/**
 * #645: auto-created tool store (formerly evolution/cascade-gaps.ts — the
 * file name described the removed P8/P9 knowledge-cascade, not its actual
 * content). Moved under modules/knowledge where its only consumer
 * (knowledge-stores.router) lives. Note: in-memory Map — not persisted.
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
