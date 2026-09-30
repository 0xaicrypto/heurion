import type { CommentAnchor, CommentRow, Store } from '../db.ts'
import type { Projection, ProjectionNode } from './office.ts'

/**
 * 锚点诊断与漂移审计（S2，DESIGN.md §4.5）。
 *
 * 锚点 = 目标 id（para_id / shape_id）+ 文字片段冗余。定位规则：
 * - 目标节点存在，且片段仍能在其文本（或全文归一化拼接）中找到 → located；
 * - 目标消失、或片段对不上 → 漂移，并给最近候选（归一化子串命中的节点），
 *   供模型一次修正、不盲猜。
 * 每次落版后重跑（与引用审计同一位置），失败线程标「漂移」。
 */

const norm = (s: string): string => s.replace(/\s+/g, '').toLowerCase()

export interface AnchorDiagnosis {
  located: boolean
  /** 漂移时的重定位候选（最多 3 个）：id + 当前文本摘要。 */
  candidates?: Array<{ id: string; text: string }>
}

function allNodes(projection: Projection): ProjectionNode[] {
  return [...(projection.nodes ?? []), ...(projection.slides ?? []).flatMap(s => s.shapes)]
}

/** 归一化全文：跨段落/形状选区的片段也能命中。 */
function fullText(nodes: ProjectionNode[]): string {
  return norm(nodes.map(n => n.text).join(''))
}

export function locateAnchor(anchor: CommentAnchor, projection: Projection): AnchorDiagnosis {
  const nodes = allNodes(projection)
  const snippet = norm(anchor.text_snippet)
  const targetId = anchor.para_id ?? anchor.shape_id
  const target = targetId ? nodes.find(n => n.id === targetId) : undefined

  // 纯片段锚点（无固定目标 id）：片段在文中任何位置即视为定位。
  if (!targetId) return { located: fullText(nodes).includes(snippet) }

  if (!target) {
    // 目标 id 消失：片段在别处 → 漂移 + 候选（待重定位）；片段也没了 → 漂移。
    if (!snippet) return { located: false }
    const candidates = nodes
      .filter(n => norm(n.text).includes(snippet))
      .slice(0, 3)
      .map(n => ({ id: n.id, text: n.text.slice(0, 120) }))
    return { located: false, candidates: candidates.length > 0 ? candidates : undefined }
  }

  // 目标还在：片段命中（含跨节点选区）→ 定位；对不上 → 内容被改写，漂移 + 模糊候选。
  if (norm(target.text).includes(snippet) || fullText(nodes).includes(snippet)) return { located: true }
  const candidates = nodes
    .filter(n => snippet.length >= 4 && norm(n.text).includes(snippet.slice(0, Math.max(4, Math.floor(snippet.length / 2)))))
    .slice(0, 3)
    .map(n => ({ id: n.id, text: n.text.slice(0, 120) }))
  return { located: false, candidates: candidates.length > 0 ? candidates : undefined }
}

/**
 * 漂移审计：对文档全部 open 评论在新投影下重新定位，更新 drifted 标记。
 * 返回（漂移的线程 id 列表）供 SSE 事件使用。幂等，可重复执行。
 */
export function auditCommentAnchors(store: Store, docId: string, seq: number, projection: Projection): string[] {
  const open: CommentRow[] = store.listComments(docId, 'open')
  const drifted: string[] = []
  for (const c of open) {
    const ok = locateAnchor(c.anchor, projection).located
    if (!ok) drifted.push(c.id)
    if (c.drifted !== !ok) store.setCommentDrift(c.id, !ok)
  }
  // resolved 线程不重定位（已完结）；reopen 时 drifted 由 reopen 清零、下次落版重算。
  return drifted
}
