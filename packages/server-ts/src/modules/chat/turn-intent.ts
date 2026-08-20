/**
 * TURN_INTENT_DESIGN.md §3/§4 — 场景感知的 TurnIntent 解码。
 *
 * 把 chat-handler 里散落的判定（scene / attachment / markers / 语义层 / 单次 LLM
 * 裁决）收敛为一个纯函数 decodeTurnIntent()。核心原则：
 *   scene 回答“作用域”，action 回答“做什么”，target 回答“作用于谁”——三者解耦后组合。
 *
 * 管道：L0 确定性特征（0 LLM）→ L1 语义层（可选）→ L2 单次 LLM 裁决 → L3 落定。
 * 强否决（EDIT/DISCUSSION）只“否决生成”，不“裁决生成”（#557/#549/#558 原则）；
 * 任何失败/uncertain 一律保守降级 answer——永不生成（#557 不变式）。
 */
import type { ChatScene } from '../../common/persona.js'
import type { SidecarClassifier, SidecarHistoryEntry } from '../../retrieval/intent-router.js'
import type { SemanticIntentRouter, SemanticVerdict } from '../../retrieval/semantic-intent-router.js'
import { DISCUSSION_MARKERS, EDIT_MARKERS, parseKnowledgeCommand, classifyQuery } from '../../retrieval/query-router.js'

export type TurnAction = 'answer' | 'edit' | 'generate' | 'retrieve' | 'command'
export type TurnTarget = 'current_doc' | 'attachment' | 'patient' | 'none' | 'external'
export type TurnSource = 'veto' | 'rule' | 'semantic' | 'llm' | 'clarify'

/** 解码输入：进入意图判定的全部确定性信号。 */
export interface TurnContext {
  scene: ChatScene
  text: string
  sessionId: string
  hasAttachment: boolean
  patientHash?: string | null
  history?: SidecarHistoryEntry[]
}

/** 可注入的判定器：语义路由（可选）+ LLM 裁decision（必填，测试可 mock）。 */
export interface TurnLlms {
  classifier: SidecarClassifier
  semantic?: SemanticIntentRouter | null
}

export interface TurnIntent {
  action: TurnAction
  target: TurnTarget
  source: TurnSource
  confidence: number
  needsClarify: boolean
  clarifyOptions: string[]
  payload: {
    editDocumentId?: string
    attachmentRef?: boolean
    patientHash?: string
    /** 用户提交时的历史轮数（#558 指代承接计数）。 */
    historyTurns?: number
    /** 用户原始文本（供插件可用性确认做第二道防线，脱敏前的原文由事件层负责）。 */
    rawText?: string
    summary?: string
  }
}

export interface DecodeResult {
  intent: TurnIntent
  llmCalls: number
  vetoed: boolean
}

/** 事件日志的写入面（由 memory/event-log 实现注入），供 §7 事件落库。 */
export interface TurnEventLog {
  append(e: { timestamp: number; eventType: string; content: string; metadata: Record<string, unknown>; agentId: string; sessionId: string }): unknown
}

/** #560 — 文本规范化指纹（非加密，仅用于同句聚合/脱敏；不存原文）。 */
export function queryFingerprint(text: string): string {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, ' ')
  let h = 5381
  for (let i = 0; i < normalized.length; i++) {
    h = ((h << 5) + h + normalized.charCodeAt(i)) >>> 0
  }
  return h.toString(16)
}

/**
 * #583 (#560) — 每次意图判定落定后写一条 turn/intent-decode 事件。
 * 字段按 TURN_INTENT_DESIGN.md §7：action/target/source/confidence/llmCalls/
 * needsClarify + 脱敏指纹，供审计重建与语料导出（可回放判定路径）。
 */
export function recordTurnIntent(
  eventLog: TurnEventLog,
  opts: { userId: string; sessionId: string; text: string; intent: TurnIntent; llmCalls: number; vetoed: boolean; cacheHit?: boolean; semantic?: string },
): void {
  eventLog.append({
    timestamp: Date.now() / 1000,
    eventType: 'turn/intent-decode',
    content: opts.text.slice(0, 300),
    metadata: {
      action: opts.intent.action,
      target: opts.intent.target,
      source: opts.intent.source,
      confidence: opts.intent.confidence,
      needsClarify: opts.intent.needsClarify,
      clarifyOptions: opts.intent.clarifyOptions,
      llmCalls: opts.llmCalls,
      cacheHit: opts.cacheHit ?? false,
      vetoed: opts.vetoed,
      queryHash: queryFingerprint(opts.text),
      historyTurns: (opts.intent.payload.historyTurns ?? 0),
      // #585 — shadow 模式下记录语义层探测值，供离线分歧率统计。
      semantic: opts.semantic,
    },
    agentId: opts.userId,
    sessionId: opts.sessionId,
  })
}

