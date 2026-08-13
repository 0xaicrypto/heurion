/**
 * #437 — Shared chat context helpers. Single definitions for functions that
 * previously existed in BOTH chat-handler.ts and chat.router.ts (and the
 * router copies were dead code). Keeps the turn pipeline and the router
 * honest: one implementation, one test surface.
 */
import { estimateTokens } from '../../common/token-estimate.js'
import { router } from '../../retrieval/query-router.js'
import { getUserContext } from './user-context.js'
import type { ChatContentPart } from '../../common/llm-gateway.js'
import type { CommandResult } from '../knowledge/knowledge-command-handler.js'
import { extractTextFromUpload, extractImageUpload, isImageFile } from '../../lib/document-extractor.js'
import type { ChatScene } from '../../common/persona.js'

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
export async function readAttachmentContent(userId: string, fileId: string): Promise<string> {
  const name = fileId.split('_').slice(1).join('_') || fileId
  const text = await extractTextFromUpload(userId, fileId, { maxChars: 15000 })
  if (!text) return ''
  return `\n[ATTACHMENT: ${name}]\n${text}\n[/ATTACHMENT]\n`
}

/**
 * §3.4 (#194): total context budget enforcement. Trims non-system messages
 * oldest-first until the estimate fits; falls back to truncating the system
 * prompt. Returns the number of trimmed messages.
 */
export function enforceTotalBudget(
  msgs: Array<{ role: string; content: string | ChatContentPart[] }>,
  maxTokens: number,
): number {
  if (maxTokens <= 0) return 0
  let tokens = estimateTokens(JSON.stringify(msgs))
  let trimmed = 0
  for (let i = 1; i < msgs.length && tokens > maxTokens; ) {
    msgs.splice(i, 1)
    trimmed++
    tokens = estimateTokens(JSON.stringify(msgs))
  }
  if (tokens > maxTokens && msgs.length > 0) {
    // Last resort: truncate the system prompt (keeps the newest user turn).
    const keepChars = Math.max(500, Math.floor((maxTokens / Math.max(tokens, 1)) * (msgs[0].content.length || 0)))
    msgs[0].content = msgs[0].content.slice(0, keepChars)
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
    .slice(0, 5)
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
      return { facts: isolateFactsByScope(ctx.facts.all(), patientHash).slice(0, 50), episodes: [], skills: [] }
    case 'file':
      // File queries: context comes from attachments; skip accumulated memory
      return { facts: [], episodes: [], skills: [] }
    case 'mixed':
    default:
      // Ambiguous or summary questions: keep full context (patient-isolated);
      // episodes are limited to the current session's un-reviewed summary.
      return {
        facts: isolateFactsByScope(ctx.facts.all(), patientHash).slice(0, 50),
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
    const content = await extractTextFromUpload(opts.userId, fid, { maxChars: 15000 })
    if (content) {
      attachmentText += `\n[ATTACHMENT: ${name}]\n${content}\n[/ATTACHMENT]\n`
      notes.push(`Attachment: ${name.slice(0, 30)}`)
    }
  }
  return { parts, attachmentText, notes }
}
