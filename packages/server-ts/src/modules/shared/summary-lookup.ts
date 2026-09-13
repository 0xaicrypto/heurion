/**
 * #1005 — guideline 双关归类器（临床指南粘贴 vs 知识库摘要）：
 * label 命中该用户当前 Summary 标题 → kb_summary + stableId，否则 pasted_text。
 *
 * 放在 modules/shared（实现依赖 user-context 记忆图谱）；`lib/reference-store`
 * 只持有 `GuidelineClassifier` 类型、由调用方注入 — 保持 lib 层不反向依赖
 * modules（分层规则 #672/#940）。
 */
import { getUserContext } from './user-context.js'
import type { ReferenceKind } from '../../lib/reference-store.js'

export async function classifyGuidelineBySummaryTitle(
  userId: string,
  label: string,
): Promise<{ kind: ReferenceKind; sourceRef: string | null }> {
  const title = String(label || '').trim()
  if (!title) return { kind: 'pasted_text', sourceRef: null }
  try {
    const ctx = getUserContext(userId) as unknown as {
      memory?: { graph?: { getCurrentNodesByType?: (t: string) => Array<{ stableId?: string; title?: string }> } }
    }
    const nodes = ctx.memory?.graph?.getCurrentNodesByType?.('summary') ?? []
    const hit = nodes.find((n) => String(n.title || '').trim() === title)
    if (hit?.stableId) return { kind: 'kb_summary', sourceRef: hit.stableId }
  } catch {
    // 记忆图谱不可读 → 降级为粘贴文本（不阻塞引用登记）
  }
  return { kind: 'pasted_text', sourceRef: null }
}
