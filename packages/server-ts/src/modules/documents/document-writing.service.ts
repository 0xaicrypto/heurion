/**
 * Document writing service (#687) — the three inline LLM prompts that used
 * to live in documents.router.ts (polish / methods / background). The
 * router now only maps HTTP + SSE transport to these functions.
 */
import { deepseekStream, deepseekChat, getApiKey, DEEPSEEK_CHAT_MODEL } from '../../common/llm.js'

export interface MethodsSectionInput {
  study?: { name?: string } | null
  byCategory: Record<string, string[]>
  userId: string
}

/**
 * #3: AI Polish SSE — streaming rewrite of a selection. Yields text
 * chunks; the caller wraps them in the SSE envelope.
 */
export async function* polishSelection(
  selection: string,
  instruction: string | undefined,
  userId: string,
  /** #752-ux: 思维链回调(deepseek-reasoner/v4-pro 的 reasoning_content)—
   *  前端气泡内展示"思考过程",与正文流分离。 */
  onReasoning?: (text: string) => void,
): AsyncGenerator<string> {
  const apiKey = getApiKey()
  const prompt = `Polish the following clinical text${instruction ? ` with instruction: "${instruction}"` : ''}. Keep the meaning but improve clarity and professionalism:\n\n${selection || ''}`
  // #752-fix: 4096 — reasoner 模型思维链计入输出额度,2048 会被长思考
  // 耗尽后以空正文"正常"结束(finish_reason=stop,不触发截断重试路径)。
  let sawContent = false
  let reasoningChars = 0
  const trackReasoning = (t: string) => { reasoningChars += t.length; onReasoning?.(t) }
  for await (const chunk of deepseekStream([{ role: 'user', content: prompt }], apiKey, {
    model: DEEPSEEK_CHAT_MODEL,
    maxTokens: 4096,
    telemetryContext: { userId, workspaceId: userId, action: 'document.polish' },
  }, trackReasoning)) {
    if (chunk) sawContent = true
    yield chunk
  }
  if (!sawContent) {
    // 空正文结束:给出可操作的错误而非让前端显示笼统"未返回内容"。
    throw new Error(
      reasoningChars > 0
        ? `模型思考了约 ${reasoningChars} 字但未产出正文(输出额度被思考耗尽),请重试或缩小选中范围`
        : '模型未返回任何内容,请稍后重试',
    )
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
