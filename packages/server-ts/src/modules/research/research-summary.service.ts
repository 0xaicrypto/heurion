/**
 * Research summary service (#687) — the inline LLM summary generation that
 * used to live in research.router.ts. Structured facts stay LLM-free; the
 * paragraph is best-effort (falls back to the facts joined).
 */
import { deepseekChat, getApiKey, DEEPSEEK_CHAT_MODEL } from '../../common/llm.js'

/**
 * #12: AI research-progress summary for citations / internal reporting.
 * Aggregates protocol, enrollment, rule confirmation, safety and assessment
 * status into a journal-ready paragraph (150-250 中文). LLM failure falls
 * back to the raw facts so the endpoint always returns.
 */
export async function generateResearchSummary(userId: string, facts: string[]): Promise<string> {
  try {
    const raw = await deepseekChat(
      [{ role: 'system', content: '你是临床研究协调员。基于给定事实生成一段客观、适合写入论文 Methods/Results 或内部汇报的研究进展摘要（150-250字中文，含关键数字）。' },
       { role: 'user', content: facts.join('\n') }],
      getApiKey(),
      { model: DEEPSEEK_CHAT_MODEL, maxTokens: 800, telemetryContext: { userId, workspaceId: userId, action: 'research.summary' } },
    )
    return raw.trim()
  } catch {
    return facts.join('；') // LLM unavailable — structured facts still returned
  }
}
