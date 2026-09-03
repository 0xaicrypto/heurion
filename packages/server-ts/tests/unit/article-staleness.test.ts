import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { MemoryGraph } from '../../src/memory/memory.graph'
import { CurationEngine } from '../../src/memory/curation/curation.engine'
import { resolveArticleStaleness, describeArticleForInjection } from '../../src/memory/staleness'
import type { FactNode, ArticleNode } from '../../src/memory/memory.types'

/**
 * #813 — 失效判定单一入口:
 * 1. resolveArticleStaleness 的推导语义(编辑/删除/状态三路);
 * 2. curation 事件路径与判定入口对齐(传播后 status === 判定结果);
 * 3. staleBecause 保持裸 fact stableId(article-view/legacy 反查兼容)。
 */

let baseDir: string
let graph: MemoryGraph
beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-'))
  graph = new MemoryGraph(baseDir)
})
afterEach(() => fs.rmSync(baseDir, { recursive: true, force: true }))

let seq = 0
function fact(stableId: string, version: number, status: FactNode['status']): FactNode {
  seq += 1
  return {
    id: `${stableId}@v${version}`, stableId, type: 'fact', ownerId: 'u1', status,
    content: `fact ${stableId} v${version}`, contentHash: `h${seq}`, version,
    createdAt: 1, updatedAt: 1, createdBy: 'system', provenance: { sourceKind: 'chat' },
    meta: {}, category: 'fact', sourceType: 'patient', count: 1, confidence: 0.9,
  }
}
function article(stableId: string, version: number, status: ArticleNode['status'], sourceFacts: ArticleNode['sourceFacts'], staleBecause?: string[]): ArticleNode {
  seq += 1
  return {
    id: `${stableId}@v${version}`, stableId, type: 'article', ownerId: 'u1', status,
    content: 'c', contentHash: `h${seq}`, version, createdAt: 1, updatedAt: 1, createdBy: 'system',
    provenance: { sourceKind: 'chat' }, meta: {}, title: `t-${stableId}`,
    sourceFacts, ...(staleBecause ? { staleBecause } : {}),
  }
}
function addFactAndArticle(factStableId: string, articleStableId: string): { fact: FactNode; art: ArticleNode } {
  const f = fact(factStableId, 1, 'current')
  const art = article(articleStableId, 1, 'current', [{ nodeId: f.id, stableId: f.stableId, version: f.version, snapshot: f.content }])
  graph.addNode(f)
  graph.addNode(art)
  graph.addRelation({ id: `rel_${articleStableId}`, sourceId: art.id, targetId: f.id, relation: 'depends_on', createdAt: 1 })
  return { fact: f, art }
}

describe('#813 resolveArticleStaleness — derivation semantics', () => {
  test('healthy article → not stale', () => {
    const { art } = addFactAndArticle('fact_a', 'art_1')
    const r = resolveArticleStaleness(graph, art)
    expect(r.stale).toBe(false)
    expect(r.reasons).toEqual([])
    expect(r.summary).toBe('')
  })

  test('fact edited after cite (v1 superseded, v2 current) → stale with edited reason', () => {
    const { fact: f, art } = addFactAndArticle('fact_a', 'art_1')
    graph.markStatus(f.id, 'superseded')
    const v2 = fact('fact_a', 2, 'current')
    graph.addNode(v2)
    const r = resolveArticleStaleness(graph, art)
    expect(r.stale).toBe(true)
    expect(r.reasons).toContain('edited:fact_a')
    expect(r.summary).toContain('fact_a 已修订')
  })

  test('fact deleted (no surviving version) → stale with deleted reason', () => {
    const { fact: f, art } = addFactAndArticle('fact_a', 'art_1')
    graph.markStatus(f.id, 'superseded')
    const r = resolveArticleStaleness(graph, art)
    expect(r.stale).toBe(true)
    expect(r.reasons).toContain('deleted:fact_a')
    expect(r.summary).toContain('fact_a 已删除')
  })

  test('article citing only the NEW version after an edit → NOT stale (over-mark regression)', () => {
    const { fact: f } = addFactAndArticle('fact_a', 'art_1')
    graph.markStatus(f.id, 'superseded')
    const v2 = fact('fact_a', 2, 'current')
    graph.addNode(v2)
    const art2 = article('art_2', 1, 'current', [{ nodeId: v2.id, stableId: v2.stableId, version: v2.version, snapshot: v2.content }])
    graph.addNode(art2)
    expect(resolveArticleStaleness(graph, art2).stale).toBe(false)
  })

  test('status superseded → stale regardless of sources', () => {
    const { art } = addFactAndArticle('fact_a', 'art_1')
    graph.markStatus(art.id, 'superseded')
    const r = resolveArticleStaleness(graph, graph.getNode(art.id) as ArticleNode)
    expect(r.stale).toBe(true)
    expect(r.reasons).toEqual(['article_superseded'])
  })

  test('historical stale status survives when sources look healthy (no silent revival)', () => {
    const { art } = addFactAndArticle('fact_a', 'art_1')
    graph.markStatus(art.id, 'stale')
    const r = resolveArticleStaleness(graph, graph.getNode(art.id) as ArticleNode)
    expect(r.stale).toBe(true)
  })
})