/** 生成信号：仅用于区分“总结/报告”兼类词（#558），不单独构成生成判定。 */
const GENERATE_SIGNAL = /(生成|导出|制作|帮我做|给我做|做一份|做个|生成工具|generate|export|create|render|写一份)/i
/** 总结/归纳类口头语义（#558 兼类词硬规则）——无格式词时按讨论处理。 */
const SUMMARY_SIGNAL = /(总结|概括|归纳|小结|summary|summarise|summarize)/i
/** 附件明确指代（例 C 目标消歧）。 */
const ATTACHMENT_REF = /(这个文件|这个附件|该文件|上传的|这个文档|附件|这份文件|this file|the uploaded|attachment)/i

/**
 * 目标候选（§6 例 A/B/C）：按场景与附件存在性枚举“可被作用的对象”。
 * 顺序即优先级：attachment → current_doc → patient。
 */
export function resolveTargetCandidates(ctx: {
  scene: ChatScene
  sessionId: string
  hasAttachment: boolean
  patientHash?: string | null
}): TurnTarget[] {
  const candidates: TurnTarget[] = []
  if (ctx.hasAttachment) candidates.push('attachment')
  if (ctx.scene === 'document' && ctx.sessionId.startsWith('doc-')) candidates.push('current_doc')
  if (ctx.scene === 'patient' && ctx.patientHash) candidates.push('patient')
  return candidates
}

/**
 * 目标消歧（§6 例 A/B/C）：单一候选直接命中；多候选在有明确附件指代时选附件，
 * 否则取优先级首位；多候选一律 needsClarify（交给前端反问，见 intent_clarify 事件）。
 */
export function pickTarget(
  ctx: Pick<TurnContext, 'text' | 'hasAttachment'>,
  candidates: TurnTarget[],
): { target: TurnTarget; needsClarify: boolean; options: string[] } {
  if (candidates.length === 0) return { target: 'none', needsClarify: false, options: [] }
  if (candidates.length === 1) return { target: candidates[0], needsClarify: false, options: [] }
  const explicitAttachment = ctx.hasAttachment && ATTACHMENT_REF.test(ctx.text)
  const target = explicitAttachment ? 'attachment' : candidates[0]
  return { target, needsClarify: true, options: [...candidates] }
}

function resolveAnswerTarget(ctx: TurnContext): { target: TurnTarget; patientHash?: string } {
  if (ctx.patientHash) return { target: 'patient', patientHash: ctx.patientHash }
  if (ctx.scene === 'document') return { target: 'current_doc' }
  return { target: 'none' }
}

/**
 * 生成判定布尔化：向后兼容 resolveSidecarIntent 的布尔语义。
 * 核心不变式：action=generate 但尚未澄清（needsClarify）时不视为已判定生成。
 */
export function isGenerateRequest(intent: TurnIntent): boolean {
  return intent.action === 'generate' && !intent.needsClarify
}

const ACTION_LABEL: Record<TurnAction, string> = {
  answer: 'answer（对话/解释/口头总结）',
  edit: 'edit（编辑既有对象）',
  generate: 'generate（生成新文件）',
  retrieve: 'retrieve（检索）',
  command: 'command（显式命令）',
}

/**
 * 分类 prompt（供单测注入断言；生产路径由 decoder 内部调用）。
 * 采用#557/#558的硬规则，约束 LLM 输出 action + target + confidence。
 */
