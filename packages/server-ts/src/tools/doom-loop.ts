/**
 * R3 — doom-loop detection (opencode processor.ts parity).
 *
 * The same tool called 3+ consecutive times with identical arguments is
 * almost always a stuck loop (the model keeps re-invoking because the
 * result doesn't satisfy it). Detected pre-execution so the extra calls
 * can be surfaced as a warning before burning more tokens.
 */

export interface ToolCallEntry {
  tool: string
  argsKey: string
}

function argsKeyOf(args: unknown): string {
  try {
    return JSON.stringify(args ?? {})
  } catch {
    return String(args ?? '')
  }
}

/**
 * Push the current call onto a rolling history and return whether it is a
 * doom-loop: the LAST THREE entries (including this one) are the same tool
 * with the same serialized arguments.
 */
export function detectDoomLoop(
  history: ToolCallEntry[],
  tool: string,
  args: unknown,
): boolean {
  const key = argsKeyOf(args)
  history.push({ tool, argsKey: key })
  if (history.length < 3) return false
  const last3 = history.slice(-3)
  return last3.every((e) => e.tool === tool && e.argsKey === key)
}
