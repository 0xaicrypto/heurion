/**
 * #851 — 投稿前检查:Guide for Authors 抓取 → 结构化抽取 → 对照检查单。
 * 诚实性原则:抓取/抽取失败不阻塞,返回人工核对路径(降级一等公民);
 * 抽取置信度低时标 low,前端提示人工复核;缓存 24h。
 */
import type { FetchGuideResult, GuideRequirements, JournalRecord, PrecheckItem } from './journal-types.js'
import { getApiKey, deepseekChat } from '../../common/llm.js'
import { resolveTierModel } from '../../common/llm-gateway.js'
import { parseLlmJson } from '../../common/llm-json.js'

const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 12_000

interface CacheEntry { at: number; result: FetchGuideResult }
const cache = new Map<string, CacheEntry>()

/** 测试钩子。 */
export function resetGuideCache(): void {
  cache.clear()
}

async function fetchPageText(url: string): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Heurion/1.0 (submission precheck; guide-for-authors)', Accept: 'text/html,text/plain' },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const html = await res.text()
    return htmlToText(html).slice(0, 40_000)
  } finally {
    clearTimeout(timer)
  }
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

interface ExtractedGuide {
  body_word_limit?: number
  abstract_word_limit?: number
  abstract_structure?: 'IMRaD' | 'structured' | 'unstructured'
  figure_limit?: number
  reference_style?: 'AMA' | 'Vancouver' | 'APA' | 'other'
  required_statements?: string[]
}

async function extractRequirements(journal: JournalRecord, pageText: string): Promise<GuideRequirements | null> {
  let apiKey: string
  try {
    apiKey = getApiKey()
  } catch {
    return null
  }
  if (!apiKey) return null
  const prompt = [
    '你是期刊投稿要求解析器。从下面的期刊 Guide for Authors 页面文本中抽取结构化要求,',
    '只输出 JSON(不要多余文字),字段:{"body_word_limit":number|null,"abstract_word_limit":number|null,',
    '"abstract_structure":"IMRaD"|"structured"|"unstructured"|null,"figure_limit":number|null,',
    '"reference_style":"AMA"|"Vancouver"|"APA"|"other"|null,"required_statements":["ethics","conflict","data_availability","funding" 中实际要求者]}。',
    '页面中确实没有的信息用 null,不得编造。',
    '',
    `期刊:${journal.name}`,
    '页面文本:',
    pageText.slice(0, 12_000),
  ].join('\n')
  try {
    const result = await deepseekChat([{ role: 'user', content: prompt }], apiKey, {
      model: resolveTierModel('fast'),
      maxTokens: 600,
      temperature: 0,
      telemetryContext: { userId: 'submission', workspaceId: 'submission', action: 'submission.guide_extract' },
    })
    const parsed = parseLlmJson<ExtractedGuide>(result)
    if (!parsed || typeof parsed !== 'object') return null
    const statements = (parsed.required_statements ?? []).filter((s) => ['ethics', 'conflict', 'data_availability', 'funding'].includes(s))
    const hasAny = parsed.body_word_limit || parsed.abstract_word_limit || parsed.figure_limit || parsed.reference_style || statements.length > 0
    if (!hasAny) return null
    return {
      journalId: journal.id,
      journalName: journal.name,
      bodyWordLimit: typeof parsed.body_word_limit === 'number' ? parsed.body_word_limit : undefined,
      abstractWordLimit: typeof parsed.abstract_word_limit === 'number' ? parsed.abstract_word_limit : undefined,
      abstractStructure: parsed.abstract_structure ?? undefined,
      figureLimit: typeof parsed.figure_limit === 'number' ? parsed.figure_limit : undefined,
      referenceStyle: parsed.reference_style ?? undefined,
      requiredStatements: statements,
      // 只抽到部分字段 → medium;一字数一格式都没抽到 → 已在 hasAny 拦截
      confidence: parsed.body_word_limit || parsed.figure_limit ? 'high' : 'medium',
      sourceUrl: journal.guideUrl,
      fetchedAt: new Date().toISOString(),
    }
  } catch {
    return null
  }
}

/**
 * 抓取 + 抽取该刊投稿要求(24h 缓存)。失败降级:返回 ok:false + 人工核对链接,
 * 绝不阻塞投稿流程,也绝不编造要求。
 */
export async function fetchGuideForAuthors(journal: JournalRecord): Promise<FetchGuideResult> {
  const cached = cache.get(journal.id)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.result

  let result: FetchGuideResult
  if (!journal.guideUrl) {
    result = {
      ok: false,
      reason: `未收录 ${journal.name} 的 Guide for Authors 地址,请人工核对期刊官网`,
      manualUrl: journal.issn
        ? `https://www.google.com/search?q=${encodeURIComponent(`${journal.name} instructions for authors`)}`
        : undefined,
    }
  } else {
    try {
      const pageText = await fetchPageText(journal.guideUrl)
      if (pageText.length < 400) throw new Error('页面内容过短,疑似反爬拦截')
      const requirements = await extractRequirements(journal, pageText)
      result = requirements
        ? { ok: true, requirements }
        : { ok: false, reason: '页面抓取成功但要求抽取失败(LLM 不可用或页面无结构化要求)', manualUrl: journal.guideUrl }
    } catch (err) {
      result = { ok: false, reason: `抓取失败:${(err as Error).message.slice(0, 120)}`, manualUrl: journal.guideUrl }
    }
  }
  cache.set(journal.id, { at: Date.now(), result })
  return result
}

