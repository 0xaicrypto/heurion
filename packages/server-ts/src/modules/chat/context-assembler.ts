/**
 * #637 阶段 2 — 上下文装配管线。
 *
 * runConversationTurn 的 system 侧组装从 God Function 提取为:
 * 各段独立 builder(study/doc/kb/picked)+ 装配器(排段/快照/渲染/
 * 预算刷新/段级回退/出口断言)。新增注入源 = 注册一个 builder,
 * 不再往函数中间插代码。
 *
 * 顺序契约: 稳定段(projection segments + output_format_rules)前置,
 * 动态段按注册顺序尾部追加(#631 方案 D — 前缀缓存损失最小)。
 */
import { makeLogger } from '../../common/logger.js'
import { estimateTokens } from '../../common/token-estimate.js'
import type { SegmentState } from '../../memory/context-sources.js'
import type { ContextBudget } from '../shared/chat-context.js'

export interface SegmentBuildInput {
  userId: string
  sid: string
  patientHash: string | null
  scene: string
  body: { text: string; picked_kb_ids?: string[] }
  ctx: any
  /** projection 输出(稳定段来源)。 */
  projected: { systemPrompt: string; segments: Array<{ key: string; text: string }> }
  /** 预算对象 — builder 内读 budget.remaining() 做自适应;装配器逐段刷新。 */
  budget: ContextBudget
  /** #627: layer3 已注入事实的 contentHash 集(自动注入去重用)。 */
  layer3FactHashes: Set<string>
  /** 历史占用 token — budget.allocateHistory 用(#630 口径)。 */
  historyTokens: number
}

export interface SegmentBuilderSpec {
  key: string
  /** 回退优先级: 0=最先回退; -1=不可回退。 */
  fallbackOrder: number
  /** 出口断言: required 段缺失/失败 → 记 telemetry,不静默。 */
  required?: boolean
  build(input: SegmentBuildInput): Promise<string>
}

export interface AssemblyResult {
  /** 渲染完成的 system prompt。 */
  systemPrompt: string
  segmentState: Record<string, SegmentState> | null
  renderFiltered: ((base: string, state: Record<string, SegmentState>, excluded?: Iterable<string>) => string) | null
  /** 出口断言记录(required 段失败/缺失)。 */
  telemetry: string[]
}

/** #598/#631: 全局输出格式规范 — 常量稳定段。 */
export const OUTPUT_FORMAT_RULES = `
## 输出格式规范
- 使用标准 Markdown 语法。表格的分隔行必须是 | --- | --- | 形式;不要写成 |--、---| 等不标准形式。
- 展示单个标点或字符修改(如 .. → .)时,用普通文本或引号说明即可,禁止用代码围栏(\`\`\`)或反引号包裹标点、符号或单个字符。
- 代码围栏(\`\`\`)仅用于真实代码、命令、JSON 等;不要把普通文字、术语或符号放进去。
- 行内反引号仅用于真正的行内代码。
`

const log = makeLogger('chat.context-assembler')

export class ContextAssembler {
  constructor(private builders: SegmentBuilderSpec[]) {}

  /**
   * 组装 system prompt: 稳定段前置 + 动态段按注册序构建追加。
   * 每个 builder 完成后刷新 budget.allocateSystem — 后续 builder
   * (如知识注入)读到的是最新剩余预算(#630)。
   */
  async assemble(input: SegmentBuildInput): Promise<AssemblyResult> {
    const { projected, budget, historyTokens } = input
    const stableSegments: Array<{ key: string; text: string }> = [
      ...(projected.segments || []),
      { key: 'output_format_rules', text: OUTPUT_FORMAT_RULES },
    ]
    budget.allocateHistory(historyTokens)
    budget.allocateSystem(estimateTokens(projected.systemPrompt + OUTPUT_FORMAT_RULES))

    const telemetry: string[] = []
    const built: Array<{ key: string; text: string }> = []
    for (const b of this.builders) {
      let text = ''
      try {
        text = await b.build(input)
      } catch (err) {
        const reason = (err as Error).message.slice(0, 120)
        if (b.required) telemetry.push(`segment ${b.key} FAILED: ${reason}`)
        else log.warn('segment build failed (best-effort)', { key: b.key, reason })
      }
      if (text) {
        built.push({ key: b.key, text })
      } else if (b.required) {
        telemetry.push(`segment ${b.key} MISSING`)
      }
      // 每段构建后刷新 system 占用 — 后续 builder 读到最新剩余预算。
      const joined = [projected.systemPrompt + OUTPUT_FORMAT_RULES, ...built.map((s) => s.text)].join('\n\n')
      budget.allocateSystem(estimateTokens(joined))
    }

    // 快照/渲染(#98 R1)。
    const segments = [...stableSegments, ...built]
    let systemPrompt = [projected.systemPrompt + OUTPUT_FORMAT_RULES, ...built.map((s) => s.text)].join('\n\n')
    let segmentState: Record<string, SegmentState> | null = null
    let renderFiltered: AssemblyResult['renderFiltered'] = null
    try {
      const { computeSegments, saveSnapshot, loadSnapshot, renderSystemPrompt, renderSystemPromptFiltered } =
        await import('../../memory/context-sources.js')
      const prev = loadSnapshot(input.userId)
      const { state, diff } = computeSegments(input.userId, segments, prev)
      saveSnapshot(input.userId, state)
      if (diff.changed.length > 0 || diff.removed.length > 0) {
        log.info('context segments diffed', { changed: diff.changed, removed: diff.removed })
      }
      systemPrompt = renderSystemPrompt('', state)
      segmentState = state
      renderFiltered = renderSystemPromptFiltered
    } catch {
      // snapshot/diff pipeline is best-effort — fall back to direct join
    }
    return { systemPrompt, segmentState, renderFiltered, telemetry }
  }

  /**
   * #635: 段级回退 — 按 fallbackOrder 逆序整段移除(0 最先)。
   * 全部移除仍超预算返回 false,由调用方落字符级兜底。
   */
  segmentFallback(
    messages: Array<{ role: string; content: unknown }>,
    maxTotalTokens: number,
    segmentState: Record<string, SegmentState> | null,
    renderFiltered: AssemblyResult['renderFiltered'],
    estimateMessagesTokens: (msgs: Array<{ role: string; content: unknown }>) => number,
  ): { droppedSegments: string[] } {
    const droppedSegments: string[] = []
    if (!segmentState || !renderFiltered) return { droppedSegments }
    const droppable = this.builders
      .filter((b) => b.fallbackOrder >= 0)
      .sort((a, b) => a.fallbackOrder - b.fallbackOrder)
      .map((b) => b.key)
    for (const key of droppable) {
      if (estimateMessagesTokens(messages as any) <= maxTotalTokens) break
      if (!segmentState[key]) continue
      droppedSegments.push(key)
      ;(messages[0] as any).content = renderFiltered('', segmentState, droppedSegments)
    }
    return { droppedSegments }
  }
}
