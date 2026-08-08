import prisma from '../../common/prisma.js'
import type { ProtocolRule } from './protocol-extractor.js'
import { getApiKey, deepseekChat , DEEPSEEK_CHAT_MODEL } from '../../common/llm.js'

export interface ScreeningResult {
  patientHash: string
  studyId: string
  verdict: 'eligible' | 'ineligible' | 'pending_review'
  reason?: string
  ruleResults: Array<{
    ruleId: string
    rule: string
    category: string
    passed: boolean
    detail?: string
  }>
}

const SCREENING_SYSTEM = `You are a clinical trial eligibility screener. Given a patient's clinical data and a set of protocol rules, determine if the patient meets the criteria.

Return JSON: {"verdict": "eligible|ineligible|pending_review", "reason": "summary explanation", "ruleResults": [{"ruleId": "...", "rule": "...", "category": "inclusion|exclusion|safety", "passed": true/false, "detail": "explanation"}]}

Be conservative — when uncertain, mark as pending_review.`

function buildPatientProfile(patient: any, facts: any[], medicalRecords: any[]): string {
  const parts: string[] = []
  if (patient) {
    parts.push(`Patient: ${patient.name || 'Unknown'}, Age: ${patient.age || 'N/A'}, Sex: ${patient.sex || 'N/A'}`)
    if (patient.chiefComplaint) parts.push(`Chief Complaint: ${patient.chiefComplaint}`)
  }
  if (facts.length > 0) {
    parts.push('Clinical Facts:')
    facts.forEach((f: any) => {
      parts.push(`- [${f.category}] ${f.content} (importance: ${f.importance ?? 3})`)
    })
  }
  if (medicalRecords.length > 0) {
    parts.push('Medical Records:')
    medicalRecords.forEach((r: any) => {
      const sections = typeof r.sections === 'string' ? JSON.parse(r.sections) : r.sections
      if (sections) parts.push(`- ${r.title}: ${JSON.stringify(sections).slice(0, 500)}`)
    })
  }
  return parts.join('\n')
}

export async function screenPatient(
  studyId: string,
  patientHash: string,
  userId: string,
): Promise<ScreeningResult> {
  const study = await (prisma as any).researchStudy.findUnique({ where: { id: studyId } })
  if (!study) throw new Error('Study not found')

  const rules = await (prisma as any).studyProtocolRule.findMany({
    where: { studyId, status: 'confirmed' },
  })
  if (rules.length === 0) {
    return {
      patientHash,
      studyId,
      verdict: 'pending_review',
      reason: 'No confirmed protocol rules to screen against',
      ruleResults: [],
    }
  }

  const patient = await (prisma as any).patientRecord.findUnique({ where: { hash: patientHash, userId } })

  const facts = await (prisma as any).memoryGraphNode.findMany({
    where: { ownerId: userId, patientHash, type: 'fact' },
    select: { content: true, category: true, importance: true },
    take: 50,
  }) || []

  const medicalRecords = await (prisma as any).medicalRecord.findMany({
    where: { patientHash, userId },
    select: { title: true, sections: true },
    take: 20,
  }) || []

  const profileText = buildPatientProfile(patient, facts, medicalRecords)
  const rulesText = rules.map((r: any) =>
    `[${r.category}] ${r.rule} ${r.detail ? `(${r.detail})` : ''}`,
  ).join('\n')

  const prompt = `Protocol Rules for "${study.name}":\n${rulesText}\n\nPatient Profile:\n${profileText}`

  const apiKey = getApiKey()
  try {
    const raw = await deepseekChat(
      [{ role: 'system', content: SCREENING_SYSTEM }, { role: 'user', content: prompt }],
      apiKey,
      { model: DEEPSEEK_CHAT_MODEL, maxTokens: 2048, temperature: 0.2 },
    )
    const parsed = JSON.parse(raw)
    const ruleResults: ScreeningResult['ruleResults'] = (parsed.ruleResults || rules.map((r: any) => ({
      ruleId: r.id,
      rule: r.rule,
      category: r.category,
      passed: false,
      detail: 'Not evaluated',
    })))

    const result: ScreeningResult = {
      patientHash,
      studyId,
      verdict: parsed.verdict || 'pending_review',
      reason: parsed.reason,
      ruleResults,
    }

    await (prisma as any).researchScreening.create({
      data: {
        id: `scr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        studyId,
        patientHash,
        verdict: result.verdict,
        reason: result.reason?.slice(0, 500),
        scannedAt: new Date().toISOString(),
      },
    })

    return result
  } catch (err) {
    return {
      patientHash,
      studyId,
      verdict: 'pending_review',
      reason: `Screening error: ${(err as Error).message}`,
      ruleResults: [],
    }
  }
}

export async function screenAllEnrolled(
  studyId: string,
  userId: string,
): Promise<ScreeningResult[]> {
  const enrollments = await (prisma as any).researchEnrollment.findMany({
    where: { studyId, unenrolledAt: null },
  })

  const results: ScreeningResult[] = []
  for (const e of enrollments) {
    const result = await screenPatient(studyId, e.patientHash, userId)
    results.push(result)
  }
  return results
}
