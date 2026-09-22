import { resolveTierModel } from '../../common/llm-gateway.js'
/**
 * Summary synthesis service (#687) — the LLM-driven regenerate path that
 * used to live in knowledge.router.ts. Router stays request/response-only;
 * prompts are the shared templates from memory/prompts.ts.
 */
import { deepseekChat, getApiKey} from '../../common/llm.js'
import { parseLlmJson } from '../../common/llm-json.js'
import { summarySynthesisPrompt, SUMMARY_SYNTHESIS_PERSONA } from '../../memory/prompts.js'
import { normalizeSynthesizedSummary } from '../../memory/summary-contract.js'
import type { MemoryService } from '../../memory/memory.service.js'
import type { SummaryNode, FactNode } from '../../memory/memory.types.js'
import { err, type Result } from '../../common/result.js'

/**
 * Re-write an summary from its current source facts. LLM failure falls back
 * to the existing title/content — the version bump still happens.
 * #813: same answer-ready contract as the K4 path — every claim cites the
 * fact stableIds it was synthesized from (normalized through the shared
 * contract layer).
 */
export async function regenerateSummaryWithLlm(
  summary: SummaryNode,
  memory: MemoryService,
  userId: string,
): Promise<Result<SummaryNode>> {
  const sourceFacts = summary.sourceFacts
    .map(s => memory.graph.getLatestByStableId(s.stableId))
    .filter((n): n is FactNode => n?.type === 'fact' && n.status !== 'superseded')

  // #中-11: 所有来源事实都已被替换/删除时，LLM 无从重写 — 此前会跳过 LLM
  // 却仍用旧 title/content 调 editSummary，把一份没有任何 fact 支撑的摘要
  // 无条件标回 current（「重新生成」只是清掉了过期标记）。宁可失败也不
  // 伪造新鲜度：保持 stale 状态，交由用户编辑或删除。
  if (sourceFacts.length === 0) {
    return err('该摘要已无有效来源事实（全部被替换或删除），无法重新生成；请手动编辑内容或删除该摘要。')
  }

  let title = summary.title
  let content = summary.content

  if (sourceFacts.length > 0) {
    const factList = sourceFacts
      .map(f => `[${f.stableId}] importance=${f.importance ?? 3} source=${f.sourceType || 'general'}: ${f.content}`)
      .join('\n')
    const prompt = summarySynthesisPrompt(factList, SUMMARY_SYNTHESIS_PERSONA.researcherEn)
    try {
      const raw = await deepseekChat(
        [{ role: 'user', content: prompt }],
        getApiKey(),
        {
          model: resolveTierModel('fast'),
          maxTokens: 2048,
          telemetryContext: { userId, workspaceId: userId, action: 'summary.regenerate' },
        },
      )
      const parsed = parseLlmJson<unknown>(raw)
      // #813: 契约归一化失败时保留旧 title/content(版本照常递增)。
      const normalized = normalizeSynthesizedSummary(parsed, sourceFacts.map(f => f.stableId), { lang: 'en' })
      if (normalized) {
        title = normalized.title
        content = normalized.content
      }
    } catch {
      // Fall back to keeping existing title/content but still bumping the version.
    }
  }

  return memory.editSummary(summary.stableId, { title, content }, 'system')
}
