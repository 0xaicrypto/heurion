import prisma from '../../common/prisma.js'
import { getApiKey, deepseekChat , DEEPSEEK_CHAT_MODEL } from '../../common/llm.js'

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
  tag: string
  confidence: number
  createdAt: string
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
      { model: DEEPSEEK_CHAT_MODEL, maxTokens: 1024, temperature: 0.3 },
    )
    // 边界审计（#253）: a non-JSON LLM reply must degrade to no takeaways,
    // never a 500.
    let parsed: any = null
    try {
      parsed = JSON.parse(raw || '')
    } catch {
      return []
    }
    const items = Array.isArray(parsed) ? parsed : parsed.takeaways || []

    const created: Takeaway[] = []
    for (const item of items) {
      if (!item.text) continue
      const takeaway = await (prisma as any).chatTakeaway.create({
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
      created.push(takeaway)
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
  return (prisma as any).chatTakeaway.findMany({ where, orderBy: { id: 'desc' } })
}

export async function acknowledgeTakeaway(id: number, userId: string, action: 'accept' | 'reject'): Promise<boolean> {
  const t = await (prisma as any).chatTakeaway.findFirst({ where: { id, userId } })
  if (!t) return false
  await (prisma as any).chatTakeaway.update({
    where: { id },
    data: { medicAction: action === 'accept' ? 'accepted' : 'rejected' },
  })
  return true
}
