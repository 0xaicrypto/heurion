/**
 * #1101 §5 — deck_slide 评论锚点升级：anchorShapeId（pptx 原生稳定标识）。
 *
 * spike #1102 实测：pptx-viewer-core `findText(slides, search)` 返回的
 * elementId（`ppt/slides/slideN.xml-shape-M` = part path + 加载器序位 shape
 * id）跨 save/load round-trip 稳定 — 是文件原生标识，比 DeckWire 投影的
 * slideIndex+blockIndex（画布级重排即大面积漂移）可靠。
 *
 * 锚点判定协议（设计文档 §5）：
 *   1. 评论带 anchorShapeId 且工件可读 → 按 shapeId 精确判定：形状在场且
 *      形状文本仍含 anchorText（归一化精确 + 模糊兜底，edit_document 同口径）
 *      → located。这是主路径 — 画布重排/页序漂移不再失配。
 *   2. shapeId 失配（形状被删/文本改写超模糊预算）→ 回退既有 anchorText
 *      模糊重定位（comments.router diagnoseDeckAnchor，本文件不动它）。
 *   3. 无工件 → 完全走既有行为。
 *
 * 分层：lib 层复用 deck-bytes 的工件读取；pptx-viewer-core 懒加载（引擎较
 * 重，避免常驻启动面 — deck-bytes 同款纪律）。所有失败路径静默返回 null /
 * false — 锚点增强绝不阻塞评论读写主链路。
 */
import type { Presentation } from 'pptx-viewer-core'
import { getDeckArtifact, deckProjectionStaleness, type DeckArtifactContent } from './deck-bytes.js'
import { findNormalizedSpan, findFuzzySpan } from './document-span-match.js'
import { makeLogger } from '../common/logger.js'

const log = makeLogger('deck-comment-anchor')

/** 打开的锚点引擎（调用方负责 disposeDeckAnchorEngine）。 */
export interface DeckAnchorEngine {
  artifact: DeckArtifactContent
  pres: Presentation
  /** elementId → 形状全部文本段拼接（与 findText 同一文本面）。 */
  shapeTexts: Map<string, string>
}

/** 深度收集元素（组内递归 — findText/collectElements 同口径）。 */
function collectDeep(elements: readonly unknown[]): unknown[] {
  const out: unknown[] = []
  for (const el of elements ?? []) {
    if (!el || typeof el !== 'object') continue
    out.push(el)
    const children = (el as { type?: unknown; children?: unknown }).children
    if ((el as { type?: unknown }).type === 'group' && Array.isArray(children)) {
      out.push(...collectDeep(children))
    }
  }
  return out
}

/** 元素文本段拼接（findText 迭代 textSegments 的同一文本面；无文本段 → 空）。 */
function elementText(el: unknown): string {
  const segs = (el as { textSegments?: unknown }).textSegments
  if (!Array.isArray(segs)) return ''
  return segs.map((s) => String((s as { text?: unknown })?.text ?? '')).join('')
}

/** 打开工件锚点引擎：getDeckArtifact → Presentation.load → elementId 文本索引。 */
export async function openDeckAnchorEngine(docId: string): Promise<DeckAnchorEngine | null> {
  try {
    const artifact = await getDeckArtifact(docId)
    if (!artifact) return null
    return await openDeckAnchorEngineFromArtifact(artifact)
  } catch (err) {
    log.info('deck anchor engine open failed', { docId, reason: (err as Error).message.slice(0, 120) })
    return null
  }
}

/** 已加载工件 → 引擎（create/PATCH 路径避免 getDeckArtifact 二次读 doc 行）。 */
export async function openDeckAnchorEngineFromArtifact(artifact: DeckArtifactContent): Promise<DeckAnchorEngine | null> {
  try {
    const { Presentation } = await import('pptx-viewer-core')
    const pres = await Presentation.load(new Uint8Array(artifact.bytes).buffer)
    const shapeTexts = new Map<string, string>()
    for (const slide of pres.slides) {
      for (const el of collectDeep(slide.elements ?? [])) {
        const id = (el as { id?: unknown }).id
        if (typeof id !== 'string' || !id) continue
        const text = elementText(el)
        if (!text) continue
        shapeTexts.set(id, shapeTexts.has(id) ? `${shapeTexts.get(id)}\n${text}` : text)
      }
    }
    return { artifact, pres, shapeTexts }
  } catch (err) {
    log.info('deck anchor engine load failed', { artifactId: artifact.artifactId, reason: (err as Error).message.slice(0, 120) })
    return null
  }
}

export function disposeDeckAnchorEngine(engine: DeckAnchorEngine): void {
  try {
    engine.pres.handler.dispose()
  } catch {
    // 引擎已失效 — 无害
  }
}

/**
 * findText 解析 anchorText → 命中 shapeId（pptx-viewer-core standalone
 * findText(slides, search) — spike #1102 验证的正式 API）。缺省取首个命中
 * （create/PATCH 路径 — 评论创建于当前画布态，首个命中即锚点目标）；
 * opts.unique=true 要求全部命中落在同一形状（懒回填路径 — 多形状命中说明
 * 锚点文本不唯一，不回填）。
 */
export async function resolveAnchorShapeId(engine: DeckAnchorEngine, anchorText: string, opts: { unique?: boolean } = {}): Promise<string | null> {
  const needle = String(anchorText || '').trim()
  if (!needle) return null
  try {
    const { findText } = await import('pptx-viewer-core')
    const hits = findText(engine.pres.slides, needle)
    if (hits.length === 0) return null
    if (opts.unique && new Set(hits.map((h) => h.elementId)).size > 1) return null
    return hits[0].elementId
  } catch (err) {
    log.info('findText anchor resolve failed', { reason: (err as Error).message.slice(0, 120) })
    return null
  }
}

/**
 * shapeId 精确判定 — 形状在场且形状文本仍含 anchorText（归一化精确 +
 * 模糊兜底，与 edit_document/评论重定位同一套容错口径，不另设相似度阈值）。
 */
export function shapeHoldsAnchor(engine: DeckAnchorEngine, elementId: string, anchorText: string): boolean {
  const text = engine.shapeTexts.get(elementId)
  if (!text) return false
  try {
    return Boolean(findNormalizedSpan(text, anchorText) ?? findFuzzySpan(text, anchorText))
  } catch {
    return false
  }
}

/**
 * 评论锚点 shapeId 解析（create / PATCH 改锚共用）：deck 工件在场且投影非
 * 过期（staleness 'stale' = 工件刚写、投影写未发生的瞬态窗口 — 按未投影
 * 处理，绝不半途定位）→ findText 首个命中；无工件/过期/无命中/任何异常 →
 * null（anchorShapeId 留空，legacy anchorText 模糊路径不受影响）。
 */
export async function resolveCommentAnchorShapeId(
  doc: { id: string; updatedAt: string; deck: string | null },
  anchorText: string,
): Promise<string | null> {
  try {
    const artifact = await getDeckArtifact(doc.id)
    if (!artifact || deckProjectionStaleness(doc, { id: artifact.artifactId, updatedAt: artifact.updatedAt }) === 'stale') return null
    const engine = await openDeckAnchorEngineFromArtifact(artifact)
    if (!engine) return null
    try {
      // await 而非裸 return — 否则 finally 的 dispose 会先于 findText 完成。
      return await resolveAnchorShapeId(engine, anchorText)
    } finally {
      disposeDeckAnchorEngine(engine)
    }
  } catch {
    return null
  }
}
