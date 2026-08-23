/**
 * #627 — 统一事实渲染与跨 store 去重 key。
 *
 * layer3 / 自动注入 / patient block 共用同一渲染函数:去重后同一事实
 * 只以一种说法出现,避免模型看到不同格式产生困惑。legacy Fact(无
 * stableId,stores.ts)与 graph FactNode(contentHash)用
 * content+category+patientHash 收敛为同一 key — 跨 store 去重的基础。
 */
import { daysAgo } from './attention.js'

export interface RenderableFact {
  category?: string
  importance?: number
  content: string
  createdAt?: number
  confidence?: number
  provenance?: { sourceKind?: string }
}

/** 统一事实渲染 — 与 layer3 历史格式一致,保证去重后表述单一。 */
export function formatFactLine(f: RenderableFact): string {
  const stars = '★'.repeat(Math.max(1, Math.min(5, f.importance ?? 3)))
  const days = Math.round(daysAgo(f.createdAt))
  const confidence = typeof f.confidence === 'number' ? `conf ${f.confidence}` : null
  const source = f.provenance?.sourceKind ? `source: ${f.provenance.sourceKind}` : null
  const evidence = [confidence, source].filter(Boolean).join(', ')
  return `[${f.category || 'fact'} ${stars}] ${f.content} (${days}d ago${evidence ? ` [${evidence}]` : ''})`
}

/** 跨 store 事实去重 key — content+category+patientHash(#627)。 */
export function factContentHash(f: { content: string; category?: string; patientHash?: string }): string {
  return `${f.patientHash || ''}|${f.category || 'fact'}|${f.content}`
}
