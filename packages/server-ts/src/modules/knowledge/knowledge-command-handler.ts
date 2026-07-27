/**
 * Knowledge Command Handler
 *
 * Handles explicit user commands routed by the Query Router.
 * All commands are opt-in and do not increase baseline conversation cost.
 */

import { parseKnowledgeCommand, type KnowledgeCommandType } from '../../retrieval/query-router'
import { FactsStore, KnowledgeStore, type Fact, type KnowledgeArticle } from '../../evolution/stores'
import { type KnowledgeGap, type KnowledgeGapService, type GapFilter } from './knowledge-gap.service'
import type { MemoryService } from '../../memory/memory.service.js'

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

export interface SearchResult {
  kind: 'fact' | 'knowledge'
  source: string
  content: string
  score: number
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

  const items = keywordSearch(payload, ctx.factsStore, ctx.knowledgeStore)

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

  if (ctx.memory) {
    const fact = ctx.memory.addFact({
      category: 'fact',
      importance: 4,
      content: extracted.content,
      sourceType: 'doctor',
    }, 'user')
    return { type: 'kb_remembered', factId: fact.stableId, confidence: extracted.confidence }
  }

  const fact = ctx.factsStore.add({
    category: 'fact',
    importance: 4,
    content: extracted.content,
    sourceType: 'doctor',
  })

  return { type: 'kb_remembered', factId: fact.id, confidence: extracted.confidence }
}

// ── kb_summarize ─────────────────────────────────────────────

async function handleSummarize(ctx: CommandContext, payload: string): Promise<CommandResult> {
  if (!payload.trim()) {
    return { type: 'error', message: '请告诉我你想总结什么主题' }
  }

  const items = keywordSearch(payload, ctx.factsStore, ctx.knowledgeStore)

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
 * Simple keyword search over Facts and Knowledge articles.
 * Scores by normalized keyword overlap.
 */
export function keywordSearch(
  query: string,
  factsStore: FactsStore,
  knowledgeStore: KnowledgeStore,
): SearchResult[] {
  const queryTerms = tokenize(query)
  if (queryTerms.length === 0) return []

  const results: SearchResult[] = []

  for (const fact of factsStore.all()) {
    const score = scoreText(`${fact.content} ${fact.category}`, queryTerms)
    if (score > 0) {
      results.push({
        kind: 'fact',
        source: `fact:${fact.id}`,
        content: fact.content,
        score,
      })
    }
  }

  for (const article of knowledgeStore.all()) {
    const score = scoreText(`${article.title} ${article.content}`, queryTerms)
    if (score > 0) {
      results.push({
        kind: 'knowledge',
        source: `knowledge:${article.id}`,
        content: `${article.title}: ${article.content.slice(0, 200)}`,
        score,
      })
    }
  }

  return results.sort((a, b) => b.score - a.score)
}

function tokenize(text: string): string[] {
  const lower = text.toLowerCase()
  // Keep Chinese characters and Latin alphanumeric tokens
  const tokens = lower.match(/[\u4e00-\u9fa5]+|[a-z0-9]+/g) || []
  // Filter out very short tokens unless Chinese
  return tokens.filter(t => t.length >= 2 || /[\u4e00-\u9fa5]/.test(t))
}

function scoreText(text: string, queryTerms: string[]): number {
  const textTokens = new Set(tokenize(text))
  if (textTokens.size === 0) return 0

  let matches = 0
  for (const term of queryTerms) {
    for (const token of textTokens) {
      if (token.includes(term) || term.includes(token)) {
        matches++
        break
      }
    }
  }

  return matches / queryTerms.length
}

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