describe('#813 curation propagation aligned with the single entrypoint', () => {
  test('propagateFactChange marks stale iff resolver says stale; staleBecause stays bare stableIds', () => {
    const engine = new CurationEngine(graph)
    const { fact: f, art } = addFactAndArticle('fact_a', 'art_1')

    // edit: v1 superseded, v2 current → article must go stale
    graph.markStatus(f.id, 'superseded')
    graph.addNode(fact('fact_a', 2, 'current'))
    const result = engine.propagateFactChange('fact_a')

    expect(result.staleArticleStableIds).toContain('art_1')
    const node = graph.getLatestByStableId('art_1') as ArticleNode
    expect(node.status).toBe('stale')
    // 判定入口与事件路径结论一致
    expect(resolveArticleStaleness(graph, node).stale).toBe(true)
    // 兼容性:节点上的 staleBecause 保持裸 id(不含 edited:/deleted: 前缀)
    expect(node.staleBecause).toContain('fact_a')
    expect((node.staleBecause || []).every((id) => !id.includes(':'))).toBe(true)
  })

  test('article citing the current version survives a propagation pass (precision)', () => {
    const engine = new CurationEngine(graph)
    const { fact: f } = addFactAndArticle('fact_a', 'art_1')
    graph.markStatus(f.id, 'superseded')
    const v2 = fact('fact_a', 2, 'current')
    graph.addNode(v2)
    engine.propagateFactChange('fact_a')

    const art2 = article('art_2', 1, 'current', [{ nodeId: v2.id, stableId: v2.stableId, version: v2.version, snapshot: v2.content }])
    graph.addNode(art2)
    graph.addRelation({ id: 'rel_art2', sourceId: art2.id, targetId: v2.id, relation: 'depends_on', createdAt: 2 })

    // 再次传播(如同一 stableId 的后续事件)— 引用当前版本的 article 不被误标
    engine.propagateFactChange('fact_a')
    expect((graph.getLatestByStableId('art_2') as ArticleNode).status).toBe('current')
  })

  test('zero surviving dependencies → supersede (existing semantics preserved)', () => {
    const engine = new CurationEngine(graph)
    const { fact: f, art } = addFactAndArticle('fact_a', 'art_1')
    graph.markStatus(f.id, 'superseded') // delete-style: no newer version
    engine.propagateFactChange('fact_a')
    expect((graph.getLatestByStableId('art_1') as ArticleNode).status).toBe('superseded')
  })
})

describe('#813 describeArticleForInjection', () => {
  test('returns title + confidence/source summary + stale flag', () => {
    const { fact: f, art } = addFactAndArticle('fact_a', 'art_1')
    const meta = describeArticleForInjection(graph, 'art_1')
    expect(meta).toBeDefined()
    expect(meta!.title).toBe('t-art_1')
    expect(meta!.stale).toBe(false)
    expect(meta!.sourceSummary).toContain('fact_a[0.9,patient]')
    void f
    void art
  })

  test('stale article carries a human-readable summary', () => {
    const { fact: f } = addFactAndArticle('fact_a', 'art_1')
    graph.markStatus(f.id, 'superseded')
    graph.addNode(fact('fact_a', 2, 'current'))
    const meta = describeArticleForInjection(graph, 'art_1')!
    expect(meta.stale).toBe(true)
    expect(meta.staleSummary).toContain('fact_a 已修订')
  })

  test('unknown stableId → undefined (caller falls back to raw rendering)', () => {
    expect(describeArticleForInjection(graph, 'nope')).toBeUndefined()
  })
})
