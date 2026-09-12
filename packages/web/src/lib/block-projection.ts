/**
 * #989 Phase 3 — 块投影的前端消费（编辑过程流式可见,#987）。
 *
 * diffProjectionSections(base, next):以 section id 为稳定键(服务端派生,
 * 正文编辑不换 ID),返回 hash 变更或新增的节 — 写回进行中画布展示
 * 「AI 正在编辑哪些节」的纯函数。ID 对前端是不透明字符串,零服务端逻辑
 * 复制(与 hash 规则完全解耦)。
 */
export interface SectionLite {
  id: string
  heading: string
  level?: number
}

export function diffProjectionSections(
  base: { nodes: Array<{ id: string; kind: string; heading?: string; level?: number; hash?: string }> } | null | undefined,
  next: { nodes: Array<{ id: string; kind: string; heading?: string; level?: number; hash?: string }> } | null | undefined,
): SectionLite[] {
  if (!next) return []
  const baseMap = new Map<string, string>()
  for (const n of base?.nodes ?? []) {
    if (n.kind === 'section') baseMap.set(n.id, String(n.hash ?? ''))
  }
  const out: SectionLite[] = []
  for (const n of next.nodes) {
    if (n.kind !== 'section') continue
    const prevHash = baseMap.get(n.id)
    if (prevHash === undefined || prevHash !== String(n.hash ?? '')) {
      out.push({ id: n.id, heading: n.heading || '', level: n.level })
    }
  }
  return out
}
