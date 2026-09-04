/**
 * Knowledge Command Handler
 *
 * Handles explicit user commands routed by the Query Router.
 * All commands are opt-in and do not increase baseline conversation cost.
 */

import { parseKnowledgeCommand, type KnowledgeCommandType } from '../../retrieval/query-router'
import { FactsStore, KnowledgeStore } from '../../evolution/stores'
import { type KnowledgeGap, type KnowledgeGapService } from './knowledge-gap.service'
import type { MemoryService } from '../../memory/memory.service.js'
import { keywordSearch, type SearchResult } from '../../retrieval/keyword-search.js' // #666: 检索逻辑归属 retrieval 层

export interface LLMSummarizer {
  summarize(text: string): Promise<string>
}

export interface CommandContext {
  workspaceId: string
  userId: string
  factsStore: FactsStore
  knowledgeStore: KnowledgeStore
  gapService: KnowledgeGapService
  /** Unified memory service — preferred write path. */
  memory?: MemoryService
  /** Optional LLM for kb_summarize. If absent, returns concatenated text. */
  llm?: LLMSummarizer
}

export type CommandResult =
  | { type: 'kb_search_result'; items: SearchResult[]; summary: string }
  | { type: 'kb_remembered'; factId: string; confidence: number }
  | { type: 'kb_pending_confirmation'; candidate: string; confidence: number }
  | { type: 'kb_summary'; summary: string; sources: string[] }
  | { type: 'kb_gaps'; gaps: KnowledgeGap[] }
  | { type: 'kb_gap_resolved'; gapId: string; answerId: string }
  | { type: 'error'; message: string }

const CONFIRMATION_THRESHOLD = 0.85

/**
 * Entry point: parse natural language into a knowledge command and execute it.
 */
export async function handleKnowledgeCommand(
  ctx: CommandContext,
  query: string,
): Promise<CommandResult> {
  const parsed = parseKnowledgeCommand(query)

  if (parsed.command === 'unknown') {
    return { type: 'error', message: '无法理解该知识库命令，请尝试"搜索知识库 XXX"或"记住：XXX"' }
  }

  return executeCommand(ctx, parsed.command, parsed.payload)
}

/**
 * Execute a parsed knowledge command.
 */
export async function executeCommand(
  ctx: CommandContext,
  command: Exclude<KnowledgeCommandType, 'unknown'>,
  payload: string,
): Promise<CommandResult> {
  switch (command) {
    case 'kb_search':
      return handleSearch(ctx, payload)
    case 'kb_remember':
      return handleRemember(ctx, payload)
    case 'kb_summarize':
      return handleSummarize(ctx, payload)
    case 'kb_gaps':
      return handleGaps(ctx)
    case 'kb_resolve_gap':
      return { type: 'error', message: '请通过知识库 UI 或 API 回答未解问题' }
    default:
      return { type: 'error', message: '未知知识库命令' }
  }
}

// ── kb_search ────────────────────────────────────────────────

async function handleSearch(ctx: CommandContext, payload: string): Promise<CommandResult> {
  if (!payload.trim()) {
    return { type: 'error', message: '请告诉我你想搜索什么，例如"搜索知识库关于 NSCLC"' }
  }

  // #840: keyword 读路径切 graph(缺省回落 legacy 投影)
  const items = keywordSearch(payload, ctx.factsStore, ctx.knowledgeStore, undefined, undefined, ctx.memory?.graph)

  if (items.length === 0) {
    return {
      type: 'kb_search_result',
      items: [],
      summary: `没有找到与 "${payload}" 相关的知识。`,
    }
  }

  const summary = `找到 ${items.length} 条相关知识：\n` +
    items.slice(0, 5).map((item, i) => `${i + 1}. [${item.kind}] ${item.content.slice(0, 120)}`).join('\n')

  return { type: 'kb_search_result', items, summary }
}

// ── kb_remember ──────────────────────────────────────────────

