/**
 * Document span matching (#697) — the normalization + span-location
 * algorithm family extracted from edit-document-tool.ts so it can be unit
 * tested against edge cases (image token folding, cross-line, fence
 * stripping, edit-ratio budgets) without the tool/prisma layer.
 *
 * Pure functions: no prisma, no I/O.
 *
 * 匹配时忽略的 markdown 语法字符 — 模型复制 old_text 时常省略/重排这些
 * 标记(`## ` 标题、`**` 强调、`` ` `` 行内代码、`>` 引用、`•` 列表圆点),
 * 而导入后的文档正文里它们真实存在,字符级差异会让两级空白匹配失效。
 */

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
