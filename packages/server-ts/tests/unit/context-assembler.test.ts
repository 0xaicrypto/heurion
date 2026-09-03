import { describe, test, expect } from 'vitest'
import { ContextAssembler, OUTPUT_FORMAT_RULES } from '../../src/modules/chat/context-assembler.js'
import { ContextBudget } from '../../src/modules/shared/chat-context.js'
import type { SegmentBuildInput } from '../../src/modules/chat/context-assembler.js'

function input(overrides: Partial<SegmentBuildInput> = {}): SegmentBuildInput {
  return {
    userId: 'u1',
    sid: 's1',
    patientHash: null,
    scene: 'general',
    body: { text: 'hi' },
    ctx: {},
    projected: {
      systemPrompt: 'persona',
      segments: [{ key: 'persona', text: 'persona' }],
    },
    budget: new ContextBudget(),
    layer3FactHashes: new Set(),
    historyTokens: 0,
    ...overrides,
  }
}

describe('#637 阶段2 ContextAssembler', () => {
  test('稳定段前置 + 动态段尾部,渲染包含全部段', async () => {
    const a = new ContextAssembler([
      { key: 'study_context', fallbackOrder: 3, build: async () => '## Active Research Studies\n- NSC' },
      { key: 'knowledge_inject', fallbackOrder: 1, build: async () => '## 知识库参考' },
    ])
    const res = await a.assemble(input())
    expect(res.systemPrompt).toContain('persona')
    expect(res.systemPrompt).toContain(OUTPUT_FORMAT_RULES)
    expect(res.systemPrompt).toContain('Active Research Studies')
    expect(res.systemPrompt).toContain('知识库参考')
    // 顺序: persona → rules → study → kb
    expect(res.systemPrompt.indexOf('persona')).toBeLessThan(res.systemPrompt.indexOf('知识库参考'))
    expect(res.segmentState).not.toBeNull()
  })

  test('budget 逐段刷新 — 后注册 builder 读到最新剩余预算', async () => {
    const seen: number[] = []
    const a = new ContextAssembler([
      { key: 'big', fallbackOrder: 1, build: async () => { seen.push(0); return 'X'.repeat(4000) } },
      {
        key: 'after', fallbackOrder: 0,
        build: async (i) => { seen.push(i.budget.remaining()); return '' },
      },
    ])
    await a.assemble(input())
    expect(seen.length).toBe(2)
    // 后注册 builder 读到的是扣减后(big 段已占用)的剩余预算
    expect(seen[1]).toBeGreaterThan(0)
    expect(seen[1]).toBeLessThan(64000)
  })

  test('required 段缺失 → 记入 telemetry(不静默)', async () => {
    const a = new ContextAssembler([
      { key: 'must', fallbackOrder: 0, required: true, build: async () => { throw new Error('boom') } },
      { key: 'optional', fallbackOrder: 0, build: async () => '' },
    ])
    const res = await a.assemble(input())
    expect(res.telemetry.some((t) => t.startsWith('segment must FAILED'))).toBe(true)
    expect(res.systemPrompt).toContain('## 输出格式规范')
  })

  test('段级回退: 按 fallbackOrder 逆序移除(0 最先),未注册段不动', async () => {
    const a = new ContextAssembler([
      { key: 'study_context', fallbackOrder: 3, build: async () => 'S' },
      { key: 'knowledge_inject', fallbackOrder: 1, build: async () => 'K' },
      { key: 'picked_kb', fallbackOrder: 0, build: async () => 'P' },
    ])
    const res = await a.assemble(input())
    const messages = [
      { role: 'system', content: res.systemPrompt },
      { role: 'user', content: 'q'.repeat(100000) },
    ] as any
    const { droppedSegments } = a.segmentFallback(
      messages, 5000, res.segmentState, res.renderFiltered,
      (msgs) => msgs.reduce((acc: number, m: any) => acc + String(m.content).length / 4, 0),
    )
    expect(droppedSegments).toEqual(['picked_kb', 'knowledge_inject', 'study_context'])
    expect(messages[0].content).not.toContain('P')
    expect(messages[0].content).not.toContain('K')
    expect(messages[0].content).toContain('persona')
  })

  test('#814 让位顺序: layer3 碎片最先让位,随后自动注入,用户钉选最后', async () => {
    const a = new ContextAssembler([
      { key: 'knowledge_inject', fallbackOrder: 0, build: async () => 'K' },
      { key: 'picked_kb', fallbackOrder: 1, build: async () => 'P' },
    ])
    const res = await a.assemble(input({
      projected: {
        systemPrompt: 'persona',
        segments: [
          { key: 'persona', text: 'persona' },
          { key: 'accumulated_knowledge', text: 'FRAGMENTS' },
        ],
      },
    }))
    const messages = [
      { role: 'system', content: res.systemPrompt },
      { role: 'user', content: 'q'.repeat(100000) },
    ] as any
    const { droppedSegments } = a.segmentFallback(
      messages, 5000, res.segmentState, res.renderFiltered,
      (msgs) => msgs.reduce((acc: number, m: any) => acc + String(m.content).length / 4, 0),
    )
    expect(droppedSegments).toEqual(['accumulated_knowledge', 'knowledge_inject', 'picked_kb'])
    expect(messages[0].content).not.toContain('FRAGMENTS')
    expect(messages[0].content).toContain('persona')
  })
})
