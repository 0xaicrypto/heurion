/**
 * #437 — Shared chat context helpers. Single definitions for functions that
 * previously existed in BOTH chat-handler.ts and chat.router.ts (and the
 * router copies were dead code). Keeps the turn pipeline and the router
 * honest: one implementation, one test surface.
 */
import { estimateTokens, fitTextToTokens } from '../../common/token-estimate.js'
import { CONTEXT_CONFIG } from '../../common/context-config.js' // #637 集中配置
import { router } from '../../retrieval/query-router.js'
import { getUserContext } from './user-context.js'
import type { ChatContentPart } from '../../common/llm-gateway.js'
import type { CommandResult } from '../knowledge/knowledge-command-handler.js'
import { extractTextFromUpload, extractImageUpload, isImageFile, isPdf, extractPdfImagesFromUpload } from '../../lib/document-extractor.js'
import type { ChatScene } from '../../common/persona.js'

// #630: 统一预算口径 — 剩余预算 = maxTotalTokens − system − history。
// #637: 常量集中自 CONTEXT_CONFIG,此处仅 re-export 保持既有引用面。
export const MAX_TOTAL_TOKENS = CONTEXT_CONFIG.maxTotalTokens
export const MAX_HISTORY_TOKENS = CONTEXT_CONFIG.maxHistoryTokens

/** #630: 本轮剩余预算（token）— system 与 history 都按实际估算值占位。 */
export function remainingContextTokens(systemTokens: number, historyTokens: number, maxTotal = MAX_TOTAL_TOKENS): number {
  return Math.max(0, maxTotal - systemTokens - historyTokens)
}

/**
 * #636/#fix: 附件文本提取字符上限(每文件)— 惰性读取(#441 env-lazy)。
 * 提取阶段读足,真正的预算裁剪在 token 层面(attachmentTokenBudget),
 * 中文(1.5 字符/token)与英文(4 字符/token)各自获得合理容量。
 */
export function attachmentExtractChars(): number {
  return parseInt(process.env.ATTACHMENT_TEXT_MAX_CHARS || String(CONTEXT_CONFIG.scene.attachmentExtractChars), 10)
}

/** #fix: 附件文本 token 预算(脚本感知裁剪的上限)。 */
export function attachmentTokenBudget(): number {
  return parseInt(process.env.ATTACHMENT_TOKEN_BUDGET || String(CONTEXT_CONFIG.scene.attachmentTokenBudget), 10)
}

/** #636: 附件文本超限时的降级提示行。 */
export const ATTACHMENT_DEGRADED_MARK = '(text truncated — filename only)'

/**
 * #637 阶段 4 — ContextBudget 抽象:三层预算(projection 虚构 8000 /
 * MAX_HISTORY / MAX_TOTAL)收敛为同一对象的三个视图。组装管线
 * allocate/consume,各段声明可裁剪性;#630 三档策略作为分档视图;
 * #635 段级回退作为兜底入口。后续 builder 管线以本对象为唯一预算源。
 */
export class ContextBudget {
  readonly maxTotal: number
  readonly maxHistory: number
  private systemTokens = 0
  private historyTokens = 0

  constructor(maxTotal = MAX_TOTAL_TOKENS, maxHistory = MAX_HISTORY_TOKENS) {
    this.maxTotal = maxTotal
    this.maxHistory = maxHistory
  }

  /** 记录已组装 system 的占用。 */
  allocateSystem(tokens: number): void {
    this.systemTokens = tokens
  }

  /** 记录历史占用。 */
  allocateHistory(tokens: number): void {
    this.historyTokens = tokens
  }

  /** 剩余预算 = maxTotal − system − history(#630 口径)。 */
  remaining(): number {
    return remainingContextTokens(this.systemTokens, this.historyTokens, this.maxTotal)
  }

  /** 剩余预算占总窗口比例 — #630 三档分档依据。 */
  remainingRatio(): number {
    return this.remaining() / Math.max(1, this.maxTotal)
  }

