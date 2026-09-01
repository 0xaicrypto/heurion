import prisma from '../common/prisma.js'

/**
 * #789 — doc 写回单点 owner（body+deck 同帧不变量）。
 *
 * 「读旧行 → 判定变化 → 同帧快照 → 更新」此前在 7 处手写且强度不一致：
 * 工具路径快照不带旧 deck（恢复时 body+deck 拆散）、两段写无事务、
 * deck 变更判定各写一份。本函数是工具/AI 路径的唯一写回入口：
 *   - body / deck 任一省略即保持现值；deck 传对象（null 清空）；
 *   - 变化时 docSnapshot.create(旧 body+旧 deck 同帧) + doc.update 包同
 *     事务 — 中断不会留下"有快照无更新"或"快照缺 deck"的错位；
 *   - 无变化不写快照、不碰 updatedAt（保存按钮 unchanged 提示依赖）。
 *
 * 用户手动保存路径（documents.router PUT /docs/:docId）已自含同帧语义
 * 且需合并 title 等字段，不经此函数（保持现状，不变量等价）。
 */

export interface DocVersionWrite {
  userId: string
  docId: string
  /** 新正文 — 省略保持现值。 */
  body?: string
  /** 新 deck（对象）— 省略保持现值；null 清空。 */
  deck?: Record<string, unknown> | null
  snapshotLabel: string
}

export interface DocVersionResult {
  body: string
  /** 写回后的 deck（解析对象；无 deck 为 null）。 */
  deck: unknown
  changed: boolean
  error?: string
}

function parseDeckJson(raw: unknown): unknown {
  if (typeof raw !== 'string' || !raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null // deck 损坏容错 — 与线上 parseDeck 行为一致
  }
}

export async function writeDocVersion(input: DocVersionWrite): Promise<DocVersionResult> {
  const existing = await (prisma as any).doc.findFirst({ where: { id: input.docId, userId: input.userId } })
  if (!existing) return { body: '', deck: null, changed: false, error: `Document not found: ${input.docId}` }

  const prevBody = String(existing.body || '')
  const prevDeckRaw = existing.deck ?? null
  const nextBody = input.body ?? prevBody
  const nextDeckRaw = input.deck === undefined ? prevDeckRaw : JSON.stringify(input.deck)
  const bodyChanged = nextBody !== prevBody
  const deckChanged = nextDeckRaw !== prevDeckRaw

  if (!bodyChanged && !deckChanged) {
    return { body: prevBody, deck: parseDeckJson(prevDeckRaw), changed: false }
  }

  const now = new Date().toISOString()
  await (prisma as any).$transaction([
    // 同帧快照旧 body+旧 deck — 恢复时一致回滚（#773 方案 A，此前仅
    // 用户保存路径保证，工具路径快照缺 deck）。
    (prisma as any).docSnapshot.create({
      data: {
        docId: input.docId, userId: input.userId,
        body: prevBody, deck: prevDeckRaw,
        label: input.snapshotLabel, createdAt: now,
      },
    }),
    (prisma as any).doc.update({
      where: { id: input.docId },
      data: { body: nextBody, deck: nextDeckRaw, updatedAt: now },
    }),
  ])
  return {
    body: nextBody,
    deck: input.deck === undefined ? parseDeckJson(prevDeckRaw) : input.deck,
    changed: true,
  }
}