async function handleRemember(ctx: CommandContext, payload: string): Promise<CommandResult> {
  if (!payload.trim()) {
    return { type: 'error', message: '请告诉我你想记住什么，例如"记住：ZQ 对 osimertinib 不耐受"' }
  }

  const extracted = extractFactFromPayload(payload)

  if (extracted.confidence < CONFIRMATION_THRESHOLD) {
    return {
      type: 'kb_pending_confirmation',
      candidate: extracted.content,
      confidence: extracted.confidence,
    }
  }

  if (!ctx.memory) {
    // #839: 旧 factsStore 直写 fallback 已删除 — 它只写 legacy store,
    // 永远不进图谱,还会造成双存储漂移。memory 未就绪时如实报错。
    return { type: 'error', message: '记忆服务未就绪，请稍后重试' }
  }

  // #839: 医生显式"记住"是高置信直通信写入 — 走 fast-track 提案:
  // 闸门三关(工具通知过滤/语义去重/冲突标记)照常生效,通过后经与人工
  // 审批相同的 applier 立即落图,提案行 status='approved' 留痕可回溯。
  const { MemoryGraphGateway } = await import('../../memory/memory-gateway.js')
  const gateway = new MemoryGraphGateway(ctx.userId, ctx.memory)
  const proposal = await gateway.propose({
    scopeType: 'global',
    kind: 'fact',
    content: extracted.content,
    importance: 4,
    confidence: 'high',
    reason: 'kb_remember 医生显式记忆',
    fastTrack: true,
  })

  if (proposal.status === 'rejected') {
    return { type: 'error', message: `该内容与已有知识重复，未重复记录（${proposal.rejectedReason ?? '语义重复'}）` }
  }

  return { type: 'kb_remembered', factId: proposal.appliedStableId ?? proposal.id, confidence: extracted.confidence }
}

// ── kb_summarize ─────────────────────────────────────────────

async function handleSummarize(ctx: CommandContext, payload: string): Promise<CommandResult> {
  if (!payload.trim()) {
    return { type: 'error', message: '请告诉我你想总结什么主题' }
  }

  // #840: keyword 读路径切 graph(缺省回落 legacy 投影)
  const items = keywordSearch(payload, ctx.factsStore, ctx.knowledgeStore, undefined, undefined, ctx.memory?.graph)

  if (items.length === 0) {
    return {
      type: 'kb_summary',
      summary: `没有找到与 "${payload}" 相关的知识，无法生成总结。`,
      sources: [],
    }
  }

  const sourceTexts = items.map(i => `[${i.kind}] ${i.content}`).join('\n---\n')
  const sources = items.map(i => i.source)

  if (ctx.llm) {
    const prompt = `请根据以下知识片段，用中文总结关于 "${payload}" 的核心要点：\n\n${sourceTexts}`
    const summary = await ctx.llm.summarize(prompt)
    return { type: 'kb_summary', summary, sources }
  }

  // Fallback: concatenate top results
  const summary = `以下是关于 "${payload}" 的相关知识：\n\n${sourceTexts.slice(0, 2000)}`
  return { type: 'kb_summary', summary, sources }
}

// ── kb_gaps ──────────────────────────────────────────────────

async function handleGaps(ctx: CommandContext): Promise<CommandResult> {
  const { gaps } = await ctx.gapService.list({ workspaceId: ctx.workspaceId, status: 'open' })
  return { type: 'kb_gaps', gaps }
}

// ── Shared helpers ───────────────────────────────────────────

/**
 * Extract a fact from user payload and estimate confidence.
 * High confidence for clear assertions; low for uncertainty markers.
 */
export function extractFactFromPayload(payload: string): { content: string; confidence: number } {
  const content = payload.trim()
  const uncertainty = /(可能|也许|大概|似乎|maybe|perhaps|possibly|uncertain|不清楚|不确定)/i
  const hasUncertainty = uncertainty.test(content)

  return {
    content,
    confidence: hasUncertainty ? 0.72 : 0.92,
  }
}