  /** 剩余预算分档:rich(>30%) / mid(>10%) / tight。 */
  tier(): 'rich' | 'mid' | 'tight' {
    const ratio = this.remainingRatio()
    if (ratio > 0.3) return 'rich'
    if (ratio > 0.1) return 'mid'
    return 'tight'
  }

  /** 留给 system 的额度(maxTotal − history) — 观测与兜底用。 */
  systemCap(): number {
    return Math.max(0, this.maxTotal - this.historyTokens)
  }

  /** 已占用视图 — context_usage 事件输出。 */
  usage(): { system_tokens: number; history_tokens: number; system_budget: number; remaining: number } {
    return {
      system_tokens: this.systemTokens,
      history_tokens: this.historyTokens,
      system_budget: this.systemCap(),
      remaining: this.remaining(),
    }
  }
}

/**
 * #510/#546: chat 入口场景解析 — 显式字段优先,否则按患者范围 /
 * doc- 会话推断。再做一致性修正:
 * - scene=patient 但无 patient_hash → 降级 general(工具面全量却无患者
 *   上下文,行为错配)
 * - scene=document 但会话非 doc- 前缀 → 降级 general
 */
export function resolveScene(opts: {
  explicit?: string | null
  patientHash?: string | null
  sessionId: string
}): ChatScene {
  let scene: ChatScene = (opts.explicit as ChatScene)
    ?? (opts.patientHash ? 'patient' : (opts.sessionId.startsWith('doc-') ? 'document' : 'general'))
  if (scene === 'patient' && !opts.patientHash) scene = 'general'
  if (scene === 'document' && !opts.sessionId.startsWith('doc-')) scene = 'general'
  return scene
}

/** Render a knowledge-command result into a chat-facing string. */
export function formatCommandResult(result: CommandResult): string {
  switch (result.type) {
    case 'kb_search_result':
      return result.summary
    case 'kb_remembered':
      return `✅ 已记录为 Fact #${result.factId}（置信度 ${Math.round(result.confidence * 100)}%）`
    case 'kb_pending_confirmation':
      return `⚠️ 请确认是否记录："${result.candidate}"（置信度 ${Math.round(result.confidence * 100)}%）`
    case 'kb_summary':
      return result.summary
    case 'kb_gaps':
      if (result.gaps.length === 0) return '当前没有未解问题。'
      return `未解问题（${result.gaps.length}）：\n` +
        result.gaps.map((g, i) => `${i + 1}. ${g.content}`).join('\n')
    case 'error':
      return `❌ ${result.message}`
    default:
      return '命令已处理。'
  }
}

/** Read uploaded file content for chat context (#2). */
/** #553: 消息 token 估算 — image part 按固定配额计(base64 全量计入会
 *  系统性清空上下文);文本按字符。 */
export function estimateMessageTokens(m: { role: string; content: string | ChatContentPart[] }): number {
  if (typeof m.content === 'string') return estimateTokens(m.content)
  return m.content.reduce((acc, part) => {
    if (part.type === 'image') return acc + 1024
    return acc + estimateTokens(part.text)
  }, 0)
}

/** 整组消息的 token 估算（#630 段级回退重算用）。 */
export function estimateMessagesTokens(msgs: Array<{ role: string; content: string | ChatContentPart[] }>): number {
  return msgs.reduce((acc, m) => acc + estimateMessageTokens(m), 0)
}

