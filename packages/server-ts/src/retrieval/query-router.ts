/**
 * P3 — Query Router
 *
 * Cost-controlled two-layer classifier:
 *   1. Rule layer (keyword + pattern, <1ms): ~80% of queries, zero LLM cost
 *   2. LLM fallback layer (cheap classifier, <200ms): ambiguous or mixed intent
 *
 * Router maps an intent to ordered retrieval routes and exposes cost metadata
 * for observability.
 */

import { deepseekChat, getApiKey, type LlmTelemetryContext , DEEPSEEK_CHAT_MODEL } from '../common/llm.js'

export type QueryIntent = 'sql' | 'vector' | 'file' | 'knowledge_command' | 'sidecar' | 'mixed'
export type RouteKind = 'sql' | 'vector' | 'file' | 'knowledge_command' | 'sidecar'

export type KnowledgeCommandType =
  | 'kb_search'
  | 'kb_remember'
  | 'kb_summarize'
  | 'kb_gaps'
  | 'kb_resolve_gap'
  | 'unknown'

export interface RouterResult {
  intent: QueryIntent
  routes: RouteKind[]
  /** True when the rule layer produced a definitive intent. */
  ruleHit: boolean
  /** True when the LLM fallback layer was invoked. */
  llmFallback: boolean
  /** Cost observability. */
  cost: { llmCalls: number }
}

export interface RouterOptions {
  /** Optional LLM fallback classifier. When omitted, ambiguous queries become 'mixed'. */
  llmClassifier?: LLMClassifier
}

export interface LLMClassifier {
  classify(query: string): Promise<QueryIntent>
}

export interface LLMClassifierContext {
  userId: string
  workspaceId: string
  action?: string
}

/**
 * Rule-based classifier. Handles ~80% of queries without LLM call.
 */
export function classifyQuery(query: string): QueryIntent {
  const q = query.toLowerCase().trim()
  if (!q) return 'mixed'

  // Knowledge commands — explicit user intent, high priority
  const cmd = parseKnowledgeCommand(query)
  if (cmd.command !== 'unknown') return 'knowledge_command'

  // File references
  if (q.startsWith('#文件') || q.startsWith('#file') ||
      (q.includes('上传') && (q.includes('文件') || q.includes('ct') || q.includes('报告'))) ||
      (q.includes('uploaded') && q.includes('file'))) {
    return 'file'
  }

  // SQL — patient demographic queries
  const hasDemographic = /(年龄|性别|名字|姓名|主诉|多大|叫什么|age|sex|name|gender)/i.test(q)
  const hasPatientRef = /(患者|patient|的年龄|的性别|的名字|的姓名)/i.test(q)
  if (hasDemographic && hasPatientRef) return 'sql'
  if (/(list|列表|有几个|count|how many|哪些|all)/i.test(q) && /(patient|患者)/i.test(q)) return 'sql'

  // Semantic/clinical — these need vector search of Knowledge/Facts
  const vectorPatterns = [
    /(进展|治疗|管理|指南|综述|研究|最新|literature|review|management|treatment|guideline|immunotherapy|targeted|cancer|carcinoma|tumor)/,
    /what (is|are) the (latest|new|current|recommended)/,
    /how (to treat|to manage|to diagnose|does.*work)/,
  ]
  if (vectorPatterns.some(p => p.test(q))) return 'vector'

  // Default — mixed: try SQL first, then vector
  return 'mixed'
}

/**
 * #452 — render-intent keyword fallback (moved out of classifyQuery).
 * Only consulted AFTER the plugin trigger matcher: a user with rendering
 * plugins installed is routed via their plugin triggers; this keyword layer
 * exists so render requests are still recognized when no renderer plugin is
 * installed yet (the plugin handler then guides the user to the marketplace).
 */
export function classifySidecarIntent(text: string): boolean {
  const q = text.toLowerCase()
  const sidecarPatterns = [
    /(病例总结|case summary|出院小结|discharge summary|研究报告|research report)/,
    /(生成|创建|制作|做|生成一个|给我|导出|export|create|make|generate).*(docx|word|pptx|ppt|powerpoint|幻灯片|表格|table|图表|chart|plot|图)/,
    /(docx|word|pptx|ppt|powerpoint|幻灯片|表格|table|图表|chart|plot|图).*?(生成|创建|制作|做|给我|导出|create|make|generate)/,
  ]
  return sidecarPatterns.some((p) => p.test(q))
}

/**
 * Parse explicit knowledge-base commands from natural language.
 * Supports both Chinese and English shorthands.
 */
