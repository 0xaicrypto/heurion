import { describe, test, expect, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { EventLog } from '../../src/core/event-log.js'
import { FactsStore, EpisodesStore, SkillsStore, KnowledgeStore } from '../../src/evolution/stores.js'
import { ToolRegistry, type ToolContext } from '../../src/tools/tool-registry.js'
import { LoadSkillTool } from '../../src/tools/skill-tools.js'
import { BaseTool } from '../../src/tools/base-tool.js'

/**
 * #106: load_skill loads the full skill record on demand.
 * #107: replaced tools are detected as stale.
 */
let baseDir: string
let ctx: ToolContext

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-tools-'))
  const eventLog = new EventLog(baseDir, 'u1')
  ctx = {
    userId: 'u1',
    memory: {} as any,
    facts: new FactsStore(baseDir),
    episodes: new EpisodesStore(baseDir),
    skills: new SkillsStore(baseDir),
    knowledge: new KnowledgeStore(baseDir),
    eventLog,
  }
})

describe('load_skill (#106)', () => {
  test('returns the full skill record for an existing skill', async () => {
    ctx.skills.recordTask('clinical_review', 'summarize', true, '抽取结构化摘要，按 SOAP 组织')
    ctx.skills.recordTask('clinical_review', 'summarize', false, '抽取结构化摘要，按 SOAP 组织')

    const tool = new LoadSkillTool(ctx)
    const res = await tool.execute({ name: 'clinical_review' })
    expect(res.success).toBe(true)
    const out = JSON.parse(res.output as string)
    expect(out.name).toBe('clinical_review')
    expect(out.best_strategy).toContain('SOAP')
    expect(out.stats.task_count).toBe(2)
    expect(out.stats.success_rate).toBe(50)
  })

  test('unknown skill → clean error; missing name → error', async () => {
    const tool = new LoadSkillTool(ctx)
    const unknown = await tool.execute({ name: 'nope' })
    expect(unknown.success).toBe(false)
    expect(unknown.error).toContain('Unknown skill')
    const noName = await tool.execute({})
    expect(noName.success).toBe(false)
  })

  test('is registered in the ToolRegistry', () => {
    const registry = new ToolRegistry(ctx)
    expect(registry.get('load_skill')).toBeDefined()
    expect(registry.definitions.some((d) => d.function.name === 'load_skill')).toBe(true)
  })
})

describe('stale tool detection (#107)', () => {
  test('replaced tool with old version → stale error', async () => {
    const registry = new ToolRegistry(ctx)
    const v1 = registry.versionOf('load_skill')

    // Simulate a plugin update replacing the tool definition.
    registry.register(new LoadSkillTool(ctx))
    const v2 = registry.versionOf('load_skill')
    expect(v2).toBeGreaterThan(v1)

    const stale = await registry.execute('load_skill', { name: 'x' }, v1)
    expect(stale.success).toBe(false)
    expect(stale.error).toContain('Stale tool call')

    const current = await registry.execute('load_skill', { name: 'x' }, v2)
    expect(current.success).toBe(false) // unknown skill, but NOT stale
    expect(current.error).toContain('Unknown skill')
  })

  test('no expected version → executes normally', async () => {
    const registry = new ToolRegistry(ctx)
    const res = await registry.execute('load_skill', { name: 'nope' })
    expect(res.success).toBe(false)
    expect(res.error).toContain('Unknown skill')
  })
})
