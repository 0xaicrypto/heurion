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
import { providerSupportsVision, modelSupportsVision, type ChatContentPart } from '../../common/llm-gateway.js'
import type { CommandResult } from '../knowledge/knowledge-command-handler.js'
import { extractTextFromUpload, extractImageUpload, isImageFile, isPdf, isDocx, extractPdfContentFromUpload, extractDocxContentFromUpload, type ExtractedPdfImage } from '../../lib/document-extractor.js'
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

// #fix: 单条消息的图片 part 总量上限 — 直接上传图片(≤4MB/张)与 PDF 内嵌
// 图片共用配额。token 预算只覆盖文本,图片 base64(膨胀 ~1.33×)不在此
// 预算内,不设上限会把 LLM 请求体撑爆(多张 4MB 图 → 数十 MB body)。
export const MAX_ATTACHMENT_IMAGES = 8
export const MAX_ATTACHMENT_IMAGE_BYTES = 20 * 1024 * 1024

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
  let imageCount = 0
  let imageBytes = 0
  for (const att of rawAttachments || []) {
    const fid = typeof att === 'string' ? att : (att.file_id || att.fileId || '')
    // #fix: 对象形式缺 name 时按 fileId 还原原始文件名。
    const name = typeof att === 'string'
      ? fid.split('_').slice(1).join('_')
      : (att.name || fid.split('_').slice(1).join('_') || '')
    if (!fid) continue
    // #511-followup: 非视觉 provider 不读文件(仅按文件名判定)。
    const probe: { mime?: string; dataBase64?: string; oversized?: boolean; noVision?: boolean; normalized?: boolean } | null =
      opts.vision
        ? await extractImageUpload(opts.userId, fid)
        : (isImageFile(name) ? { noVision: true } : null)
    if (probe?.mime && probe.dataBase64) {
      if (imageCount >= MAX_ATTACHMENT_IMAGES || imageBytes + probe.dataBase64.length > MAX_ATTACHMENT_IMAGE_BYTES) {
        attachmentText += `\n[ATTACHMENT: ${name}] (image — 超出单条消息图片上限 ${MAX_ATTACHMENT_IMAGES} 张 / ${Math.round(MAX_ATTACHMENT_IMAGE_BYTES / 1024 / 1024)}MB,已降级为文件名)\n`
        notes.push(`Attachment: ${name.slice(0, 30)} (image skipped — part cap reached)`)
        continue
      }
      imageCount++
      imageBytes += probe.dataBase64.length
      parts.push({ type: 'image', mime: probe.mime, dataBase64: probe.dataBase64 })
      notes.push(`Attachment: ${name.slice(0, 30)} (image → multimodal${probe.normalized ? ', 已自动压缩归一化' : ''})`)
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
    // #fix: PDF/DOCX 单次解析同时拿文本 + 内嵌图片(共用同一份已读 buffer,
    // 避免大文件被解析两遍导致 OOM → 连接重置 → 前端 "network error")。
    let content: string | null = null
    let embeddedImages: ExtractedPdfImage[] = []
    if (isPdf(name)) {
      const pdf = await extractPdfContentFromUpload(opts.userId, fid, {
        maxChars: extractCap,
        vision: opts.vision,
      })
      if (pdf) {
        content = pdf.text
        embeddedImages = pdf.images
      }
    } else if (isDocx(name)) {
      // #fix: DOCX 内嵌图片同样抽为多模态 part(此前只有文本,
      // 内嵌图变 base64 字符串混进正文)。
      const docx = await extractDocxContentFromUpload(opts.userId, fid, {
        maxChars: extractCap,
        vision: opts.vision,
      })
      if (docx) {
        content = docx.text
        embeddedImages = docx.images
      }
    } else {
      content = await extractTextFromUpload(opts.userId, fid, { maxChars: extractCap })
    }
    if (content) {
      // token 预算内裁剪(脚本感知),保留读取痕迹(原文总长)。
      const remainingTokens = tokenBudget - consumedTokens
      const slice = fitTextToTokens(content, remainingTokens)
      const truncated = slice.length < content.length
      attachmentText += `\n[read file: ${name}${truncated ? ` (${slice.length}/${content.length} chars, truncated)` : ''}]\n${slice}\n[/read]\n`
      consumedTokens += estimateTokens(slice)
      notes.push(`Attachment: ${name.slice(0, 30)}`)
    }
    // #fix: PDF/DOCX 内嵌图片 → 多模态 part(仅视觉模型)。文本照常注入,
    // 图片让模型看到真实图表/照片,而不是 "图 3 显示…" 占位文字。
    // 与直接上传图片共用计数/字节上限,超出部分丢弃(文本仍完整)。
    if (embeddedImages.length > 0) {
      const room = Math.max(0, MAX_ATTACHMENT_IMAGES - imageCount)
      let pushed = 0
      let usedBytes = 0
      for (const im of embeddedImages) {
        if (pushed >= room || imageBytes + usedBytes + im.dataBase64.length > MAX_ATTACHMENT_IMAGE_BYTES) break
        parts.push({ type: 'image', mime: im.mime, dataBase64: im.dataBase64 })
        pushed++
        usedBytes += im.dataBase64.length
      }
      imageCount += pushed
      imageBytes += usedBytes
      notes.push(`Attachment: ${name.slice(0, 30)} (内嵌图片 ×${pushed}/${embeddedImages.length})`)
    }
  }
  return { parts, attachmentText, notes }
}

