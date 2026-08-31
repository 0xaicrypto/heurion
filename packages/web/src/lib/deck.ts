/**
 * #770 — deck.ts: 幻灯片视图的切分/重组层。
 *
 * 原则（epic #775 设计决策 2）：markdown `body` 是唯一数据源，deck 视图 =
 * body 的投影。切分语义必须与后端 `buildPresentationContent`
 * （packages/server-ts/src/tools/insert-asset-tool.ts，#767）保持一致：
 *   - `#{1,3}` 行开新页（heading）；首个 `#`（且尚无页）是文档标题，不成页
 *   - 连续正文行逐行成段；`-`/`*` 前缀 → bullet
 *   - `![caption](url)` 行 → 图片块（卡片内渲染缩略图）
 *   - 无任何 heading → 单页「概述」（与后端一致）
 *   - 上限：30 页 / 每页 50 块（后端契约 presentationContentSchema 上限 30 slides、
 *     buildDocumentContent 每段 100 → presentation 取 50）
 *
 * slidesToMarkdown 供 #773（deck JSON 编辑写回）与测试锁语义使用。
 */

export interface SlideBlock {
  type: 'paragraph' | 'bullet' | 'image'
  text: string
  /** image 专用。 */
  url?: string
  caption?: string
}

export interface Slide {
  title: string
  blocks: SlideBlock[]
  /** 原始 heading 行文本（如 `## 结果`）— 卡片「编辑」锚定回文档用。 */
  headingRaw: string
  /** 该页在文档中的标题（锚点匹配用）。 */
}

export interface DeckParseResult {
  /** 首个 `#` 标题（无则空串）。 */
  title: string
  slides: Slide[]
}

const MAX_SLIDES = 30
const MAX_BLOCKS_PER_SLIDE = 50
/** 超限时的占位文案（与后端「内容过长，其余段落已省略」语义一致）。 */
const TRUNCATION_NOTE = '（内容过长，其余段落已省略）'

/** markdown body → slides（只读投影；语义锁定 buildPresentationContent）。 */
export function toSlides(body: string): DeckParseResult {
  const slides: Slide[] = []
  let title = ''
  let current: Slide | null = null

  const pushCurrent = () => {
    if (current) slides.push(current)
  }

  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const h = /^(#{1,3})\s+(.*)$/.exec(line)
    if (h) {
      if (h[1].length === 1 && !current && slides.length === 0) {
        title = h[2]
        continue
      }
      pushCurrent()
      current = { title: h[2], blocks: [], headingRaw: line }
      continue
    }
    if (!current) {
      current = { title: '概述', blocks: [], headingRaw: '' }
    }
    if (current.blocks.length >= MAX_BLOCKS_PER_SLIDE) {
      if (current.blocks[current.blocks.length - 1]?.text !== TRUNCATION_NOTE) {
        current.blocks.push({ type: 'paragraph', text: TRUNCATION_NOTE })
      }
      continue
    }
    const img = /^!\[([^\]]*)\]\(([^)\s]+)\)$/.exec(line)
    if (img) {
      current.blocks.push({ type: 'image', text: img[1] || '图', url: img[2], caption: img[1] })
      continue
    }
    const bullet = /^[-*]\s+(.*)$/.exec(line)
    if (bullet) {
      current.blocks.push({ type: 'bullet', text: bullet[1] })
    } else {
      current.blocks.push({ type: 'paragraph', text: line })
    }
    if (slides.length >= MAX_SLIDES) break
  }
  pushCurrent()
  if (slides.length > MAX_SLIDES) slides.length = MAX_SLIDES
  return { title, slides }
}

/** slides → markdown（#773 deck 写回与测试用；与 toSlides 可逆于语义层）。 */
export function slidesToMarkdown(deck: DeckParseResult): string {
  const groups: string[] = []
  if (deck.title) groups.push(`# ${deck.title}`)
  for (const slide of deck.slides) {
    const lines: string[] = [slide.headingRaw || `## ${slide.title}`]
    for (const block of slide.blocks) {
      if (block.type === 'image') lines.push(`![${block.caption || ''}](${block.url})`)
      else if (block.type === 'bullet') lines.push(`- ${block.text}`)
      else lines.push(block.text)
    }
    groups.push(lines.join('\n\n'))
  }
  return groups.join('\n\n').trim()
}
