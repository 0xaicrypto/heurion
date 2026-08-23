/**
 * #633 — 知识库选择器统一检索(Phase 2)。
 *
 * 选择器(/knowledge/picker)从词法过滤(title/summary includes)升级为
 * 统一检索:词法(节点标题/内容子串) + 向量(embedding 余弦) → RRF 融合。
 * 语义相近词可命中(如搜"放疗抵抗"命中 ATR 论文),词法精确词不降级。
 * embedding 服务故障自动回落纯词法。
 */
import { rrfFusion, type RrfCandidate } from '../../retrieval/rrf-fusion.js'
import type { EmbeddingService } from '../../memory/embedding/embedding.service.js'

export interface PickerNode {
  stableId: string
  type: 'article' | 'document'
  title: string
  content?: string
  updatedAt: number
}

export interface PickerHit {
  node: PickerNode
  score: number
  sources: string[]
}

const PICKER_TOP_K = 50

/**
 * 在节点池内做双路 RRF 检索。q 为空 → 全量(按节点序)。
 * 只返回节点池内条目 — 向量路命中但节点不在池中(已删除/越权)不输出。
 */
export async function searchPickerItems(
  nodes: PickerNode[],
  q: string,
  embedding?: EmbeddingService,
): Promise<PickerHit[]> {
  const qTrim = q.trim()
  const qLower = qTrim.toLowerCase()
  const byStableId = new Map(nodes.map((n) => [n.stableId, n]))

  // 词法路: 标题/内容子串匹配(不区分大小写)
  const lexical: RrfCandidate[] = []
  let rank = 0
  for (const n of nodes) {
    const hay = `${n.title} ${n.content || ''}`.toLowerCase()
    if (!qLower || hay.includes(qLower)) {
      lexical.push({ content: n.title, source: 'keyword', sourceId: n.stableId, rank: ++rank })
    }
  }

  // 向量路: embedding 余弦(仅 article/document 记录,且须在节点池内)
  const vector: RrfCandidate[] = []
  if (qTrim && embedding) {
    try {
      const vecHits = await embedding.retrieve(qTrim, {}, {
        topK: PICKER_TOP_K * 2,
        minScore: 0.2,
        includeCrossPatient: true,
      })
      let vrank = 0
      for (const h of vecHits) {
        if (h.type !== 'article' && h.type !== 'document') continue
        if (!byStableId.has(h.stableId)) continue
        vector.push({ content: h.content, source: 'vector', sourceId: h.stableId, rank: ++vrank })
      }
    } catch {
      // embedding 服务故障 → 词法路兜底
    }
  }

  const merged = rrfFusion([lexical, vector], PICKER_TOP_K)
  const hits: PickerHit[] = []
  for (const m of merged) {
    const node = byStableId.get(m.sourceIds[0])
    if (!node) continue
    hits.push({ node, score: m.score, sources: m.sources })
  }
  return hits
}
