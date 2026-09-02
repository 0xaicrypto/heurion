import { BaseTool, ToolResult } from './base-tool.js'
import prisma from '../common/prisma.js'
import { estimateTokens } from '../common/token-estimate.js'
import { resolveImportTargets, extractRefText, writeDocBody, ensureDraftBody } from './doc-import.js'
import { writeDocVersion } from './doc-version-writer.js'

/** 匹配时忽略的 markdown 语法字符 — 模型复制 old_text 时常省略/重排这些
 *  标记(`## ` 标题、`**` 强调、`` ` `` 行内代码、`>` 引用、`•` 列表圆点),
 *  而导入后的文档正文里它们真实存在,字符级差异会让两级空白匹配失效。 */
function isMatchSyntaxChar(c: string): boolean {
  return c === '#' || c === '*' || c === '`' || c === '>' || c === '•' || c === '\u00ad'
}

/** 图片 token 在归一化串里的占位符。图片不再整段删除,而是收敛为
 *  「占位符+URL」原子块(#fix 2026-09):
 *  · URL 保留参与匹配 — 换图工作流里模型常用整行图片做 old_text,
 *    无 URL 的占位会让多张图互不可分,恒误判「出现多次」死循环;
 *  · 占位符占 1 个归一化位置 — 含图片的 old_text 的替换 span 才能
 *    覆盖图片本体(此前 span 停在图题末尾,旧图片行残留成重复块)。 */
const IMAGE_PLACEHOLDER = '\uFFFC'

/** 识别 raw 处的图片 token(![alt](url)),返回 token 长度与 URL;非图片返回 null。 */
const IMAGE_TOKEN_RE = /!\[[^\]]*\]\(([^)]*)\)/y
function matchImageToken(body: string, raw: number): { length: number; url: string } | null {
  if (body[raw] !== '!' || body[raw + 1] !== '[') return null
  IMAGE_TOKEN_RE.lastIndex = raw
  const m = IMAGE_TOKEN_RE.exec(body)
  if (!m) return null
  return { length: m[0].length, url: m[1] }
}

/** URL 在归一化串里的长度 — 剔除语法字符;空白按模式折叠/删除。
 *  必须与 stripMatchSyntax 的字符串管线逐字符一致,否则索引漂移。 */
