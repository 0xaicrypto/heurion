import prisma from '../../common/prisma.js'
import crypto from 'crypto'
import { createAiProvider, type ChatOptions } from '../../common/ai/index.js'

const aiProvider = createAiProvider()

export interface ProtocolRule {
  id: string
  studyId: string
  category: 'inclusion' | 'exclusion' | 'safety' | 'schedule'
  rule: string
  detail: string
  status: 'pending' | 'confirmed' | 'rejected' | 'superseded'
  version: number
  extractedAt: string
}

function uid() { return crypto.randomBytes(8).toString('hex') }

interface ExtractedSchedule {
  visit: string
  timing: string
  assessments: string[]
}

interface ExtractedSafety {
  name: string
  rule: string
  grade?: number
}

interface ExtractedProtocol {
  inclusion?: string[]
  exclusion?: string[]
  safety?: ExtractedSafety[]
  schedule?: ExtractedSchedule[]
}

function parseJsonFromText(text: string): ExtractedProtocol | null {
  try {
    const match = text.match(/\{[\s\S]*\}/)
    return JSON.parse(match ? match[0] : text)
  } catch {
    return null
  }
}

/**
 * Extract structured rules from protocol text and persist them as pending
 * StudyProtocolRule records. Existing pending rules for the study are
 * superseded so re-analysis does not create duplicates.
 */
export async function extractRulesFromProtocol(
  studyId: string,
  protocolText: string,
  options: {
    telemetryContext?: ChatOptions['telemetryContext']
    sourceJobId?: string
    extractedFrom?: string
  } = {},
): Promise<ProtocolRule[]> {
  const study = await (prisma as any).researchStudy.findUnique({ where: { id: studyId } })
  if (!study) throw new Error(`Study ${studyId} not found`)

  const prompt = `Extract structured clinical trial rules from this protocol. Return ONLY a JSON object with these keys:

{
  "inclusion": ["rule 1", "rule 2", ...],
  "exclusion": ["rule 1", "rule 2", ...],
  "safety": [{"name": "DLT definition", "rule": "...", "grade": N}, ...],
  "schedule": [{"visit": "Screening", "timing": "Day -28 to -1", "assessments": ["CT", "labs"]}, ...]
}

Protocol text:
${protocolText.slice(0, 8000)}`

  const chatResult = await aiProvider.chat(
    [{ role: 'user', content: prompt }],
    {
      model: 'deepseek-chat',
      maxTokens: 2048,
      telemetryContext: options.telemetryContext,
    },
  )

  const data = parseJsonFromText(chatResult.content)
  if (!data) return []

  const now = new Date().toISOString()

  // Supersede previous pending rules before inserting the new batch.
  await (prisma as any).studyProtocolRule.updateMany({
    where: { studyId, status: 'pending' },
    data: { status: 'superseded', updatedAt: now },
  })

  const currentVersion = await getNextVersion(studyId)
  const records: any[] = []

  const createRecords = (category: ProtocolRule['category'], items: any[], formatter?: (item: any) => { rule: string; detail: string }) => {
    for (const item of items) {
      const formatted = formatter ? formatter(item) : { rule: String(item), detail: '' }
      records.push({
        id: `rule_${uid()}`,
        studyId,
        category,
        rule: formatted.rule,
        detail: formatted.detail,
        status: 'pending',
        version: currentVersion,
        sourceJobId: options.sourceJobId || null,
        extractedFrom: options.extractedFrom || null,
        createdAt: now,
        updatedAt: now,
      })
    }
  }

  createRecords('inclusion', data.inclusion || [])
  createRecords('exclusion', data.exclusion || [])
  createRecords('safety', data.safety || [], (r: ExtractedSafety) => ({ rule: `${r.name}: ${r.rule}`, detail: `grade=${r.grade ?? ''}` }))
  createRecords('schedule', data.schedule || [], (r: ExtractedSchedule) => ({
    rule: `${r.visit} (${r.timing}): ${(r.assessments || []).join(', ')}`,
    detail: JSON.stringify({ timing: r.timing, assessments: r.assessments || [] }),
  }))

  if (records.length === 0) return []

  await (prisma as any).studyProtocolRule.createMany({ data: records })

  return (await (prisma as any).studyProtocolRule.findMany({
    where: { studyId, status: 'pending', version: currentVersion },
  })).map(serializeRule)
}

async function getNextVersion(studyId: string): Promise<number> {
  const agg = await (prisma as any).studyProtocolRule.aggregate({
    where: { studyId },
    _max: { version: true },
  })
  return (agg._max.version || 0) + 1
}

