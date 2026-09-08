import { resolveTierModel } from '../../common/llm-gateway.js'
import prisma from '../../common/prisma.js'
import { getApiKey, deepseekChat} from '../../common/llm.js'
import { parseLlmJson } from '../../common/llm-json.js'

export interface TakeawayInput {
  userId: string
  sessionId: string
  conversationText: string
  patientHash?: string
}

export interface Takeaway {
  id: number
  userId: string
  scopeKind: 'session' | 'patient' | 'global'
  scopeRef: string
  text: string
  tag: string | null
  confidence: number
  /** #701: schema 真实字段(蒸馏时间,epoch 秒) — 原 createdAt 是不存在的列。 */
  distilledAt: number
}

const TAKEAWAY_SYSTEM = `You capture clinical takeaways from a conversation. A takeaway is a concise, actionable insight that should persist beyond the current session.

Return JSON array:
[{"text": "takeaway sentence", "tag": "clinical|preference|plan|question|decision", "confidence": 0.0-1.0}]

Limit to 3-5 most important takeaways. Be specific and actionable.`

export async function extractTakeaways(input: TakeawayInput): Promise<Takeaway[]> {
  const { userId, sessionId, conversationText, patientHash } = input
  const apiKey = getApiKey()

  try {
    const raw = await deepseekChat(
      [{ role: 'system', content: TAKEAWAY_SYSTEM }, { role: 'user', content: conversationText }],
      apiKey,
      { model: resolveTierModel('fast'), maxTokens: 1024, temperature: 0.3 },
    )
    // 边界审计（#253）: a non-JSON LLM reply must degrade to no takeaways,
    // never a 500. #694: parseLlmJson 带 fence/闲话剥离，围栏回复不再丢。
    const parsed = parseLlmJson<unknown>(raw || '')
    if (!parsed) return []
    const items = Array.isArray(parsed) ? parsed : ((parsed as any).takeaways || [])

    const created: Takeaway[] = []
    for (const item of items) {
      if (!item.text) continue
      const takeaway = await prisma.chatTakeaway.create({
        data: {
          userId,
          scopeKind: patientHash ? 'patient' : 'session',
          scopeRef: patientHash || sessionId,
          sessionId,
          text: item.text,
          tag: item.tag || 'clinical',
          confidence: Math.max(0, Math.min(1, parseFloat(item.confidence) || 0.7)),
          distilledAt: Math.floor(Date.now() / 1000),
        },
      })
      // prisma 返回的 scopeKind 是 string — 收敛到 Takeaway 的字面量联合
      created.push({ ...takeaway, scopeKind: takeaway.scopeKind as Takeaway['scopeKind'] })
    }
    return created
  } catch {
    return []
  }
}

export async function listTakeaways(userId: string, scopeKind?: string, scopeRef?: string): Promise<Takeaway[]> {
  const where: any = { userId }
  if (scopeKind) where.scopeKind = scopeKind
  if (scopeRef) where.scopeRef = scopeRef
  const rows = await prisma.chatTakeaway.findMany({ where, orderBy: { id: 'desc' } })
  return rows.map((t) => ({ ...t, scopeKind: t.scopeKind as Takeaway['scopeKind'] }))
}

export async function acknowledgeTakeaway(id: number, userId: string, action: 'accept' | 'reject'): Promise<boolean> {
  const t = await prisma.chatTakeaway.findFirst({ where: { id, userId } })
  if (!t) return false
  // #701: schema 真实字段是 medicAckedAt/medicRejectedAt(epoch) —
  // 原 medicAction 字段不存在,update 在运行时被 Prisma 拒绝(被上层吞掉),
  // 医生确认/拒绝功能实际从未生效。
  const now = Math.floor(Date.now() / 1000)
  await prisma.chatTakeaway.update({
    where: { id },
    data: action === 'accept' ? { medicAckedAt: now } : { medicRejectedAt: now },
  })
  return true
}