/* ── 检查单生成 ────────────────────────────────────────────────── */

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}

function extractAbstract(text: string): string | null {
  const m = text.match(/(?:^|\n)#*\s*(?:abstract|摘要)\s*:?\s*\n?([\s\S]*?)(?:\n#{1,3}\s|\n\n\n|$)/i)
  return m ? m[1] : null
}

function detectCitationStyle(text: string): 'numbered' | 'author_year' | null {
  if (/\[\d{1,3}\]/.test(text)) return 'numbered'
  if (/\([A-Z][A-Za-z\-]+(?:\s+(?:et al\.?|&|and)\s+[A-Z][A-Za-z\-]+)?,?\s*\d{4}[a-z]?\)/.test(text)) return 'author_year'
  return null
}

const STATEMENT_PATTERNS: Record<string, RegExp> = {
  ethics: /irb|institutional review|ethical approval|伦理|知情同意/i,
  conflict: /conflict of interest|competing interest|利益冲突/i,
  data_availability: /data availability|availability of data|数据可用|数据共享/i,
  funding: /funding|grant support|基金|资助/i,
}

/**
 * 对照写作文档生成检查单。ok:null = 无法自动判定(转人工)。
 * 引用格式:AMA/Vancouver 同属编号制 — 文档为编号引用即通过,作者年份制不通过。
 */
export function precheckAgainstGuide(requirements: GuideRequirements | null, docText: string): PrecheckItem[] {
  const items: PrecheckItem[] = []
  if (!requirements) {
    return [{ id: 'guide_unavailable', label: '期刊要求未获取 — 请按人工核对清单检查', ok: null }]
  }
  const body = docText || ''

  if (requirements.bodyWordLimit) {
    const words = countWords(body.replace(/[#*`>\\[\]()]/g, ' '))
    items.push({
      id: 'word_limit',
      label: `正文字数(上限约 ${requirements.bodyWordLimit} 词)`,
      ok: words <= requirements.bodyWordLimit * 1.05,
      detail: `当前约 ${words} 词`,
    })
  }
  const abstractText = extractAbstract(body)
  if (requirements.abstractWordLimit) {
    if (abstractText) {
      const words = countWords(abstractText)
      items.push({
        id: 'abstract_limit',
        label: `摘要字数(上限约 ${requirements.abstractWordLimit} 词)`,
        ok: words <= requirements.abstractWordLimit * 1.05,
        detail: `当前约 ${words} 词`,
      })
    } else {
      items.push({ id: 'abstract_limit', label: '摘要字数(未定位到摘要段落 — 人工核对)', ok: null })
    }
  }
  if (requirements.abstractStructure === 'IMRaD' || requirements.abstractStructure === 'structured') {
    if (abstractText) {
      const hasStructure = /background|introduction|methods?|results?|conclusions?|背景|方法|结果|结论/i.test(abstractText)
      items.push({ id: 'abstract_structure', label: '摘要结构化(IMRaD)', ok: hasStructure })
    } else {
      items.push({ id: 'abstract_structure', label: '摘要结构化(IMRaD) — 未定位到摘要,人工核对', ok: null })
    }
  }
  if (requirements.figureLimit) {
    const figureCount = (body.match(/!\[/g) ?? []).length + (body.match(/<figure/gi) ?? []).length
    items.push({ id: 'figure_limit', label: `图表数量(上限 ${requirements.figureLimit})`, ok: figureCount <= requirements.figureLimit, detail: `当前 ${figureCount}` })
  }
  if (requirements.referenceStyle) {
    const doc = detectCitationStyle(body)
    if (doc === 'numbered') {
      items.push({ id: 'reference_style', label: `引用格式(目标刊:${requirements.referenceStyle})`, ok: requirements.referenceStyle === 'AMA' || requirements.referenceStyle === 'Vancouver', detail: '文档为编号制引用' })
    } else if (doc === 'author_year') {
      items.push({ id: 'reference_style', label: `引用格式(目标刊:${requirements.referenceStyle})`, ok: false, detail: '文档为作者-年份制,与编号制目标刊不符' })
    } else {
      items.push({ id: 'reference_style', label: `引用格式(目标刊:${requirements.referenceStyle}) — 未检出引用,人工核对`, ok: null })
    }
  }
  for (const stmt of requirements.requiredStatements ?? []) {
    const label = stmt === 'ethics' ? '伦理声明' : stmt === 'conflict' ? '利益冲突声明' : stmt === 'data_availability' ? '数据可用性声明' : '基金资助声明'
    items.push({ id: `stmt_${stmt}`, label: `${label}(该刊要求)`, ok: STATEMENT_PATTERNS[stmt].test(body) })
  }
  if (requirements.confidence !== 'high') {
    items.push({ id: 'manual_review', label: '抽取置信度有限,建议对照官方 Guide for Authors 复核', ok: null, detail: requirements.sourceUrl })
  }
  return items
}