export function buildTurnIntentPrompt(
  ctx: Pick<TurnContext, 'scene' | 'text' | 'history'>,
  candidates: TurnTarget[],
): string {
  const safeQuery = ctx.text.replace(/"/g, '\\"')
  const candidateBlock = candidates.length > 0 ? `Candidate targets: ${candidates.join(', ')}` : 'No concrete target object in scope.'
  const historyBlock = ctx.history && ctx.history.length > 0
    ? `Conversation history (recent, latest first):\n${ctx.history.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n')}\n\n`
    : ''
  return `You are a strict intent classifier for a clinical assistant. Decide what the user wants to DO and WHAT OBJECT it applies to.
Scene: ${ctx.scene}
${candidateBlock}
- action=generate: user EXPLICITLY asks to create a NEW file. Examples: "帮我生成一份出院小结 docx", "把这份数据做成 PPT 汇报", "export to PDF", "make a PPT".
- action=edit: user asks to modify/polish/rewrite an EXISTING content object (current document or uploaded attachment). Examples: 润色/修改/改写/完善/排版/polish/edit/revise/rewrite. Never treat editing as generate.
- action=answer: user asks for explanation, discussion, or a verbal summary. Examples: "这个表格的数字怎么来的", "帮我总结一下这个病人的治疗经过" (verbal summary, NOT a file).
- action=retrieve: user asks to look up data (patients, knowledge base, files).
- action=command: explicit knowledge base command (kb_search/kb_remember/kb_summarize/kb_gaps).

Hard rules:
- EDITING/POLISHING an existing object is NEVER generate。
- "总结/概括/归纳" without an explicit document format word (docx/pdf/ppt/文档/报告文件) is action=answer (verbal summary), NOT generate.
- Pasting a long document body with a short request is never a generate signal on its own.
- When unsure between generate and anything else, return action=generate with confidence<0.5 and needsClarify=true (never guess).
${historyBlock}User: "${safeQuery}"
Return ONLY a JSON object: {"action": "action", "target": "target", "confidence": 0.0, "needsClarify": true/false}`
}

/** 从 LLM 自由文本响应中尽力解析结构化结果，失败按 uncertain/保守处理。 */
function parseTurnAdjudication(raw: string): { action: TurnAction; conf: number; needsClarify: boolean } | null {
  const trimmed = raw.trim().toLowerCase()
  // 兼容旧协议：generate/discuss/uncertain 单词映射
  const first = trimmed.split(/\s+/)[0] ?? ''
  if (first === 'generate') return { action: 'generate', conf: 0.8, needsClarify: false }
  if (first === 'discuss' || first === 'normal') return { action: 'answer', conf: 0.7, needsClarify: false }
  if (first === 'uncertain') return { action: 'answer', conf: 0.5, needsClarify: true }
  const m = trimmed.match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    const parsed = JSON.parse(m[0])
    const action = parsed.action as TurnAction
    if (!['answer', 'edit', 'generate', 'retrieve', 'command'].includes(action)) return null
    return {
      action,
      conf: typeof parsed.confidence === 'number' ? parsed.confidence : 0.6,
      needsClarify: parsed.needsClarify === true,
    }
  } catch {
    return null
  }
}

function fallbackAnswer(ctx: TurnContext): TurnIntent {
  const { target, patientHash } = resolveAnswerTarget(ctx)
  return {
    action: 'answer', target, source: 'llm', confidence: 0.5,
    needsClarify: false, clarifyOptions: [], payload: { patientHash },
  }
}

/**
 * 主入口：解码一轮用户消息为结构化的 TurnIntent。
 * L0 确定性（command/veto/summary/retrieve）→ L1 语义层 → L2 单次 LLM 裁决 → L3 落定。
 */