/**
 * #fix: 写作会话参考材料中的上传文件(PDF/DOCX/txt)此前只注入文件名,
 * LLM 读不到正文,误报"无法解析该文件/没有解析 docx 的能力"。这里识别
 * refType ∈ {file, pdf, docx} 的文件类引用:按文件名定位上传记录
 * (findFileByName),提取正文注入;解析失败或非文件引用回退原行为
 * (标题 + 原 snapshot 截断)。
 */
export const DOC_FILE_REF_KINDS = new Set(['file', 'pdf', 'docx'])

export async function buildDocReferenceBlocks(
  userId: string,
  refs: Array<{ id?: string; refType?: string | null; snapshot?: string | null; label?: string | null }>,
  opts: { findFileByName: (name: string) => Promise<{ id: string } | null> },
): Promise<{ blocks: string[]; resolved: number }> {
  const blocks: string[] = []
  let resolved = 0
  for (const r of refs) {
    const header = `### ${r.label || r.id || ''}`
    const kind = String(r.refType || '')
    const snapshot = String(r.snapshot || '')
    if (!DOC_FILE_REF_KINDS.has(kind) || !snapshot) {
      blocks.push(`${header}\n${snapshot.slice(0, CONTEXT_CONFIG.scene.docRefChars)}`)
      continue
    }
    try {
      const found = await opts.findFileByName(snapshot)
      const text = found ? await extractTextFromUpload(userId, found.id, { maxChars: attachmentExtractChars() }) : ''
      const usable = Boolean(text) && !text.startsWith('[PDF') && !text.startsWith('[DOCX')
      if (found && usable) {
        resolved++
        const body = fitTextToTokens(text, CONTEXT_CONFIG.scene.docRefFileTokens)
        blocks.push(`${header}\n[已解析上传文件正文]\n${body}`)
        continue
      }
    } catch {
      // fall through to name-only
    }
    blocks.push(`${header}\n${snapshot.slice(0, CONTEXT_CONFIG.scene.docRefChars)}`)
  }
  return { blocks, resolved }
}

/**
 * #fix: 附件中是否含位图图片 — 视觉模型切换的依据。PDF 走文本路径即可
 * (文本层解析不依赖视觉),仅位图(png/jpg/gif/webp/avif)需要视觉模型。
 * 名称判定不读文件,与 buildAttachmentParts 的探针逻辑一致。
 */
export async function detectImageAttachments(
  userId: string,
  rawAttachments: AttachmentWire[] | undefined,
): Promise<boolean> {
  for (const att of rawAttachments || []) {
    const fid = typeof att === 'string' ? att : (att.file_id || att.fileId || '')
    // #fix: 对象形式缺 name 时按 fileId 还原原始文件名(与字符串形式同口径)。
    const name = typeof att === 'string'
      ? fid.split('_').slice(1).join('_')
      : (att.name || fid.split('_').slice(1).join('_') || '')
    if (!fid) continue
    if (isImageFile(name)) return true
  }
  return false
}

function envModel(envKey: string, fallback: string): string {
  return process.env[envKey] || fallback
}

/**
 * #fix: 视觉模型自适应 — 图片附件 + 当前回合模型纯文本时,自动切换到
 * 视觉模型。仅在 deepseek/opencode(同源 OpenAI 兼容端点)内切换;
 * 跨 provider 换模型会请求错端点,宁可按文本降级提示。无图或当前
 * 模型本就支持视觉 → 原样返回。
 */
export function pickVisionTurnModel(opts: { turnModel: string; hasImages: boolean }): { model: string; vision: boolean; switched: boolean } {
  const vision = providerSupportsVision(undefined, opts.turnModel)
  if (!opts.hasImages || vision) return { model: opts.turnModel, vision, switched: false }
  const prov = (process.env.DEFAULT_LLM_PROVIDER || 'deepseek').toLowerCase()
  if (prov === 'deepseek' || prov === 'opencode') {
    const candidates = [
      envModel('DEEPSEEK_PREMIUM_MODEL', 'deepseek-v4-flash'),
      envModel('DEEPSEEK_CHAT_MODEL', 'deepseek-v4-flash'),
    ]
    for (const candidate of candidates) {
      if (candidate !== opts.turnModel && modelSupportsVision(candidate)) {
        return { model: candidate, vision: true, switched: true }
      }
    }
  }
  return { model: opts.turnModel, vision, switched: false }
}