function serializeRule(r: any): ProtocolRule {
  return {
    id: r.id,
    studyId: r.studyId,
    category: r.category,
    rule: r.rule,
    detail: r.detail,
    status: r.status,
    version: r.version,
    extractedAt: r.createdAt,
  }
}

export async function getPendingRules(studyId: string): Promise<ProtocolRule[]> {
  const rules = await (prisma as any).studyProtocolRule.findMany({
    where: { studyId, status: 'pending' },
    orderBy: { createdAt: 'asc' },
  })
  return rules.map(serializeRule)
}

export async function getConfirmedRules(studyId: string): Promise<ProtocolRule[]> {
  const rules = await (prisma as any).studyProtocolRule.findMany({
    where: { studyId, status: 'confirmed' },
    orderBy: { createdAt: 'asc' },
  })
  return rules.map(serializeRule)
}

export async function confirmRule(studyId: string, ruleId: string): Promise<ProtocolRule | null> {
  const rule = await (prisma as any).studyProtocolRule.findFirst({
    where: { id: ruleId, studyId, status: 'pending' },
  })
  if (!rule) return null

  const now = new Date().toISOString()
  const updated = await (prisma as any).studyProtocolRule.update({
    where: { id: ruleId },
    data: { status: 'confirmed', updatedAt: now },
  })

  if (updated.category === 'schedule') {
    await createStudyEventFromRule(updated)
  }

  return serializeRule(updated)
}

async function createStudyEventFromRule(rule: any) {
  const detail = (() => {
    try { return JSON.parse(rule.detail) } catch { return null }
  })()
  if (!detail) return

  const study = await (prisma as any).researchStudy.findUnique({ where: { id: rule.studyId } })
  const studyStart = study ? new Date(study.createdAt) : new Date()
  const days = parseTimingForRule(detail.timing, studyStart)

  const now = new Date().toISOString()
  const dueDate = days !== null
    ? new Date(studyStart.getTime() + days * 24 * 60 * 60 * 1000).toISOString()
    : now

  await (prisma as any).studyEvent.create({
    data: {
      id: `evt_${uid()}`,
      studyId: rule.studyId,
      visit: detail.visit || rule.rule.split('(')[0].trim(),
      timing: detail.timing || '',
      assessments: JSON.stringify(detail.assessments || []),
      status: 'pending',
      sourceRuleId: rule.id,
      createdAt: now,
      updatedAt: now,
    },
  })

  // Keep backward-compatible assessment generation for existing UI.
  await (prisma as any).researchAssessment.create({
    data: {
      id: `asmt_${uid()}`,
      studyId: rule.studyId,
      patientHash: '',
      visit: detail.visit || rule.rule.split('(')[0].trim(),
      title: detail.visit || rule.rule.split('(')[0].trim(),
      dueAt: dueDate,
    },
  })
}

export async function rejectRule(studyId: string, ruleId: string): Promise<boolean> {
  const rule = await (prisma as any).studyProtocolRule.findFirst({
    where: { id: ruleId, studyId, status: 'pending' },
  })
  if (!rule) return false

  await (prisma as any).studyProtocolRule.update({
    where: { id: ruleId },
    data: { status: 'rejected', updatedAt: new Date().toISOString() },
  })
  return true
}

export async function getConfirmationStatus(studyId: string): Promise<{ total: number; confirmed: number; pending: number; rejected: number }> {
  const rules = await (prisma as any).studyProtocolRule.findMany({
    where: { studyId, status: { not: 'superseded' } },
  })
  return {
    total: rules.length,
    confirmed: rules.filter((r: any) => r.status === 'confirmed').length,
    pending: rules.filter((r: any) => r.status === 'pending').length,
    rejected: rules.filter((r: any) => r.status === 'rejected').length,
  }
}

export function parseTimingForRule(timing: string, studyStart: Date): number | null {
  const dayMatch = timing.match(/Day\s+(-?\d+)/)
  if (dayMatch) return parseInt(dayMatch[1])
  const weekMatch = timing.match(/every\s+(\d+)\s*week/i)
  if (weekMatch) return parseInt(weekMatch[1]) * 7
  const monthMatch = timing.match(/every\s+(\d+)\s*month/i)
  if (monthMatch) return parseInt(monthMatch[1]) * 30
  const cycleDay = timing.match(/cycle.*?Day\s+(\d+)/i)
  if (cycleDay) return parseInt(cycleDay[1])
  return null
}