export function enforceTotalBudget(
  msgs: Array<{ role: string; content: string | ChatContentPart[] }>,
  maxTokens: number,
): number {
  if (maxTokens <= 0) return 0
  let tokens = msgs.reduce((acc, m) => acc + estimateMessageTokens(m), 0)
  let trimmed = 0
  // 从最旧消息开始裁剪,但永不删除最后一条 user 消息(否则模型收不到
  // 当前提问);图片 part 保留(配额已计),优先裁文本。
  for (let i = 1; i < msgs.length - 1 && tokens > maxTokens; ) {
    msgs.splice(i, 1)
    trimmed++
    tokens = msgs.reduce((acc, m) => acc + estimateMessageTokens(m), 0)
  }
  if (tokens > maxTokens && msgs.length > 0) {
    // Last resort: truncate the system prompt (keeps the newest user turn).
    const sysLen = typeof msgs[0].content === 'string' ? msgs[0].content.length : 0
    const keepChars = Math.max(500, Math.floor((maxTokens / Math.max(tokens, 1)) * sysLen))
    if (typeof msgs[0].content === 'string') {
      msgs[0].content = msgs[0].content.slice(0, keepChars)
    }
  }
  return trimmed
}

/**
 * Patient isolation for the facts layer (BRAIN2_MEMORY_LIFECYCLE §4.2):
 * in a patient-scoped chat only that patient's facts are injected in full;
 * cross-patient facts appear only when importance >= 4 (limited, tagged).
 */
export function isolateFactsByScope(allFacts: any[], patientHash?: string | null): any[] {
  if (!patientHash) return allFacts
  const own = allFacts.filter((f) => f.patientHash === patientHash)
  const cross = allFacts
    .filter((f) => f.patientHash && f.patientHash !== patientHash && (f.importance ?? 3) >= 4)
    .slice(0, CONTEXT_CONFIG.retrieval.crossPatientMax)
    .map((f) => ({
      ...f,
      content: `[patient: ${f.patientHash}] ${f.content}`,
    }))
  return [...own, ...cross]
}

/**
 * Select which accumulated-memory layers to inject based on the router intent.
 * This keeps per-turn context cost predictable.
 *
 * Episodes (session summaries) are un-reviewed conversation memory — by
 * design they serve the CURRENT session only (BRAIN2_MEMORY_LIFECYCLE §5.3,
 * "不确认的摘要仅用于本轮上下文"). A new session must never inherit another
 * session's un-approved summaries, so episodes are filtered by sessionId.
 */
export function selectProjectionInputs(
  routeResult: Awaited<ReturnType<typeof router>>,
  ctx: Awaited<ReturnType<typeof getUserContext>>,
  patientHash?: string | null,
  sessionId?: string,
) {
  switch (routeResult.intent) {
    case 'sql':
      // Factual queries: rely on SQL-retrieved patient/study context; skip accumulated memory
      return { facts: [], episodes: [], skills: [] }
    case 'vector':
      // Knowledge questions: keep facts/knowledge, skip episodic chat history
      return { facts: isolateFactsByScope(ctx.facts.all(), patientHash).slice(0, CONTEXT_CONFIG.retrieval.factsCap), episodes: [], skills: [] }
    case 'file':
      // File queries: context comes from attachments; skip accumulated memory
      return { facts: [], episodes: [], skills: [] }
    case 'mixed':
    default:
      // Ambiguous or summary questions: keep full context (patient-isolated);
      // episodes are limited to the current session's un-reviewed summary.
      return {
        facts: isolateFactsByScope(ctx.facts.all(), patientHash).slice(0, CONTEXT_CONFIG.retrieval.factsCap),
        episodes: sessionId ? ctx.episodes.all().filter((e) => e.sessionId === sessionId) : [],
        skills: ctx.skills.all(),
      }
  }
}

/**
 * #544: 附件 → 对话内容(纯函数)。图片按视觉能力/大小分流:
 * - 视觉 provider + 位图 ≤4MB → image part
 * - 超限 / 无视觉 provider → 文本说明(提示压缩或 ocr_image)
 * - 文本类 → extractTextFromUpload 注入
 * 返回 parts + 拼接文本 + 每个附件的事件说明(供 handler 发 context_info)。
 */
export type AttachmentWire = string | { file_id?: string; fileId?: string; name?: string }

