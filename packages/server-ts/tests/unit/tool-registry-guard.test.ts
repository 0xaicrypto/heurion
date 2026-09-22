import { describe, test, expect } from 'vitest'
import { BaseTool, type ToolResult, ABORTED_WRITE_ERROR } from '../../src/tools/base-tool.js'
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

/**
 * #1103 — write-class tool shape: sleeps past the guard's timeout ceiling,
 * then (at its "write point") checks the threaded signal and refuses the
 * write. `writes` is the sentinel standing in for writeDocVersion.
 */
class LateWriterTool extends BaseTool {
  writes = 0
  sawSignal: AbortSignal | null = null
  constructor(private ceiling: number | undefined = 80) { super() }
  get name(): string { return 'late_writer' }
  get description(): string { return 'writes after a long sleep' }
  get parameters(): Record<string, unknown> { return { type: 'object', properties: {} } }
  get timeoutMs(): number | undefined { return this.ceiling }
  async execute(_args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    this.sawSignal = signal ?? null
    await new Promise((r) => setTimeout(r, 200))
    // write-class guard pattern — exactly what the DOC_WRITE_TOOLS do
    if (signal?.aborted) return { success: false, error: ABORTED_WRITE_ERROR }
    this.writes++
    return { success: true, output: 'written' }
  }
}

/** Backwards-compat twin: ignores the signal entirely (legacy tool shape). */
class LegacyWriterTool extends BaseTool {
  writes = 0
  get name(): string { return 'legacy_writer' }
  get description(): string { return 'writes without checking any signal' }
  get parameters(): Record<string, unknown> { return { type: 'object', properties: {} } }
  async execute(): Promise<ToolResult> {
    await new Promise((r) => setTimeout(r, 30))
    this.writes++
    return { success: true, output: 'written' }
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

describe('#1103 guard cancels tool internals (no late write)', () => {
  test('timed-out write tool: signal fired + write point skipped + caller got the timeout result', async () => {
    const tool = new LateWriterTool()
    const registry = makeRegistry({}, tool)
    const res = await registry.execute('late_writer', {})
    // caller already received the failure
    expect(res.success).toBe(false)
    expect(res.error).toContain('late_writer')
    expect(res.error).toContain('被中止')
    // the tool's "write" never happened — the guard's controller aborted
    // the threaded signal before the write point ran
    expect(tool.writes).toBe(0)
    expect(tool.sawSignal).toBeInstanceOf(AbortSignal)
    expect(tool.sawSignal!.aborted).toBe(true)
  })

  test('turn aborted mid-run: write point skipped, caller got the abort result', async () => {
    const controller = new AbortController()
    // no per-tool ceiling — default 120s applies; the abort is what settles it
    const tool = new LateWriterTool(undefined)
    const registry = makeRegistry({ signal: controller.signal }, tool)
    // abort mid-run, while the tool is sleeping
    setTimeout(() => controller.abort(), 20)
    const res = await registry.execute('late_writer', {})
    expect(res.success).toBe(false)
    expect(res.error).toContain('aborted')
    expect(tool.writes).toBe(0)
  })

  test('legacy tool ignoring the signal keeps working (no behavior regression)', async () => {
    const tool = new LegacyWriterTool()
    const registry = makeRegistry({}, tool)
    const res = await registry.execute('legacy_writer', {})
    expect(res.success).toBe(true)
    expect(res.output).toBe('written')
    expect(tool.writes).toBe(1)
  })

  test('a tool honoring the abort gives up before its ceiling (guard controller reaches tool internals)', async () => {
    class AbortAwareTool extends BaseTool {
      sawAbort = false
      get name(): string { return 'abort_aware' }
      get description(): string { return 'sleeps until aborted, then reports' }
      get parameters(): Record<string, unknown> { return { type: 'object', properties: {} } }
      get timeoutMs(): number | undefined { return 5000 }
      async execute(_args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, 3000)
          signal?.addEventListener('abort', () => { clearTimeout(t); this.sawAbort = true; reject(new Error(ABORTED_WRITE_ERROR)) }, { once: true })
        })
        return { success: true, output: 'written' }
      }
    }
    const tool = new AbortAwareTool()
    const turn = new AbortController()
    const registry = makeRegistry({ signal: turn.signal }, tool)
    // turn aborted mid-run, long before the tool's 5s ceiling
    setTimeout(() => turn.abort(), 50)
    const res = await registry.execute('abort_aware', {})
    // the turn-abort path aborted the guard controller → the threaded signal
    // fired inside the tool, which gave up long before its ceiling
    expect(res.success).toBe(false)
    expect(res.error).toContain('aborted')
    expect(tool.sawAbort).toBe(true)
  })
})
