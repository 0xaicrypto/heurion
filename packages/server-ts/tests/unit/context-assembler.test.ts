import { describe, test, expect } from 'vitest'
import { ContextAssembler, OUTPUT_FORMAT_RULES, RequiredSegmentError } from '../../src/modules/chat/context-assembler.js'
import { ContextBudget } from '../../src/modules/shared/chat-context.js'
import { CONTEXT_CONFIG } from '../../src/common/context-config.js'
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
    // 后注册 builder 读到的是扣减后(big 段已占用)的剩余预算 — 相对默认
    // 总预算断言(不与具体数值耦合,总预算上调测试不需改)。
    expect(seen[1]).toBeGreaterThan(0)
    expect(seen[1]).toBeLessThan(CONTEXT_CONFIG.maxTotalTokens)
  })

  test('#905 required 段 builder 抛错 → assemble 硬失败(rejects,带 key+telemetry),不再静默进 LLM', async () => {
    const a = new ContextAssembler([
      { key: 'must', fallbackOrder: 0, required: true, build: async () => { throw new Error('boom') } },
      { key: 'optional', fallbackOrder: 0, build: async () => 'O' },
    ])
    let caught: unknown
    try {
      await a.assemble(input())
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(RequiredSegmentError)
    const e = caught as RequiredSegmentError
    expect(e.key).toBe('must')
    expect(e.message).toContain('boom')
    // telemetry 随错误携带,调用方可落日志/对账。
    expect(e.telemetry.some((t) => t.startsWith('segment must FAILED'))).toBe(true)
  })

  test('#905 required 段返回空串 = 合法降级 → 仅记 MISSING,不硬失败', async () => {
    const a = new ContextAssembler([
      { key: 'document_context', fallbackOrder: 0, required: true, build: async () => '' },
      { key: 'optional', fallbackOrder: 0, build: async () => 'O' },
    ])
    const res = await a.assemble(input())
    expect(res.telemetry).toContain('segment document_context MISSING')
    expect(res.systemPrompt).toContain('O')
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

  // #fix 2026-09 回归:组装阶段进度 — 带 stageLabel 的动态段开始构建时
  // 按注册序回调 onStage,无 label 的段不触发;onStage 抛错不影响组装。
  test('onStage 按序下发阶段提示,throw 被吞掉', async () => {
    const order: string[] = []
    const a = new ContextAssembler([
      { key: 'study_context', fallbackOrder: 3, build: async () => 'S' },
      { key: 'document_context', fallbackOrder: 2, stageLabel: '正在解析文档与参考材料…', build: async () => 'D' },
      { key: 'knowledge_inject', fallbackOrder: 0, stageLabel: '正在检索知识库…', build: async () => 'K' },
    ])
    const res = await a.assemble(input(), (label) => {
      order.push(label)
      if (label === '正在解析文档与参考材料…') throw new Error('sse down')
    })
    expect(order).toEqual(['正在解析文档与参考材料…', '正在检索知识库…'])
    expect(res.systemPrompt).toContain('D')
    expect(res.systemPrompt).toContain('K')
  })
})