export async function buildAttachmentParts(
  rawAttachments: AttachmentWire[] | undefined,
  opts: { userId: string; vision: boolean },
): Promise<{ parts: ChatContentPart[]; attachmentText: string; notes: string[] }> {
  const parts: ChatContentPart[] = []
  let attachmentText = ''
  const notes: string[] = []
  // #fix: 附件按 token 预算裁剪(脚本感知 — 中文 1.5 字符/token、英文 4
  // 字符/token),而非固定字符数:长文档(整篇稿件)不再在字符层被硬截断,
  // 多个附件也不会撑爆总预算。
  const extractCap = attachmentExtractChars()
  const tokenBudget = attachmentTokenBudget()
  let consumedTokens = 0
  for (const att of rawAttachments || []) {
    const fid = typeof att === 'string' ? att : (att.file_id || att.fileId || '')
    const name = typeof att === 'string' ? fid.split('_').slice(1).join('_') : (att.name || '')
    if (!fid) continue
    // #511-followup: 非视觉 provider 不读文件(仅按文件名判定)。
    const probe: { mime?: string; dataBase64?: string; oversized?: boolean; noVision?: boolean } | null =
      opts.vision
        ? await extractImageUpload(opts.userId, fid)
        : (isImageFile(name) ? { noVision: true } : null)
    if (probe?.mime && probe.dataBase64) {
      parts.push({ type: 'image', mime: probe.mime, dataBase64: probe.dataBase64 })
      notes.push(`Attachment: ${name.slice(0, 30)} (image → multimodal)`)
      continue
    }
    if (probe) {
      const reason = probe.oversized
        ? '图片超过 4MB 上限,请压缩后上传,或使用 ocr_image 工具提取文字'
        : '当前模型不支持图片输入;如需要分析图中内容,请使用 ocr_image 工具,或切换到支持视觉的模型'
      attachmentText += `\n[ATTACHMENT: ${name}] (image attachment — ${reason})\n`
      notes.push(`Attachment: ${name.slice(0, 30)} (image ${probe.oversized ? 'oversized' : 'no vision'})`)
      continue
    }
    // #636: 附件文本纳入统一预算 — 累计超限后后续附件降级为文件名列表,
    // 避免多个大附件把 user message 撑爆。
    if (consumedTokens >= tokenBudget) {
      attachmentText += `\n[ATTACHMENT: ${name}] ${ATTACHMENT_DEGRADED_MARK}\n`
      notes.push(`Attachment: ${name.slice(0, 30)} (degraded — text budget exceeded)`)
      continue
    }
    const content = await extractTextFromUpload(opts.userId, fid, { maxChars: extractCap })
    if (content) {
      // token 预算内裁剪(脚本感知),保留读取痕迹(原文总长)。
      const remainingTokens = tokenBudget - consumedTokens
      const slice = fitTextToTokens(content, remainingTokens)
      const truncated = slice.length < content.length
      attachmentText += `\n[read file: ${name}${truncated ? ` (${slice.length}/${content.length} chars, truncated)` : ''}]\n${slice}\n[/read]\n`
      consumedTokens += estimateTokens(slice)
      notes.push(`Attachment: ${name.slice(0, 30)}`)
    }
    // #fix: PDF 内嵌图片 → 多模态 part(仅视觉模型)。文本照常注入,
    // 图片让模型看到真实图表/照片,而不是 "图 3 显示…" 占位文字。
    if (opts.vision && isPdf(name)) {
      const pdfImages = await extractPdfImagesFromUpload(opts.userId, fid)
      if (pdfImages && pdfImages.length > 0) {
        for (const im of pdfImages) {
          parts.push({ type: 'image', mime: im.mime, dataBase64: im.dataBase64 })
        }
        notes.push(`Attachment: ${name.slice(0, 30)} (PDF 内嵌图片 ×${pdfImages.length})`)
      }
    }
  }
  return { parts, attachmentText, notes }
}