function imageUrlNormLen(url: string, wsFree: boolean): number {
  const cleaned = url.replace(/[\u00ad#`>*•]/g, '')
  return (wsFree ? cleaned.replace(/\s/g, '') : cleaned.replace(/\s+/g, ' ')).length
}

/** 剥离匹配忽略的 markdown 语法;图片 token 收敛为「占位符+URL」。 */
function stripMatchSyntax(s: string): string {
  return s
    .replace(/\u00ad/g, '')
    .replace(/!\[[^\]]*\]\(([^)]*)\)/g, (_m, url: string) => IMAGE_PLACEHOLDER + url.replace(/[\u00ad#`>*•]/g, ''))
    .replace(/[#`>*•]/g, '')
    .replace(/\*/g, '')
}

/**
 * #fix: 匹配归一化 — 空白塌缩 + 剥离 markdown 语法 + 忽略大小写。
 * PDF 提取正文里满是换行/空格伪影,LLM 的 old_text 在空白/标记/大小写
 * 上常有细微差异(换行位置、连续空格、连字断开、## 标题前缀),逐字节
 * indexOf 必然失败。
 */
export function normalizeForMatch(s: string): string {
  return stripMatchSyntax(s).replace(/\s+/g, ' ').trim().toLowerCase()
}

/** 完全忽略空白/软连字符(兜底匹配用 — PDF 断行把词拆开时插入的空格)。 */
function normalizeWsFree(s: string): string {
  return stripMatchSyntax(s).replace(/\s/g, '').toLowerCase()
}

/** 归一化索引 → 原始下标,镜像字符串归一化口径(wsFree=false:
 *  normalizeForMatch 空白塌缩;wsFree=true: normalizeWsFree 空白全删):
 *  语法字符 0 位;空白 — 塌缩模式一个 run(可交错语法字符)记 1 位 /
 *  wsFree 模式 0 位;图片 token 是原子块,占 1+URL 归一化长度 位;
 *  归一化串做了首尾 trim,故前导空白/语法不占位(前导图片占位)。
 *  target 落在图片块中间时整块消费(URL 不会成为锚点切点)。 */
function walkNorm(body: string, target: number, wsFree: boolean): number {
  let raw = 0
  let norm = 0
  while (raw < body.length) {
    if (matchImageToken(body, raw)) break
    const c = body[raw]
    if (isMatchSyntaxChar(c) || /\s/.test(c)) {
      raw++
      continue
    }
    break
  }
  while (norm < target && raw < body.length) {
    const img = matchImageToken(body, raw)
    if (img) {
      raw += img.length
      norm += 1 + imageUrlNormLen(img.url, wsFree)
      continue
    }
    const c = body[raw]
    if (isMatchSyntaxChar(c)) {
      raw++
      continue
    }
    if (/\s/.test(c)) {
      while (raw < body.length) {
        const d = body[raw]
        if (/\s/.test(d) || isMatchSyntaxChar(d)) {
          raw++
          continue
        }
        break
      }
      if (!wsFree) norm++
      continue
    }
    raw++
    norm++
  }
  return raw
}

export interface NormalizedSpan {
  start: number
  end: number
  k: number
  normBody: string
  normNeedle: string
  fuzzy?: boolean
}

/**
 * #fix: 在 body 中查找与 needle 归一化后相同的片段,返回原始 body 中的
 * [start, end)(含空白差异,替换后不留残留)。找不到返回 null。
 * 两级匹配:
 *   1) 空白塌缩(换行位置/连续空格差异);
 *   2) 完全忽略空白(兜底 — PDF 断行把长词拆开插入空格,如药物名跨行)。
 * 图片 token 以「占位符+URL」参与匹配 — 含图片的锚点其替换 span 覆盖
 * 图片本体;跨图片但不含图片的 needle 不再命中(防静默删图)。
 * 命中级别连同归一化串返回,调用方可复用做多次命中判定。
 */
export function findNormalizedSpan(body: string, needle: string): NormalizedSpan | null {
  const nb = normalizeForMatch(body)
  const nn = normalizeForMatch(needle)
  // #fix: 空锚点守卫 — 纯空白/纯标记归一化后为空,indexOf('') 恒命中
  // 且重复判定恒报「出现多次」,必须在此拦下(调用方给出修正指引)。
  if (!nn) return null
  const k = nb.indexOf(nn)
  if (k !== -1) {
    const start = walkNorm(body, k, false)
    const end = walkNorm(body, k + nn.length, false)
    return { ...expandSpanOverMarkers(body, start, end, needle), k, normBody: nb, normNeedle: nn }
  }

  const fb = normalizeWsFree(body)
  const fn = normalizeWsFree(needle)
  const k2 = fb.indexOf(fn)
  if (k2 === -1) return null
  const start2 = walkNorm(body, k2, true)
  const end2 = walkNorm(body, k2 + fn.length, true)
  return { ...expandSpanOverMarkers(body, start2, end2, needle), k: k2, normBody: fb, normNeedle: fn }
}

/** 锚点片段长度与模糊匹配的编辑预算上限(needle 长度的比例)。 */
const FUZZY_EDIT_RATIO = 0.02
const FUZZY_MIN_EDITS = 10
const FUZZY_SLACK_RATIO = 0.05
const FUZZY_SLACK_MIN = 20
const FUZZY_SLACK_MAX = 120

/**
 * #fix: 模糊匹配兜底 — 两级精确归一化失败后,允许少量字符差异
 * (模型复制 old_text 时的拼写/词形微差,如把 "BwtAand" 脑补成
 * "Bwt/A and")。锚点策略:取 needle 前/后 FUZZY_ANCHOR_LEN 个字符在
 * body 中定位,再在锚点附近窗口内做半全局编辑距离(窗口侧允许自由
 * 前后缀删除),编辑数 ≤ maxEdits 才接受。命中级别 fuzzy=true。
 */
export function findFuzzySpan(body: string, needle: string): NormalizedSpan | null {
  const nb = normalizeWsFree(body)
  const nn = normalizeWsFree(needle)
  if (!nn) return null

  // 锚点:按长度递减尝试 needle 前缀/后缀片段(差异可能落在中间,过长的
  // 锚片段会把差异包含进去,退化为找不到)。
  let bp = -1
  let np = 0
  for (const len of [80, 60, 40, 24]) {
    const prefix = nn.slice(0, len)
    const p = nb.indexOf(prefix)
    if (p !== -1) {
      bp = p
      np = 0
      break
    }
    const suffix = nn.slice(-len)
    const s = nb.indexOf(suffix)
    if (s !== -1) {
      bp = s
      np = nn.length - len
      break
    }
  }
  if (bp === -1) return null

  const slack = Math.min(FUZZY_SLACK_MAX, Math.max(FUZZY_SLACK_MIN, Math.round(nn.length * FUZZY_SLACK_RATIO)))
  const winStart = Math.max(0, bp - np - slack)
  const winEnd = Math.min(nb.length, bp - np + nn.length + slack)
  const window = nb.slice(winStart, winEnd)
  const M = nn.length
  const N = window.length
  const maxEdits = Math.max(FUZZY_MIN_EDITS, Math.ceil(nn.length * FUZZY_EDIT_RATIO))

  // 半全局 DP:第 0 行自由跳过窗口前缀(代价 0,起点随 j);滚动行,
  // 同步记录每个 cell 的对齐起点;最后一行取最小代价(自由后缀删除)。
  let prev = new Float64Array(N + 1)
  let prevStart = new Int32Array(N + 1)
  for (let j = 0; j <= N; j++) {
    prev[j] = 0
    prevStart[j] = j
  }
  let best = Infinity
  let bestJ = -1
  let bestStart = 0
  for (let i = 1; i <= M; i++) {
    const curr = new Float64Array(N + 1)
    const currStart = new Int32Array(N + 1)
    curr[0] = i
    currStart[0] = 0
    const ni = nn.charCodeAt(i - 1)
    for (let j = 1; j <= N; j++) {
      const cost = ni === window.charCodeAt(j - 1) ? 0 : 1
      const del = curr[j - 1] + 1
      const ins = prev[j] + 1
      const sub = prev[j - 1] + cost
      if (del <= ins && del <= sub) {
        curr[j] = del
        currStart[j] = currStart[j - 1]
      } else if (ins <= sub) {
        curr[j] = ins
        currStart[j] = prevStart[j]
      } else {
        curr[j] = sub
        currStart[j] = prevStart[j - 1]
      }
    }
    if (i === M) {
      for (let j = 1; j <= N; j++) {
        if (curr[j] < best) {
          best = curr[j]
          bestJ = j
          bestStart = currStart[j]
        }
      }
    }
    prev = curr
    prevStart = currStart
  }
  if (best > maxEdits || bestJ === -1) return null

  const startNorm = winStart + bestStart
  const endNorm = winStart + bestJ
  if (startNorm >= endNorm) return null
  return {
    ...expandSpanOverMarkers(body, walkNorm(body, startNorm, true), walkNorm(body, endNorm, true), needle),
    k: startNorm,
    normBody: nb,
    normNeedle: nn,
    fuzzy: true,
  }
}

/** 锚点标记回扩 — 归一化剥离了 `**`/`##` 等标记,span 因此停在文字
 *  本体(如「**图1…**」的 span 不含加号标记)。若 needle 原文首/尾字符
 *  本身是语法标记,把 span 首/尾回扩到紧贴的标记(不跨空白),使含标记
 *  锚点的替换覆盖完整 token(否则换图后残留 `****` 断裂标记)。 */
function expandSpanOverMarkers(body: string, start: number, end: number, needle: string): { start: number; end: number } {
  let s = start
  let e = end
  const firstNonWs = needle.trimStart()[0]
  if (firstNonWs && isMatchSyntaxChar(firstNonWs)) {
    while (s > 0 && isMatchSyntaxChar(body[s - 1])) s--
  }
  const lastNonWs = needle.trimEnd().slice(-1)
  if (lastNonWs && isMatchSyntaxChar(lastNonWs)) {
    while (e < body.length && isMatchSyntaxChar(body[e])) e++
  }
  return { start: s, end: e }
}

/**
 * §15.4/#171 — edit_document: the conversational-writing write-back tool.
 *
 * 三种模式:
 * - import 模式(import_reference):把参考材料(上传的 PDF/DOCX/txt)的
 *   正文导入空文档 — 分步润色的前置步骤。导入后文档有了正文,分段/焦点/
 *   锚点机制自动生效,再按 range 模式逐段润色。导入不消耗模型输出。
 * - range 模式(old_text + new_text):局部编辑 — 在文档中精确替换一个
 *   原文片段。长文档分步润色靠它:一次改一段,用户确认后继续下一段,
 *   模型永远不需要把整篇文档重写一遍(输出 token 上限之外)。
 * - full 模式(full_text):全量替换,仅适合短文档整体修改。
 *
 * 版本化 + 自动快照 + 前端 diff 审阅(doc_updated SSE)对三种模式一致。
 */
export class EditDocumentTool extends BaseTool {
  constructor(private ctx: { userId: string; sessionId?: string }) {
    super()
  }

  get name(): string { return 'edit_document' }

  get description(): string {
    return [
      'Edit the current writing-session document. Three modes:',
      '- Import: pass `import_reference` (the reference-material name to import) when the document body is EMPTY and the user wants to work on an uploaded reference (PDF/DOCX/txt). This copies the reference text into the document.',
      '- Range edit (preferred for polishing long documents): pass `old_text` (the original text to replace, copied from the current document — line breaks/whitespace differences are tolerated) and `new_text` (the replacement). One edit per call; make multiple calls to edit multiple parts. When the document body is EMPTY and exactly one reference exists, the tool auto-imports it before applying the edit (so you can polish an uploaded reference without a separate import call). To replace a figure/link, include its image markdown together with surrounding caption text — image URLs must match exactly, and an old_text that spans an image must include the image.',
      '- Full rewrite: pass `full_text` (complete new document in markdown). Only for short documents or when the user explicitly asks to rewrite the whole document.',
      'Use this instead of explaining changes.',
    ].join(' ')
  }

  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        import_reference: { type: 'string', description: 'Import mode: the label/name of the reference material to import into the empty document (e.g. the uploaded file name).' },
        old_text: { type: 'string', description: 'Range mode: the original text to replace (must match the current document — whitespace/line-break differences are tolerated).' },
        new_text: { type: 'string', description: 'Range mode: the replacement text (empty to delete).' },
        full_text: { type: 'string', description: 'Full mode: the complete new document content in markdown.' },
        summary: { type: 'string', description: 'A one-line summary of what changed.' },
      },
      required: [],
    }
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const sessionId = this.ctx.sessionId || ''
    if (!sessionId.startsWith('doc-')) {
      return { success: false, error: 'edit_document is only available in a document writing session' }
    }
    const docId = sessionId.slice(4)

    const importRef = typeof args.import_reference === 'string' ? args.import_reference.trim() : ''
    if (importRef) return this.importReference(docId, importRef, String(args.summary || 'imported reference'))

    const oldText = typeof args.old_text === 'string' ? args.old_text : ''
    const newText = typeof args.new_text === 'string' ? args.new_text : ''
    const fullText = typeof args.full_text === 'string' ? args.full_text : ''

    // #fix: 分步编辑 — 提供了 old_text 就走局部替换,不要求完整文档。
    if (oldText) {
      if (!oldText.trim()) return { success: false, error: 'old_text is empty' }
      // #fix: 空锚点守卫 — 纯空白/markdown 标记归一化后为空,此前会退化
      // 为 indexOf('') 恒命中并假报「出现多次」,模型反复补上下文重试
      // 进入死循环。此处直接给出可执行的修正方向。
      if (!normalizeForMatch(oldText)) {
        return {
          success: false,
          error: 'old_text 归一化后为空(仅含空白或 markdown 标记,没有可定位的文字或图片 URL)。请从 ## Current Document 复制包含实际文字的片段作为 old_text(替换图片时连同图题文字一起复制)。',
        }
      }
      return this.rangeEdit(docId, oldText, newText, String(args.summary || 'range edit'))
    }

    if (!fullText.trim()) {
      return { success: false, error: 'Provide import_reference (empty document), old_text+new_text (range edit), or full_text (full rewrite).' }
    }
    return this.fullReplace(docId, fullText, String(args.summary || 'document updated'))
  }

  /** 当前文档的全部参考材料(label 与原始记录)— #774 抽到 doc-import.ts 共享。 */
  private async resolveDocImportTargets(docId: string) {
    return resolveImportTargets(this.ctx.userId, docId)
  }

  /** 导入模式:按 label 定位参考材料,把提取的正文写入文档。 */
  private async importReference(docId: string, reference: string, summary: string): Promise<ToolResult> {
    try {
      const labels = await this.resolveDocImportTargets(docId)
      const hit = labels.find(({ r, label }) => label.includes(reference) || reference.includes(label))
      if (!hit) {
        const available = labels.map((l) => l.label).slice(0, 5).join('、') || '(无)'
        return { success: false, error: `未找到参考材料 "${reference}"。当前参考材料:${available}。请用参考材料的名称(label)作为 import_reference。` }
      }

      const { text, error } = await extractRefText(this.ctx.userId, docId, hit.r, hit.label)
      if (error) return { success: false, error: error }
      const { body, error: writeError } = await writeDocBody(this.ctx.userId, docId, text, 'AI import')
      if (writeError) return { success: false, error: writeError }
      return { success: true, output: JSON.stringify({ body, summary: `已导入参考材料「${hit.label}」(${text.length} 字符)` }) }
    } catch (err) {
      return { success: false, error: `edit_document import failed: ${(err as Error).message.slice(0, 200)}` }
    }
  }

  /** 局部编辑:在文档中精确匹配 oldText 并替换为 newText。 */
  private async rangeEdit(docId: string, oldText: string, newText: string, summary: string): Promise<ToolResult> {
    try {
      const existing = await (prisma as any).doc.findFirst({ where: { id: docId, userId: this.ctx.userId } })
      if (!existing) return { success: false, error: `Document not found: ${docId}` }

      let body = String(existing.body || '')
      // #fix: 正文为空时局部编辑必然失败 — 若存在唯一参考材料(用户上传
      // PDF/DOCX 后直接说"润色"的典型场景),自动导入后再执行本编辑,
      // 不依赖模型先单独调一次 import_reference;多参考/无参考才报错引导。
      // #787: 编排收敛到 doc-import.ensureDraftBody(文案单点维护)。
      if (!body.trim()) {
        const ensured = await ensureDraftBody(this.ctx.userId, docId, { scenario: 'import_reference' })
        if (ensured.error) return { success: false, error: ensured.error }
        body = ensured.body
      }
      // #fix: 三级匹配 — 空白归一化(换行/连续空格/软连字符/markdown
      // 标题标记/大小写)→ 完全忽略空白 → 模糊匹配(少量字符差异)。
      // 命中后替换原始 span,新正文不留空白残留。
      const span = findNormalizedSpan(body, oldText) ?? findFuzzySpan(body, oldText)
      if (!span) {
        // #fix: 检测 old_text 是否来自参考材料而非正文 — 同一篇稿件不同
        // 格式(PDF vs DOCX)提取的文本有差异,模型从参考材料复制必然失配
        // (生产事故:正文是 PDF 版,参考是 DOCX 版)。命中的话报错去向明确:
        // 先 import_reference 导入该参考材料覆盖正文,再编辑。
        let refMatchLabel = ''
        try {
          const targets = await this.resolveDocImportTargets(docId)
          for (const { r, label } of targets.slice(0, 3)) {
            const { text } = await extractRefText(this.ctx.userId, docId, r, label)
            if (text && findNormalizedSpan(text, oldText)) { refMatchLabel = label; break }
          }
        } catch {
          // 检测失败不阻断 — 走普通提示
        }
        // 帮助模型修正锚点:给出文档开头附近的可匹配片段(保留大小写与
        // 标题标记,便于逐字复制)。
        // #fix: probe 取文档第一个非空行(通常是标题行)的完整内容 —
        // 模型会把 probe 直接复制成 old_text,按字符硬切在句子中间
        // (长标题 150+ 字符)必然失配;整行天然完整,复制即可命中。
        const probeLine = body.split('\n').map((l) => l.trim()).filter(Boolean)[0] || ''
        let probe = probeLine.slice(0, 300)
        if (probe.length > 120) {
          const cut = Math.max(
            probe.lastIndexOf('。'), probe.lastIndexOf('. '), probe.lastIndexOf('；'),
            probe.lastIndexOf('; '), probe.lastIndexOf('，'), probe.lastIndexOf(', '),
          )
          if (cut > 40) probe = probe.slice(0, cut + 1)
        }
        const guide = refMatchLabel
          ? `你复制的 old_text 与参考材料「${refMatchLabel}」一致,但与正文(## Current Document)不符 — 正文与参考材料来自不同文件格式/版本,提取的文本有差异。请先调用 edit_document 的 import_reference 导入「${refMatchLabel}」把该参考材料设为正文(覆盖后 old_text 即可匹配),或从 ## Current Document 逐字复制待修改的原文。`
          : '请从上方 ## Current Document 部分逐字复制待修改的原文,不要从「文档结构」清单复制(带序号),不要从 Reference Materials 复制。'
        return {
          success: false,
          error: `old_text 在文档中未找到(已忽略空格/换行/标题标记差异后仍不匹配)。${guide} 文档开头附近完整片段(可直接复制): "${probe}"`,
        }
      }
      // 归一化匹配同样参与多次命中判定 — 两个片段仅空白不同也视为重复;
      // 模糊匹配跳过(锚点窗口内已约束唯一性)。
      if (!span.fuzzy && span.normBody.indexOf(span.normNeedle, span.k + span.normNeedle.length) !== -1) {
        return {
          success: false,
          error: 'old_text 在文档中出现多次,请包含更多上下文让锚点唯一(比如加上前后句)',
        }
      }

      const newBody = body.slice(0, span.start) + newText + body.slice(span.end)
      if (newBody === body) return { success: false, error: 'old_text 与 new_text 相同,没有任何变化' }

      // #789: 写回走 DocVersionWriter 单点(快照同帧带旧 deck + 事务)。
      const written = await writeDocVersion({ userId: this.ctx.userId, docId, body: newBody, snapshotLabel: 'AI edit' })
      if (written.error) return { success: false, error: written.error }

      return {
        success: true,
        output: JSON.stringify({ body: written.body, summary }),
      }
    } catch (err) {
      return { success: false, error: `edit_document failed: ${(err as Error).message.slice(0, 200)}` }
    }
  }

  /** 全量替换(旧行为,仅短文档)。 */
  private async fullReplace(docId: string, fullText: string, summary: string): Promise<ToolResult> {
    try {
      const existing = await (prisma as any).doc.findFirst({ where: { id: docId, userId: this.ctx.userId } })
      if (!existing) return { success: false, error: `Document not found: ${docId}` }

      // #fix: 长文档全量重写会超 LLM 输出预算(8192 token)→ 截断成半篇、
      // 长时间生成触发网关/Cloudflare 超时重置 SSE("网络连接中断")。
      // 硬约束不依赖模型自觉:现有文档超限即拒绝,引导逐段 range 编辑。
      const docTokens = estimateTokens(String(existing.body || ''))
      const fullTextTokens = estimateTokens(fullText)
      const FULL_REPLACE_MAX_TOKENS = 2000
      if (docTokens > FULL_REPLACE_MAX_TOKENS || fullTextTokens > FULL_REPLACE_MAX_TOKENS) {
        return {
          success: false,
          error: `full_text 全量重写仅适用于短文档（约 ${FULL_REPLACE_MAX_TOKENS} token 以内）；当前文档约 ${docTokens} token，重写输出会被截断并导致连接超时。请改用 old_text/new_text 逐段编辑（每段一次调用），或提示用户先选中要修改的文本再操作。`,
        }
      }

      // #789: 写回走 DocVersionWriter 单点(无变化不产生空版本)。
      const written = await writeDocVersion({ userId: this.ctx.userId, docId, body: fullText, snapshotLabel: 'AI edit' })
      if (written.error) return { success: false, error: written.error }

      return {
        success: true,
        output: JSON.stringify({ body: written.body, summary }),
      }
    } catch (err) {
      return { success: false, error: `edit_document failed: ${(err as Error).message.slice(0, 200)}` }
    }
  }
}
