import { describe, test, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { EventLog } from '../../src/core/event-log.js'
import { FactsStore, EpisodesStore, SkillsStore, KnowledgeStore } from '../../src/evolution/stores.js'
import { ToolRegistry, ToolContext } from '../../src/tools/tool-registry.js'
import { BaseTool } from '../../src/tools/base-tool.js'
import type { MemoryService } from '../../src/memory/memory.service.js'

/**
 * §3.3 (#193): tool execution must never take down a chat turn.
 *   - throwing tools → { success:false, error }
 *   - numeric params sanitized (no NaN)
 */
class ExplodingTool extends BaseTool {
  name = 'explode'
  description = 'always throws'
  parameters = { type: 'object' as const, properties: {} }
  async execute(): Promise<never> {
    throw new Error('boom')
  }
}

class EchoTopKTool extends BaseTool {
  name = 'echo_top_k'
  description = 'echoes top_k'
  parameters = { type: 'object' as const, properties: {} }
  async execute(args: Record<string, unknown>) {
    return { success: true, output: String(args.top_k ?? 'default') }
  }
}

describe('ToolRegistry resilience (§3.3 #193)', () => {
  let baseDir: string
  let ctx: ToolContext

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-registry-'))
    const eventLog = new EventLog(baseDir, 'u1')
    ctx = {
      userId: 'u1',
      memory: {} as MemoryService,
      facts: new FactsStore(baseDir),
      episodes: new EpisodesStore(baseDir),
      skills: new SkillsStore(baseDir),
      knowledge: new KnowledgeStore(baseDir),
      eventLog,
    }
  })

  test('a throwing tool returns { success:false, error } instead of crashing', async () => {
    const reg = new ToolRegistry(ctx)
    reg.register(new ExplodingTool())
    const result = await reg.execute('explode', {})
    expect(result.success).toBe(false)
    expect(result.error).toContain('boom')
  })

  test('numeric params passed as garbage fall back to defaults (no NaN)', async () => {
    const reg = new ToolRegistry(ctx)
    reg.register(new EchoTopKTool())
    const bad = await reg.execute('echo_top_k', { top_k: 'abc' })
    expect(bad.success).toBe(true)
    expect(bad.output).toBe('default')
    const numeric = await reg.execute('echo_top_k', { top_k: '7' })
    expect(numeric.output).toBe('7')
    const number = await reg.execute('echo_top_k', { top_k: 3 })
    expect(number.output).toBe('3')
  })

  test('unknown tool returns a clean error', async () => {
    const reg = new ToolRegistry(ctx)
    const result = await reg.execute('nope', {})
    expect(result.success).toBe(false)
    expect(result.error).toContain('Unknown tool')
  })
})
