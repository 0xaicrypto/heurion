import prisma from '../../common/prisma.js'
import { getApiKey, deepseekChat } from '../../common/llm.js'

/**
 * #298: skill capture — turn a finished conversation into a reusable skill
 * with zero editing: AI drafts it, the doctor refines in natural language,
 * then confirms.
 */

export interface SkillDraft {
  name: string
  description: string
  steps: string[]
  prompt: string
}

const CAPTURE_SYSTEM = `你是临床工作流技能整理器。把用户的对话整理成一个可复用的技能草稿。
输出 STRICT JSON：{"name": "技能名（简短）", "description": "一句话说明用途", "steps": ["步骤1", "步骤2", ...], "prompt": "下次执行该任务时可直接使用的完整提示词模板"}
只提取对话中清晰展示的流程；无流程则输出 {"name":"","description":"","steps":[],"prompt":""}。`

function parseDraft(raw: string | null | undefined): SkillDraft {
  const fallback: SkillDraft = { name: '', description: '', steps: [], prompt: '' }
  if (!raw) return fallback
  try {
    const parsed = JSON.parse(raw)
    return {
      name: String(parsed.name || '').slice(0, 120),
      description: String(parsed.description || '').slice(0, 300),
      steps: Array.isArray(parsed.steps) ? parsed.steps.map((s: unknown) => String(s).slice(0, 500)) : [],
      prompt: String(parsed.prompt || '').slice(0, 4000),
    }
  } catch {
    return fallback
  }
}

async function draftFromConversation(userId: string, conversation: string, extraInstruction?: string): Promise<SkillDraft> {
  const instruction = extraInstruction ? `\n\n医生的微调要求：${extraInstruction}` : ''
  const raw = await deepseekChat(
    [{ role: 'system', content: CAPTURE_SYSTEM }, { role: 'user', content: conversation.slice(0, 8000) + instruction }],
    getApiKey(),
    { model: 'deepseek-chat', maxTokens: 1500 },
  )
  return parseDraft(raw)
}

/** Generate a draft skill from a conversation (conversation-only, no row yet). */
export async function captureSkillDraft(userId: string, conversation: string): Promise<SkillDraft> {
  return draftFromConversation(userId, conversation)
}

/** Persist a draft so the doctor can refine it in follow-up calls. */
export async function saveDraft(userId: string, draft: SkillDraft, sourceSession?: string): Promise<string> {
  const now = new Date().toISOString()
  const row = await (prisma as any).capturedSkill.create({
    data: {
      userId,
      name: draft.name || '未命名技能',
      description: draft.description,
      steps: JSON.stringify(draft.steps),
      prompt: draft.prompt,
      sourceSession: sourceSession || null,
      status: 'draft',
      createdAt: now,
      updatedAt: now,
    },
  })
  return row.id
}

/** Natural-language refinement: current draft + instruction → new draft. */
export async function refineSkillDraft(
  userId: string,
  draftId: string,
  instruction: string,
): Promise<SkillDraft> {
  const row = await (prisma as any).capturedSkill.findFirst({ where: { id: draftId, userId } })
  if (!row) throw new Error('Draft not found')
  const current: SkillDraft = {
    name: row.name,
    description: row.description,
    steps: JSON.parse(row.steps || '[]'),
    prompt: row.prompt,
  }
  const context = `当前技能草稿：
名称：${current.name}
说明：${current.description}
步骤：${current.steps.map((s: string, i: number) => `${i + 1}. ${s}`).join('\n')}
提示词模板：${current.prompt}`
  const refined = await draftFromConversation(userId, context, instruction)
  const now = new Date().toISOString()
  await (prisma as any).capturedSkill.update({
    where: { id: draftId },
    data: {
      name: refined.name || current.name,
      description: refined.description || current.description,
      steps: JSON.stringify(refined.steps.length > 0 ? refined.steps : current.steps),
      prompt: refined.prompt || current.prompt,
      updatedAt: now,
    },
  })
  return refined
}

/** Confirm a draft — the skill becomes usable (load_skill sees it). */
export async function confirmSkillDraft(userId: string, draftId: string): Promise<boolean> {
  const updated = await (prisma as any).capturedSkill.updateMany({
    where: { id: draftId, userId, status: 'draft' },
    data: { status: 'confirmed', updatedAt: new Date().toISOString() },
  })
  return updated.count > 0
}

export async function listCapturedSkills(userId: string, status?: string): Promise<any[]> {
  const where: any = { userId }
  if (status) where.status = status
  const rows = await (prisma as any).capturedSkill.findMany({ where, orderBy: { updatedAt: 'desc' } })
  return rows.map((r: any) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    steps: JSON.parse(r.steps || '[]'),
    prompt: r.prompt,
    status: r.status,
    source_session: r.sourceSession,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  }))
}

/** Heuristic: does this reply look like a reusable procedure? */
export function looksLikeProcedure(reply: string): boolean {
  if (!reply) return false
  return /(第[一二三四五六七八九十\d]+步|首先|然后|接下来|最后|流程|步骤)/.test(reply) && reply.length > 120
}
