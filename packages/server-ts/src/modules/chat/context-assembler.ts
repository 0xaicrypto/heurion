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
  /** #fix 2026-09: 段内子进度 — 慢段(钉选文档提取/参考材料解析)在段内
   *  逐项发进度文案,消除"一个阶段卡 9 分钟零事件"的黑盒。由 assemble
   *  注入(转发 onStage),builder best-effort 调用。 */
  stage?: (label: string) => void
}

export interface SegmentBuilderSpec {
  key: string
  /** 回退优先级: 0=最先回退; -1=不可回退。 */
  fallbackOrder: number
  /**
   * #fix 2026-09: 用户可见的组装阶段提示 — 组装慢段(文档解析/知识检索)
   * 此前全程只有一条静态"正在读取文档与参考资料…",5 分钟无任何进展展示。
   * 配置后装配器在每个 builder 开始时回调 onStage,由调用方经 SSE 下发。
   */
  stageLabel?: string
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
   *
   * #fix 2026-09: onStage — 每个带 stageLabel 的动态段开始构建时回调
   * (SSE 下发进度),慢段等待期用户可见阶段推进而非静态提示。
   */
  async assemble(
    input: SegmentBuildInput,
    onStage?: (label: string) => void,
  ): Promise<AssemblyResult> {
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
      if (onStage && b.stageLabel) {
        try {
          onStage(b.stageLabel)
        } catch { /* best-effort — 进度提示不影响组装 */ }
      }
      let text = ''
      try {
        // #fix 2026-09: build 输入附带 stage 转发 — builder 内部慢子步骤
        // (逐文件提取)可实时发进度文案。
        const buildInput: SegmentBuildInput = onStage
          ? { ...input, stage: (label: string) => { try { onStage(label) } catch { /* ignore */ } } }
          : input
        text = await b.build(buildInput)
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
   * #814: 让位关系复核 — layer3 碎片(未成文记忆,projected 稳定段)价值
   * 最低,先于所有 builder 段让位;随后 knowledge_inject(自动注入,0)
   * 先于 picked_kb(用户钉选,1) — 顺序 picked_kb > knowledge_inject >
   * layer3。全部移除仍超预算返回 false,由调用方落字符级兜底。
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
    const droppable = [
      'accumulated_knowledge', // #814: layer3 碎片最先让位(未成文记忆)
      ...this.builders
        .filter((b) => b.fallbackOrder >= 0)
        .sort((a, b) => a.fallbackOrder - b.fallbackOrder)
        .map((b) => b.key),
    ]
    for (const key of droppable) {
      if (estimateMessagesTokens(messages as any) <= maxTotalTokens) break
      if (!segmentState[key]) continue
      droppedSegments.push(key)
      ;(messages[0] as any).content = renderFiltered('', segmentState, droppedSegments)
    }
    return { droppedSegments }
  }
}