export function parseKnowledgeCommand(query: string): { command: KnowledgeCommandType; payload: string } {
  const q = query.trim()
  if (!q) return { command: 'unknown', payload: '' }

  const lower = q.toLowerCase()

  // kb_search patterns
  const searchPatterns = [
    /^搜索(?:我的|一下)?(?:知识库)?(?:关于)?\s*(.+)$/i,
    /^知识库(?:里)?(?:搜索|查找)?\s*(.+)$/i,
    /^(?:kb|知识库)\s*search\s*(.+)$/i,
    /^(?:search|查找)\s*(?:my\s+)?(?:knowledge\s+(?:base|库)|kb)\s*(?:for|关于)?\s*(.+)$/i,
  ]
  for (const pattern of searchPatterns) {
    const m = q.match(pattern)
    if (m) return { command: 'kb_search', payload: (m[1] || '').trim() }
  }

  // kb_remember patterns
  const rememberPatterns = [
    /^记住[：:]?\s*(.+)$/i,
    /^(?:kb|知识库)\s*remember[：:]?\s*(.+)$/i,
    /^remember(?:\s+that)?[：:]?\s*(.+)$/i,
    /^保存到知识库[：:]?\s*(.+)$/i,
    /^(?:save|store)\s+(?:this\s+)?(?:to\s+)?(?:my\s+)?(?:knowledge\s+(?:base|库)|kb)[：:]?\s*(.+)$/i,
  ]
  for (const pattern of rememberPatterns) {
    const m = q.match(pattern)
    if (m) return { command: 'kb_remember', payload: (m[1] || '').trim() }
  }

  // kb_summarize patterns
  const summarizePatterns = [
    /^根据(?:我的)?(?:知识库|kb)(?:关于)?\s*(?:总结)?\s*(.+)$/i,
    /^总结(?:一下)?(?:我的)?(?:知识库|kb)(?:关于)?\s*(.+)$/i,
    /^(?:kb|知识库)\s*summarize\s*(.+)$/i,
    /^summarize\s+(?:my\s+)?(?:knowledge\s+(?:base|库)|kb)\s*(?:about|on|regarding|关于)?\s*(.+)$/i,
  ]
  for (const pattern of summarizePatterns) {
    const m = q.match(pattern)
    if (m) return { command: 'kb_summarize', payload: (m[1] || '').trim() }
  }

  // kb_gaps patterns
  const gapsPatterns = [
    /^查看(?:我的)?\s*(?:未解问题|知识缺口|knowledge\s+gaps?)$/i,
    /^(?:我的)?\s*(?:未解问题|知识缺口|knowledge\s+gaps?)$/i,
    /^(?:kb|知识库)\s*gaps?$/i,
    /^list\s+(?:my\s+)?(?:knowledge\s+gaps?|open\s+questions)$/i,
  ]
  for (const pattern of gapsPatterns) {
    if (pattern.test(q)) return { command: 'kb_gaps', payload: '' }
  }

  // kb_resolve_gap patterns
  const resolvePatterns = [
    /^回答(?:这个)?\s*(?:gap|未解问题)[：:]?\s*(.+)$/i,
    /^(?:kb|知识库)\s*resolve[\s-]gap[：:]?\s*(.+)$/i,
    /^resolve\s+(?:this\s+)?(?:gap|open\s+question)[：:]?\s*(.+)$/i,
  ]
  for (const pattern of resolvePatterns) {
    const m = q.match(pattern)
    if (m) return { command: 'kb_resolve_gap', payload: (m[1] || '').trim() }
  }

  return { command: 'unknown', payload: '' }
}

