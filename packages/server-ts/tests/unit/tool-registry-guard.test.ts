import { describe, test, expect } from 'vitest'
import { BaseTool, type ToolResult } from '../../src/tools/base-tool.js'
import { ToolRegistry, type ToolContext } from '../../src/tools/tool-registry.js'

class HangingTool extends BaseTool {
  constructor(private ceiling?: number) { super() }
  get name(): string { return 'hanging_tool' }
  get description(): string { return 'hangs forever' }
  get parameters(): Record<string, unknown> { return { type: 'object', properties: {} } }
  get timeoutMs(): number | undefined { return this.ceiling }
  async execute(): Promise<ToolResult> {
    return new Promise(() => { /* never settles */ })
  }
}

class SlowTool extends BaseTool {
  constructor(private ceiling?: number) { super() }
  get name(): string { return 'slow_tool' }
  get description(): string { return 'settles after 50ms' }
  get parameters(): Record<string, unknown> { return { type: 'object', properties: {} } }
  get timeoutMs(): number | undefined { return this.ceiling }
  async execute(): Promise<ToolResult> {
    await new Promise((r) => setTimeout(r, 50))
    return { success: true, output: 'done' }
  }
}

function makeRegistry(ctxOverrides: Partial<ToolContext> = {}, tool: BaseTool = new HangingTool()): ToolRegistry {
  const ctx = {
    userId: 'user_1',
    memory: {} as any,
    facts: {} as any,
    episodes: {} as any,
    skills: {} as any,
    knowledge: {} as any,
    eventLog: { append: () => {}, query: () => [] } as any,
    ...ctxOverrides,
  } as ToolContext
  const registry = new ToolRegistry(ctx)
  registry.register(tool)
  return registry
}

/**
 * #828 — registry hang backstop: a stuck tool must return a structured
 * error instead of stalling the whole chat turn.
 */
describe('#828 ToolRegistry timeout/abort guard', () => {
  test('a hanging tool returns a timeout error after the tool ceiling', async () => {
    const registry = makeRegistry({}, new HangingTool(80))
    const res = await registry.execute('hanging_tool', {})
    expect(res.success).toBe(false)
    expect(res.error).toContain('hanging_tool')
    expect(res.error).toContain('被中止')
  })

  test('a tool that settles within the ceiling succeeds', async () => {
    const registry = makeRegistry({}, new SlowTool(5000))
    const res = await registry.execute('slow_tool', {})
    expect(res.success).toBe(true)
    expect(res.output).toBe('done')
  })

  test('an aborted turn signal resolves immediately with an abort error', async () => {
    const controller = new AbortController()
    controller.abort()
    const registry = makeRegistry({ signal: controller.signal }, new HangingTool(60_000))
    const res = await registry.execute('hanging_tool', {})
    expect(res.success).toBe(false)
    expect(res.error).toContain('aborted')
  })
})
