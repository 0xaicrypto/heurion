import { resolveTierModel } from '../../common/llm-gateway.js'
import prisma from '../../common/prisma.js'
import { getApiKey, deepseekChat} from '../../common/llm.js'
import { getUserContext } from '../shared/user-context.js'
import { parseLlmJson } from '../../common/llm-json.js'
import { makeLogger } from '../../common/logger.js'

const log = makeLogger('research.screening')

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

export function buildPatientProfile(patient: any, facts: any[], medicalRecords: any[]): string {
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
    // #911: sections 列逐条安全解析 — 单行坏 JSON 跳过并计数,不再中断全筛查。
    let badSections = 0
    medicalRecords.forEach((r: any) => {
      try {
        const sections = typeof r.sections === 'string' ? JSON.parse(r.sections) : r.sections
        if (sections) parts.push(`- ${r.title}: ${JSON.stringify(sections).slice(0, 500)}`)
      } catch {
        badSections++
      }
    })
    if (badSections > 0) {
      log.warn(`buildPatientProfile: ${badSections}/${medicalRecords.length} 条病历 sections 列损坏,已跳过`)
    }
  }
  return parts.join('\n')
}

export async function screenPatient(
  studyId: string,
  patientHash: string,
  userId: string,
): Promise<ScreeningResult> {
  const study = await prisma.researchStudy.findUnique({ where: { id: studyId } })
  if (!study) throw new Error('Study not found')

  const rules = await prisma.studyProtocolRule.findMany({
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

  const patient = await prisma.patientRecord.findUnique({ where: { hash: patientHash, userId } })

  // #701: memoryGraphNode 模型已在双存储收敛中移除 — 原查询运行时抛错
  // (catch 吞掉,患者档案退化为空),改为经 FactsStore 读取同一事实源。
  const userCtx = await getUserContext(userId)
  const facts = userCtx.facts
    .all()
    .filter((f) => f.patientHash === patientHash && f.category === 'fact')
    .slice(0, 50)
    .map((f) => ({ content: f.content, category: f.category, importance: f.importance }))

  const medicalRecords = await prisma.medicalRecord.findMany({
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
      { model: resolveTierModel('fast'), maxTokens: 2048, temperature: 0.2 },
    )
    // #694: fence 容错 — 模型带围栏/闲话时 screening 不再整体炸掉，
    // 解析失败按「全部规则未评估」降级，与外层 catch 语义一致。
    const parsed = parseLlmJson<{
      verdict?: ScreeningResult['verdict']
      reason?: string
      ruleResults?: ScreeningResult['ruleResults']
    }>(raw)
    const ruleResults: ScreeningResult['ruleResults'] = parsed?.ruleResults || rules.map((r: any) => ({
      ruleId: r.id,
      rule: r.rule,
      category: r.category,
      passed: false,
      detail: 'Not evaluated',
    }))

    const result: ScreeningResult = {
      patientHash,
      studyId,
      verdict: parsed?.verdict || 'pending_review',
      reason: parsed?.reason,
      ruleResults,
    }

    await prisma.researchScreening.create({
      data: {
        id: `scr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        studyId,
        patientHash,
        verdict: result.verdict,
        reason: result.reason?.slice(0, 500),
        // #10: persist the per-rule breakdown for the progress view.
        criteriaResults: JSON.stringify(result.ruleResults || []),
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
  const enrollments = await prisma.researchEnrollment.findMany({
    where: { studyId, unenrolledAt: null },
  })

  const results: ScreeningResult[] = []
  for (const e of enrollments) {
    const result = await screenPatient(studyId, e.patientHash, userId)
    results.push(result)
  }
  return results
}
