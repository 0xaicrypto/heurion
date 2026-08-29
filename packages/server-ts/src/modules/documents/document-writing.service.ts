/**
 * Document writing service (#687) — the three inline LLM prompts that used
 * to live in documents.router.ts (polish / methods / background). The
 * router now only maps HTTP + SSE transport to these functions.
 */
import { deepseekStream, deepseekChat, getApiKey, DEEPSEEK_CHAT_MODEL } from '../../common/llm.js'
import { resolveActiveModel } from '../../common/llm-gateway.js'
// #752: GLM 混合思考开关 — 润色固定开启,reasoning_content 才会流式返回。
const POLISH_THINKING = 'enabled' as const

export interface MethodsSectionInput {
  study?: { name?: string } | null
  byCategory: Record<string, string[]>
  userId: string
}

/**
 * #3: AI Polish SSE — streaming rewrite of a selection. Yields text
 * chunks; the caller wraps them in the SSE envelope.
 */
/** Polish 提示词 — 流式与 fallback 共用。 */
export function buildPolishPrompt(selection: string, instruction?: string): string {
  return `Polish the following clinical text${instruction ? ` with instruction: "${instruction}"` : ''}. Keep the meaning but improve clarity and professionalism:\n\n${selection || ''}`
}

export async function* polishSelection(
  selection: string,
  instruction: string | undefined,
  userId: string,
  /** #752-ux: 思维链回调(deepseek-reasoner/v4-pro 的 reasoning_content)—
   *  前端气泡内展示"思考过程",与正文流分离。 */
  onReasoning?: (text: string) => void,
): AsyncGenerator<string> {
  const apiKey = getApiKey()
  const prompt = buildPolishPrompt(selection, instruction)
  // #752-fix: 润色走 reasoner 类模型 — v4-flash 非推理模型没有
  // reasoning_content,前端"思考过程"区永远为空,首 token 前只能干等。
  // 优先级:显式 REASONER env > PREMIUM env > provider 感知默认。
  // opencode provider 的 Go 订阅含 glm-5.3-flash(混合思考,$0.15/$0.50,
  // 0 天数据保留)— 润色默认用它,不依赖 DEFAULT_LLM_MODEL 是否更新。
  const provider = (process.env.DEFAULT_LLM_PROVIDER || 'deepseek').toLowerCase()
  const model = process.env.DEEPSEEK_REASONER_MODEL
    || process.env.DEEPSEEK_PREMIUM_MODEL
    || (provider === 'opencode' ? 'glm-5.3-flash' : resolveActiveModel())
  // #752-fix: 4096 — reasoner 模型思维链计入输出额度,2048 会被长思考
  // 耗尽后以空正文"正常"结束(finish_reason=stop,不触发截断重试路径)。
  // 注意:空正文不再在此抛错 — 由 router 的 textChunks===0 fallback
  // (非流式 chatWithMeta,#548 双倍额度重试)接管,此前 throw 恰好绕过
  // 了该兜底,导致用户看到空结果错误。
  let reasoningChars = 0
  const trackReasoning = (t: string) => { reasoningChars += t.length; onReasoning?.(t) }
  for await (const chunk of deepseekStream([{ role: 'user', content: prompt }], apiKey, {
    model,
    maxTokens: 4096,
    thinking: POLISH_THINKING, // 仅 glm-* 模型生效,gateway 内部守卫
    telemetryContext: { userId, workspaceId: userId, action: 'document.polish' },
  }, trackReasoning)) {
    yield chunk
  }
}

/** Write the Methods section of a clinical research paper from study rules. */
export async function writeMethodsSection(input: MethodsSectionInput): Promise<string> {
  const { study, byCategory, userId } = input
  const prompt = `Write the Methods section of a clinical research paper from this study design.

Study: ${study?.name || ''}
Inclusion criteria:
${(byCategory['inclusion'] || []).map((r) => `- ${r}`).join('\n') || 'n/a'}
Exclusion criteria:
${(byCategory['exclusion'] || []).map((r) => `- ${r}`).join('\n') || 'n/a'}
Safety rules:
${(byCategory['safety'] || []).map((r) => `- ${r}`).join('\n') || 'n/a'}
Schedule:
${(byCategory['schedule'] || []).map((r) => `- ${r}`).join('\n') || 'n/a'}

Write 3-6 paragraphs (English): study design, participants, interventions, outcomes, statistical analysis plan. Do not invent numbers. Return only the section text (no preamble, no title).`
  const result = await deepseekChat([{ role: 'user', content: prompt }], getApiKey(), {
    model: DEEPSEEK_CHAT_MODEL,
    maxTokens: 2048,
    telemetryContext: { userId, workspaceId: userId, action: 'research.generate_methods' },
  })
  return result.trim()
}

/** One-paragraph Background and Objectives for a new paper; fallback text
 *  when the LLM is unavailable (paper creation must not fail). */
export async function writePaperBackground(title: string, userId: string): Promise<string> {
  const prompt = `Write a one-paragraph Background and Objectives for a paper titled "${title}". Based on the study name only; keep it generic and factual. Return only the paragraph.`
  try {
    const result = await deepseekChat([{ role: 'user', content: prompt }], getApiKey(), {
      model: DEEPSEEK_CHAT_MODEL, maxTokens: 500,
      telemetryContext: { userId, workspaceId: userId, action: 'research.paper_background' },
    })
    return result.trim()
  } catch {
    return 'Background: 本研究的目的是评估该研究方案下的临床结局。'
  }
}