export async function decodeTurnIntent(ctx: TurnContext, llms: TurnLlms): Promise<DecodeResult> {
  const text = ctx.text
  const basePayload = (patientHash?: string): TurnIntent['payload'] => ({ patientHash, rawText: text })

  // ── L0a：显式知识库命令 ──
  const cmd = parseKnowledgeCommand(text)
  if (cmd.command !== 'unknown') {
    return {
      intent: {
        action: 'command', target: 'none', source: 'rule', confidence: 1,
        needsClarify: false, clarifyOptions: [], payload: basePayload(ctx.patientHash ?? undefined),
      },
      llmCalls: 0,
      vetoed: false,
    }
  }

  // ── L0b：编辑强否决（不可被语义层/LLM 覆盖）──
  if (EDIT_MARKERS.test(text)) {
    const candidates = resolveTargetCandidates(ctx)
    const picked = pickTarget(ctx, candidates)
    const payload = basePayload(ctx.patientHash ?? undefined)
    if (picked.target === 'current_doc' && ctx.sessionId.startsWith('doc-')) {
      payload.editDocumentId = ctx.sessionId.slice(4)
    }
    return {
      intent: {
        action: 'edit', target: picked.target, source: 'veto', confidence: 1,
        needsClarify: picked.needsClarify, clarifyOptions: picked.options, payload,
      },
      llmCalls: 0,
      vetoed: true,
    }
  }

  // ── L0c：总结/归纳（无生成信号）→ 口头回答（#558 兼类词硬规则）──
  if (SUMMARY_SIGNAL.test(text) && !GENERATE_SIGNAL.test(text)) {
    const { target, patientHash } = resolveAnswerTarget(ctx)
    return {
      intent: {
        action: 'answer', target, source: 'rule', confidence: 0.9,
        needsClarify: false, clarifyOptions: [], payload: basePayload(patientHash),
      },
      llmCalls: 0,
      vetoed: false,
    }
  }

  // ── L0d：讨论强否决 ──
  if (DISCUSSION_MARKERS.test(text)) {
    const { target, patientHash } = resolveAnswerTarget(ctx)
    return {
      intent: {
        action: 'answer', target, source: 'veto', confidence: 0.9,
        needsClarify: false, clarifyOptions: [], payload: basePayload(patientHash),
      },
      llmCalls: 0,
      vetoed: true,
    }
  }

  // ── L0e：检索路由（sql/vector/file），非生成需求 ──
  const route = classifyQuery(text)
  if (route === 'sql' || route === 'vector' || route === 'file') {
    const { target, patientHash } = resolveAnswerTarget(ctx)
    return {
      intent: {
        action: 'retrieve', target, source: 'rule', confidence: 0.85,
        needsClarify: false, clarifyOptions: [], payload: basePayload(patientHash),
      },
      llmCalls: 0,
      vetoed: false,
    }
  }

  // ── L1：语义层（可选）——高置信直接落定，不确定回落 LLM ──
  let semanticVerdict: SemanticVerdict | null = null
  if (llms.semantic) {
    try {
      semanticVerdict = await llms.semantic.classify(text)
    } catch {
      semanticVerdict = null // 语义层故障 → 回落到 LLM（永不阻塞生成判定）
    }
  }
  if (semanticVerdict === 'generate') {
    return {
      intent: {
        action: 'generate', target: 'none', source: 'semantic', confidence: 0.9,
        needsClarify: false, clarifyOptions: [], payload: basePayload(ctx.patientHash ?? undefined),
      },
      llmCalls: 0,
      vetoed: false,
    }
  }
  if (semanticVerdict === 'veto') {
    const { target, patientHash } = resolveAnswerTarget(ctx)
    return {
      intent: {
        action: 'answer', target, source: 'semantic', confidence: 0.9,
        needsClarify: false, clarifyOptions: [], payload: basePayload(patientHash),
      },
      llmCalls: 0,
      vetoed: true,
    }
  }

  // ── L2：单次 LLM 裁决（#557）——失败/uncertain 一律保守 ──
  const candidates = resolveTargetCandidates(ctx)
  try {
    const verdict = await llms.classifier.classify(text, ctx.history)
    const parsed = parseTurnAdjudication(verdict)
    if (!parsed) return { intent: fallbackAnswer(ctx), llmCalls: 1, vetoed: false }

    if (parsed.action === 'generate') {
      return {
        intent: {
          action: 'generate', target: 'none', source: 'llm', confidence: parsed.conf,
          needsClarify: false, clarifyOptions: [], payload: basePayload(ctx.patientHash ?? undefined),
        },
        llmCalls: 1,
        vetoed: false,
      }
    }

    const { target, patientHash } = resolveAnswerTarget(ctx)
    const clarifyOptions = candidates.length >= 2 ? [...candidates] : []
    return {
      intent: {
        action: parsed.action,
        target,
        source: 'llm',
        confidence: parsed.conf,
        needsClarify: parsed.needsClarify,
        clarifyOptions: parsed.needsClarify ? (clarifyOptions.length > 0 ? clarifyOptions : ['生成文档', '先讨论']) : [],
        payload: basePayload(patientHash),
      },
      llmCalls: 1,
      vetoed: false,
    }
  } catch {
    return { intent: fallbackAnswer(ctx), llmCalls: 1, vetoed: false }
  }
}