function buildClassifierPrompt(query: string): string {
  const safeQuery = query.replace(/"/g, '\\"')
  return `You are the intent classifier for a clinical AI assistant.
Available intents:
- sql: factual patient database queries (age, sex, list patients, etc.)
- vector: clinical/guideline/literature questions
- file: file or attachment references
- knowledge_command: ONLY explicit COMMAND-LIKE instructions that START with an action verb (记住, 保存, 搜索知识库, 总结知识库, 查看我的未解问题, 回答gap; english: remember, save, search my knowledge base, summarize, list gaps). Questions and soft requests are NEVER knowledge_command: "我想了解你学到了什么", "你能告诉我记忆里有什么", "what did you learn", "你掌握了哪些信息" → use mixed.
- sidecar: requests to generate documents, presentations, tables, or plots
- mixed: anything else or ambiguous

Return ONLY the intent label, nothing else.

Query: "${safeQuery}"
Intent:`
}

/**
 * Build the default LLM fallback classifier with optional telemetry context.
 * Invoked when the rule layer returns 'mixed' and no custom classifier is supplied.
 * Uses a cheap single-call prompt to understand intent instead of relying solely on keyword patterns.
 */
export function createDefaultLLMClassifier(context?: LlmTelemetryContext): LLMClassifier {
  return {
    async classify(query: string): Promise<QueryIntent> {
      const apiKey = getApiKey()
      if (!apiKey) return 'mixed'

      try {
        const raw = await deepseekChat(
          [{ role: 'user', content: buildClassifierPrompt(query) }],
          apiKey,
          {
            model: DEEPSEEK_CHAT_MODEL,
            maxTokens: 50,
            telemetryContext: context,
          },
        )
        const intent = raw.trim().toLowerCase().split(/\s+/)[0]
        if (['sql', 'vector', 'file', 'knowledge_command', 'sidecar', 'mixed'].includes(intent)) {
          return intent as QueryIntent
        }
        return 'mixed'
      } catch {
        return 'mixed'
      }
    },
  }
}

/**
 * Default LLM fallback classifier without telemetry context (for tests / simple callers).
 */
export const defaultLLMClassifier: LLMClassifier = createDefaultLLMClassifier()

/**
 * LLM fallback classifier. Only invoked when rule layer returns 'mixed'.
 * Returns a safe 'mixed' if the classifier is unavailable or uncertain.
 */
export async function classifyQueryLLM(
  query: string,
  classifier?: LLMClassifier,
): Promise<QueryIntent> {
  if (!classifier) return 'mixed'

  try {
    const intent = await classifier.classify(query)
    if (['sql', 'vector', 'file', 'knowledge_command', 'sidecar', 'mixed'].includes(intent)) {
      return intent
    }
    return 'mixed'
  } catch {
    return 'mixed'
  }
}

/**
 * Maps a query intent to ordered retrieval routes.
 * For 'mixed', returns all applicable routes.
 */
export function routeQuery(_query: string, intent: QueryIntent): RouteKind[] {
  switch (intent) {
    case 'sql':               return ['sql']
    case 'vector':            return ['vector']
    case 'file':              return ['file']
    case 'knowledge_command': return ['knowledge_command']
    case 'sidecar':           return ['sidecar']
    case 'mixed':             return ['sql', 'vector']
    default:                  return ['sql', 'vector']
  }
}

const ROUTE_CACHE_TTL_MS = 5 * 60 * 1000
/** §5.6 (#199): bounded cache — unbounded growth was a slow leak. */
const ROUTE_CACHE_MAX = 500
const routeCache = new Map<string, { result: RouterResult; expires: number }>()

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, ' ')
}

/** Clear the in-memory route cache. Useful in tests. */
export function clearRouteCache(): void {
  routeCache.clear()
}

function cacheRoute(key: string, entry: { result: RouterResult; expires: number }): void {
  routeCache.set(key, entry)
  if (routeCache.size <= ROUTE_CACHE_MAX) return
  // Drop expired entries first, then evict the oldest (insertion order).
  const now = Date.now()
  for (const [k, v] of [...routeCache]) {
    if (routeCache.size <= ROUTE_CACHE_MAX) break
    if (v.expires <= now) routeCache.delete(k)
  }
  while (routeCache.size > ROUTE_CACHE_MAX) {
    const oldest = routeCache.keys().next().value
    if (oldest === undefined) break
    routeCache.delete(oldest)
  }
}

/**
 * Full router: classify + route + cost metadata.
 * Async because it may call the optional LLM fallback classifier.
 * Results are cached for 5 minutes to avoid paying for repeated classifications.
 */
export async function router(query: string, options: RouterOptions = {}): Promise<RouterResult> {
  const normalized = normalizeQuery(query)
  const cacheKey = `${options.llmClassifier ? 'llm' : 'rule'}:${normalized}`
  const cached = routeCache.get(cacheKey)
  if (cached && cached.expires > Date.now()) {
    return cached.result
  }

  const ruleIntent = classifyQuery(query)
  let finalIntent = ruleIntent
  let llmFallback = false
  let llmCalls = 0

  if (ruleIntent === 'mixed' && options.llmClassifier) {
    finalIntent = await classifyQueryLLM(query, options.llmClassifier)
    llmFallback = true
    llmCalls = 1
  }

  // Safety net: an LLM-misclassified "knowledge_command" that does not parse
  // as an explicit command degrades to mixed. Natural-language questions
  // ("你学到了什么", "我想了解一下…") must never hit the command handler —
  // they are answered by the normal conversation with injected memory.
  if (finalIntent === 'knowledge_command' && parseKnowledgeCommand(query).command === 'unknown') {
    finalIntent = 'mixed'
  }

  const result: RouterResult = {
    intent: finalIntent,
    routes: routeQuery(query, finalIntent),
    ruleHit: ruleIntent !== 'mixed',
    llmFallback,
    cost: { llmCalls },
  }

  cacheRoute(cacheKey, { result, expires: Date.now() + ROUTE_CACHE_TTL_MS })
  return result
}
