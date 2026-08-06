/**
 * #105: configurable permission rules — allow/deny/ask.
 * Modeled after opencode's permission.ts: wildcard coverage, later rules
 * win (more specific rules are inserted after general ones).
 */
export type PermissionEffect = 'allow' | 'deny' | 'ask'

export interface PermissionRule {
  id: string
  action: string
  resource: string
  effect: PermissionEffect
  role: string
  priority: number
}

export interface PermissionContext {
  userId: string
  role: string
  action: string
  resource: string
}

/** Wildcard match: '*' covers any value; otherwise exact equality. */
function wildcardMatch(pattern: string, value: string): boolean {
  if (pattern === '*' || pattern === value) return true
  if (pattern.endsWith('*') && value.startsWith(pattern.slice(0, -1))) return true
  return false
}

/**
 * Resolve the effective effect for a context. Later/higher-priority rules
 * win; no matching rule → 'ask' (default, backward compatible: everything
 * goes through the review queue).
 */
export function resolvePermission(rules: PermissionRule[], ctx: PermissionContext): PermissionEffect {
  let effect: PermissionEffect = 'ask'
  for (const rule of rules) {
    if (rule.effect !== 'allow' && rule.effect !== 'deny' && rule.effect !== 'ask') continue
    if (!wildcardMatch(rule.action, ctx.action)) continue
    if (!wildcardMatch(rule.resource, ctx.resource)) continue
    if (!wildcardMatch(rule.role, ctx.role)) continue
    effect = rule.effect
  }
  return effect
}
