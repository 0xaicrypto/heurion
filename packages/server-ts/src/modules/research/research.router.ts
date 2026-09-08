import { FastifyInstance, FastifyReply } from 'fastify'
import { authGuard } from '../../common/auth.guard'
import prisma from '../../common/prisma'
import type { MedicalRecordEntry, PatientRecord, ResearchAssessment, ResearchEnrollment, ResearchObservation, ResearchScreening, ResearchStudy } from '@prisma/client'
import { generateResearchSummary } from './research-summary.service.js'
import { ResearchService } from './research.service'
import { createStudySchema, enrollPatientSchema } from './research.dto'
import { extractRulesFromProtocol, getPendingRules, confirmRule, rejectRule, getConfirmationStatus } from './protocol-extractor.js'
import { screenPatient, screenAllEnrolled } from './eligibility-screening.service.js'
import { extractDocumentText } from '../../lib/document-extractor.js'
import { sanitizeFilename, uploadsBaseDir } from '../../lib/upload-path.js'
import { parseDbJson } from '../../common/llm-json.js' // #783
import { makeLogger } from '../../common/logger.js'
import fs from 'fs'
import path from 'path'

const service = new ResearchService()
const log = makeLogger('research')

// #923 类型收口:路由参数显式类型(替代 request.params as any)。
interface StudyParams { studyId: string }
interface StudyPatientParams extends StudyParams { patientHash: string }
interface StudyRuleParams extends StudyParams { ruleId: string }
interface StudyObsParams extends StudyParams { obsId: string }
interface StudyVisitParams extends StudyParams { visitName: string }
interface PatientHashParams { patientHash: string }

/** 患者行最小读取形状(getPatientMap 值 / to* 联表参数)。 */
type PatientInfo = Pick<PatientRecord, 'name' | 'initials' | 'age' | 'sex' | 'chiefComplaint'>

// Transform Prisma camelCase → frontend snake_case
const toStudy = (s: ResearchStudy) => ({
  study_id: s.id, display_name: s.name, short_code: s.shortCode,
  study_type: s.studyType || 'clinical',
  status: 'active', created_at: s.createdAt, updated_at: s.updatedAt,
})
const toRoster = (e: ResearchEnrollment, p?: PatientInfo) => ({
  patient_hash: e.patientHash,
  patient_id: e.patientHash,
  name: p?.name || '',
  initials: p?.initials || '',
  age_value: p?.age || undefined,
  sex: p?.sex || '',
  chief_complaint: p?.chiefComplaint || '',
  status: 'active',
  arm: e.arm,
  enrolled_at: e.enrolledAt,
})
const toScreening = (s: ResearchScreening, p?: PatientInfo) => {
  // #10: criteria_results persisted as JSON in the screening row.
  let criteria: unknown[] = []
  try { criteria = JSON.parse(s.criteriaResults || '[]') } catch { /* legacy rows */ }
  return {
    patient_hash: s.patientHash, patient_id: s.patientHash, name: p?.name || '',
    initials: p?.initials || '', age_value: p?.age || undefined, sex: p?.sex || '',
    status: s.verdict, scanned_at: s.scannedAt, reason: s.reason || '', criteria_results: criteria,
  }
}
const toObservation = (o: ResearchObservation, p?: PatientInfo) => ({ observation_id: o.id, patient_hash: o.patientHash, patient_id: o.patientHash, name: p?.name || '', initials: p?.initials || '', age_value: p?.age || undefined, sex: p?.sex || '', category: o.kind, ae_grade: o.grade, is_dlt: o.dlt === 1, confirmed: o.confirmed === 1, created_at: o.createdAt })
const toAssessment = (a: ResearchAssessment, p?: PatientInfo) => ({ visit_id: a.visit, patient_hash: a.patientHash, patient_id: a.patientHash, name: p?.name || '', initials: p?.initials || '', age_value: p?.age || undefined, sex: p?.sex || '', scheduled_at: a.dueAt, status: a.completedAt ? 'completed' : 'pending', completed_at: a.completedAt })

async function getPatientMap(hashes: string[], userId: string): Promise<Map<string, PatientInfo>> {
  if (hashes.length === 0) return new Map()
  const patients = await prisma.patientRecord.findMany({
    where: { hash: { in: hashes }, userId },
    select: { hash: true, name: true, initials: true, age: true, sex: true, chiefComplaint: true },
  })
  return new Map(patients.map((p) => [p.hash, p]))
}

export async function researchRouter(app: FastifyInstance) {
  app.addHook('preHandler', authGuard)

  // #899: study 归属守卫 — 所有 /studies/:studyId/* 端点必须先过这道闸
  // （roster #253 同款 404 模式），否则跨用户可读/写他人研究数据。
  async function getOwnedStudy(userId: string, studyId: string, reply: FastifyReply) {
    const study = await service.getStudy(userId, studyId)
    if (!study) {
      reply.status(404).send({ error: 'Study not found' })
      return null
    }
    return study
  }

  app.get('/api/v1/research/studies', async (request) => {
    const studies = await service.listStudies(request.user!.userId)
    return studies.map(toStudy)
  })

  app.post('/api/v1/research/studies', async (request, reply) => {
    const body = createStudySchema.parse(request.body)
    const s = await service.createStudy(request.user!.userId, body.display_name, body.short_code, body.study_type === 'basic' ? 'basic' : 'clinical')
    return toStudy(s)
  })

  app.get<{ Params: StudyParams }>('/api/v1/research/studies/:studyId', async (request, reply) => {
    const userId = request.user!.userId
    const { studyId } = request.params
    const s = await getOwnedStudy(userId, studyId, reply)
    if (!s) return
    return { ...toStudy(s), description: '' }
  })

  // #12: AI research-progress summary for citations / internal reporting.
  // Aggregates protocol, enrollment, rule confirmation, safety and
  // assessment status into a journal-ready paragraph.
  app.get<{ Params: StudyParams }>('/api/v1/research/studies/:studyId/summary', async (request, reply) => {
    const userId = request.user!.userId
    const { studyId } = request.params
    const study = await getOwnedStudy(userId, studyId, reply)
    if (!study) return

    const [roster, rules, safety, assessments] = await Promise.all([
      service.getRoster(studyId).catch(() => []),
      getConfirmationStatus(studyId).catch(() => ({ total: 0, confirmed: 0, by_category: {} })),
      service.getSafetyStatus(studyId).catch(() => ({ triggered_rules: [], open_issues: 0 })),
      prisma.researchAssessment.findMany({ where: { studyId }, orderBy: { dueAt: 'asc' } }).catch(() => []),
    ])

    // #923: 兜底形状带 triggered_rules/open_issues、成功形状带 stopRules —
    // 保留原取值口径(成功路径本就取不到 triggered_rules),不改运行时行为。
    const safetyStatus = safety as { stopRules?: unknown[]; triggered_rules?: { length: number } | null; open_issues?: number }

    const enrolled = roster.filter((r) => r.arm).length
    const pendingAssessments = assessments.filter((a) => !a.completedAt).length
    const safetyHits = safetyStatus.triggered_rules?.length ?? 0

    const facts = [
      `研究：${study.name || studyId}（短码 ${study.shortCode || 'N/A'}）`,
      `协议要点：${String(study.protocol || '').slice(0, 400)}`,
      `入组：${enrolled} 例（总数 ${roster.length}）`,
      `规则确认：${rules.confirmed}/${rules.total} 条`,
      `安全状态：触发停止规则 ${safetyHits} 条，未解决问题 ${safetyStatus.open_issues ?? 0} 项`,
      `随访：待完成评估 ${pendingAssessments} 项，总评估 ${assessments.length} 项`,
    ].filter(Boolean)

    const summary = await generateResearchSummary(userId, facts)

    return {
      study_id: studyId,
      study_name: study.name,
      facts,
      summary,
      generated_at: new Date().toISOString(),
    }
  })

  app.get<{ Params: StudyParams }>('/api/v1/research/studies/:studyId/roster', async (request, reply) => {
    const { studyId } = request.params
    const userId = request.user!.userId
    // 边界审计（#253）: the study must exist and belong to the caller —
    // otherwise this leaked other users' rosters and returned 200 for
    // nonexistent studies. #899: 统一走 getOwnedStudy 守卫。
    const study = await getOwnedStudy(userId, studyId, reply)
    if (!study) return
    const enrollments = await service.getRoster(studyId)
    const patientMap = await getPatientMap(enrollments.map((e) => e.patientHash), userId)
    return enrollments.map((e) => toRoster(e, patientMap.get(e.patientHash)))
  })

  app.get<{ Params: StudyParams }>('/api/v1/research/studies/:studyId/enrollments', async (request, reply) => {
    const { studyId } = request.params
    const userId = request.user!.userId
    const study = await getOwnedStudy(userId, studyId, reply)
    if (!study) return
    const enrollments = await service.getRoster(studyId)
    const patientMap = await getPatientMap(enrollments.map((e) => e.patientHash), userId)
    return enrollments.map((e) => toRoster(e, patientMap.get(e.patientHash)))
  })

  app.post<{ Params: StudyParams }>('/api/v1/research/studies/:studyId/enrollments', async (request, reply) => {
    const userId = request.user!.userId
    const { studyId } = request.params
    if (!(await getOwnedStudy(userId, studyId, reply))) return
    const body = enrollPatientSchema.parse(request.body)
    const e = await service.enroll(studyId, body.patient_hash, body.arm)
    const patientMap = await getPatientMap([e.patientHash], userId)
    return toRoster(e, patientMap.get(e.patientHash))
  })

  app.delete<{ Params: StudyPatientParams }>('/api/v1/research/studies/:studyId/enrollments/:patientHash', async (request, reply) => {
    const { studyId, patientHash } = request.params
    if (!(await getOwnedStudy(request.user!.userId, studyId, reply))) return
    return { ok: await service.unenroll(studyId, patientHash) }
  })

  // #724: 患者侧查看其已入组的研究 — 患者页显示入组状态与直达链接。
  app.get<{ Params: PatientHashParams }>('/api/v1/research/patients/:patientHash/enrollments', async (request) => {
    const { patientHash } = request.params
    const userId = request.user!.userId
    const studies = await prisma.researchStudy.findMany({ where: { userId } })
    const out: Array<{ study_id: string; study_name: string; status: string; arm: string | null; enrolled_at: string }> = []
    for (const s of studies) {
      const roster = await service.getRoster(s.id)
      const row = roster.find((r) => r.patientHash === patientHash)
      if (row) {
        out.push({
          study_id: s.id,
          study_name: s.name,
          // #724: roster 行恒为 active(已过滤 unenrolledAt),arm 来自入组行。
          status: 'active',
          arm: row.arm ?? null,
          enrolled_at: row.enrolledAt,
        })
      }
    }
    return { enrollments: out }
  })

  app.get<{ Params: StudyParams }>('/api/v1/research/studies/:studyId/eligibility', async (request, reply) => {
    const { studyId } = request.params
    const userId = request.user!.userId
    if (!(await getOwnedStudy(userId, studyId, reply))) return
    const screenings = await service.getEligibility(studyId)
    const patientMap = await getPatientMap(screenings.map((s) => s.patientHash), userId)
    return { screenings: screenings.map((s) => toScreening(s, patientMap.get(s.patientHash))) }
  })

  // #10: study progress overview — enrollment, rule confirmation, visits,
  // safety and screening stats in one payload.
  app.get<{ Params: StudyParams }>('/api/v1/research/studies/:studyId/progress', async (request, reply) => {
    const userId = request.user!.userId
    const { studyId } = request.params
    const study = await getOwnedStudy(userId, studyId, reply)
    if (!study) return

    const [roster, rules, assessments, observations, screenings] = await Promise.all([
      service.getRoster(studyId).catch(() => []),
      getConfirmationStatus(studyId).catch(() => ({ total: 0, confirmed: 0, pending: 0, rejected: 0 })),
      prisma.researchAssessment.findMany({ where: { studyId }, orderBy: { dueAt: 'asc' } }).catch(() => []),
      prisma.researchObservation.findMany({ where: { studyId } }).catch(() => []),
      prisma.researchScreening.findMany({ where: { studyId } }).catch(() => []),
    ])

    const arms = new Map<string, number>()
    for (const e of roster) {
      const arm = e.arm || 'default'
      arms.set(arm, (arms.get(arm) || 0) + 1)
    }
    const visits = new Map<string, { total: number; completed: number }>()
    for (const a of assessments) {
      const key = a.visit || 'visit'
      const cur = visits.get(key) || { total: 0, completed: 0 }
      cur.total++
      if (a.completedAt) cur.completed++
      visits.set(key, cur)
    }

    return {
      study_id: studyId,
      study_name: study.name,
      enrollment: {
        total: roster.length,
        by_arm: Object.fromEntries(arms),
      },
      rules: {
        total: rules.total,
        confirmed: rules.confirmed,
        pending: rules.pending,
        rejected: rules.rejected,
      },
      visits: {
        total: assessments.length,
        completed: assessments.filter((a) => a.completedAt).length,
        by_visit: Object.fromEntries(visits),
      },
      safety: {
        dlt_count: observations.filter((o) => o.dlt === 1 && o.confirmed === 1).length,
        unconfirmed: observations.filter((o) => o.confirmed !== 1).length,
      },
      screenings: {
        eligible: screenings.filter((s) => s.verdict === 'eligible').length,
        ineligible: screenings.filter((s) => s.verdict === 'ineligible').length,
        pending: screenings.filter((s) => s.verdict !== 'eligible' && s.verdict !== 'ineligible').length,
      },
      generated_at: new Date().toISOString(),
    }
  })

  app.post<{ Params: StudyParams }>('/api/v1/research/studies/:studyId/eligibility/rescan', async (request, reply) => {
    const { studyId } = request.params
    if (!(await getOwnedStudy(request.user!.userId, studyId, reply))) return
    return service.rescanEligibility(studyId)
  })

  app.get<{ Params: StudyParams }>('/api/v1/research/studies/:studyId/observations', async (request, reply) => {
    const { studyId } = request.params
    const userId = request.user!.userId
    if (!(await getOwnedStudy(userId, studyId, reply))) return
    const observations = await service.getObservations(studyId)
    const patientMap = await getPatientMap(observations.map((o) => o.patientHash), userId)
    return observations.map((o) => toObservation(o, patientMap.get(o.patientHash)))
  })

  app.post<{ Params: StudyObsParams; Body: { confirmed?: boolean; ae_grade?: number; grade?: number; is_dlt?: boolean; dlt?: boolean; note?: string } }>('/api/v1/research/studies/:studyId/observations/:obsId/confirm', async (request, reply) => {
    const { studyId, obsId } = request.params
    const body = request.body
    const userId = request.user!.userId
    if (!(await getOwnedStudy(userId, studyId, reply))) return
    const o = await service.confirmObservation(studyId, obsId, {
      confirmed: body.confirmed ?? true,
      grade: body.ae_grade ?? body.grade,
      dlt: body.is_dlt ?? body.dlt,
      note: body.note,
    })
    if (!o) return reply.status(404).send({ error: 'Observation not found' })
    const patientMap = await getPatientMap([o.patientHash], userId)
    return toObservation(o, patientMap.get(o.patientHash))
  })

  app.get<{ Params: StudyParams }>('/api/v1/research/studies/:studyId/safety/stop-rule-status', async (request, reply) => {
    const { studyId } = request.params
    if (!(await getOwnedStudy(request.user!.userId, studyId, reply))) return
    const status = await service.getSafetyStatus(studyId)
    return {
      triggered_rules: status.stopRules
        .filter(r => r.triggered)
        .map(r => ({ rule: r.name, description: r.detail || '' })),
    }
  })

  app.get<{ Params: StudyParams }>('/api/v1/research/studies/:studyId/assessments', async (request, reply) => {
    const { studyId } = request.params
    const userId = request.user!.userId
    if (!(await getOwnedStudy(userId, studyId, reply))) return
    const assessments = await service.getAssessments(studyId)
    const patientMap = await getPatientMap(assessments.map((a) => a.patientHash), userId)

    // #11: attach each patient's recent check data (labs/imaging/notes) to
    // their assessments so the schedule view shows what was measured at
    // the visit point.
    const hashes = Array.from(new Set(assessments.map((a) => a.patientHash)))
    const entries = hashes.length > 0
      ? await prisma.medicalRecordEntry.findMany({
          where: { userId, patientHash: { in: hashes } },
          orderBy: { date: 'desc' },
          take: 200,
        }).catch(() => [])
      : []
    const byPatient = new Map<string, MedicalRecordEntry[]>()
    for (const e of entries) {
      const list = byPatient.get(e.patientHash)
      if (list) { if (list.length < 5) list.push(e) }
      else byPatient.set(e.patientHash, [e])
    }

    return assessments.map((a) => ({
      ...toAssessment(a, patientMap.get(a.patientHash)),
      recent_entries: (byPatient.get(a.patientHash) || []).map((e) => ({
        type: e.type,
        title: e.title,
        date: e.date,
        content: String(e.content || '').slice(0, 200),
        status: e.status,
      })),
    }))
  })

  app.post<{ Params: StudyVisitParams }>('/api/v1/research/studies/:studyId/assessments/:visitName/complete', async (request, reply) => {
    const { studyId, visitName } = request.params
    if (!(await getOwnedStudy(request.user!.userId, studyId, reply))) return
    return { ok: await service.completeAssessment(studyId, visitName) }
  })

  // Step 3 workflow: Import protocol text (from file upload or paste)
  app.post<{ Params: StudyParams; Body: { text?: string } }>('/api/v1/research/studies/:studyId/import-protocol', async (request, reply) => {
    const { studyId } = request.params
    const { text } = request.body
    const userId = request.user!.userId
    if (!(await getOwnedStudy(userId, studyId, reply))) return
    if (!text) return reply.status(400).send({ error: 'text required' })
    // Trigger AI extraction in background
    // #928: `.catch(() => {})` 此前完全吞错 — 后台提取失败用户无感知且
    // 无从排查(协议导入后 rules 恒空)。带 studyId + 错误摘要留痕。
    extractRulesFromProtocol(studyId, text, {
      telemetryContext: { userId, workspaceId: userId, action: 'research.extract_protocol' },
    }).catch((err: Error) => {
      log.warn('background protocol extraction failed', { studyId, reason: (err?.message || String(err)).slice(0, 200) })
    })
    return service.importProtocol(studyId, text)
  })

  // Extraction: AI extracts rules from protocol
  app.post<{ Params: StudyParams; Body: { text?: string } }>('/api/v1/research/studies/:studyId/extract-rules', async (request, reply) => {
    const { studyId } = request.params
    const { text } = request.body
    const userId = request.user!.userId
    if (!(await getOwnedStudy(userId, studyId, reply))) return
    if (!text) return reply.status(400).send({ error: 'text required' })
    const rules = await extractRulesFromProtocol(studyId, text, {
      telemetryContext: { userId, workspaceId: userId, action: 'research.extract_protocol' },
    })
    return { study_id: studyId, rules, status: await getConfirmationStatus(studyId) }
  })

  // Upload a protocol document (.txt/.md/.csv/.pdf/.docx): server-side text
  // extraction + rule extraction in one step.
  app.post<{ Params: StudyParams }>('/api/v1/research/studies/:studyId/protocol-file', async (request, reply) => {
    const { studyId } = request.params
    const userId = request.user!.userId
    if (!(await getOwnedStudy(userId, studyId, reply))) return
    const data = await request.file()
    if (!data) return reply.status(400).send({ error: 'No file uploaded' })

    const buffer = await data.toBuffer()
    if (buffer.length === 0) return reply.status(400).send({ error: 'Empty file' })

    // #899: multipart filename 不可信 — 清洗后再落盘/拼接,防路径穿越
    // （../../x.txt 原样 path.join 会写出 uploads 目录）。
    const filename = sanitizeFilename(data.filename)
    const SUPPORTED_EXT = /\.(txt|md|csv|pdf|docx)$/i
    if (!SUPPORTED_EXT.test(filename)) {
      return reply.status(400).send({ error: 'Unsupported file type (supported: .txt/.md/.csv/.pdf/.docx)' })
    }

    const dir = uploadsBaseDir(userId)
    fs.mkdirSync(dir, { recursive: true })
    const fileId = `${Date.now()}_${filename}`
    fs.writeFileSync(path.join(dir, fileId), buffer)

    let text = ''
    try {
      text = await extractDocumentText(buffer, filename, data.mimetype, { maxChars: 50000 })
    } catch (err: any) {
      return reply.status(400).send({ error: `Text extraction failed: ${err.message}` })
    }
    if (!text.trim()) {
      return reply.status(400).send({ error: 'Could not extract text from this file (supported: .txt/.md/.csv/.pdf/.docx)' })
    }

    const rules = await extractRulesFromProtocol(studyId, text, {
      telemetryContext: { userId, workspaceId: userId, action: 'research.extract_protocol' },
      sourceJobId: fileId,
      extractedFrom: filename,
    })

    return {
      study_id: studyId,
      file_id: fileId,
      file_name: filename,
      text_length: text.length,
      rules,
      status: await getConfirmationStatus(studyId),
    }
  })

  // List pending extracted rules
  app.get<{ Params: StudyParams }>('/api/v1/research/studies/:studyId/protocol-rules', async (request, reply) => {
    const { studyId } = request.params
    if (!(await getOwnedStudy(request.user!.userId, studyId, reply))) return
    return {
      rules: await getPendingRules(studyId),
      status: await getConfirmationStatus(studyId),
    }
  })

  // Doctor confirms a rule — schedule rules also generate StudyEvent + assessment
  app.post<{ Params: StudyRuleParams }>('/api/v1/research/studies/:studyId/protocol-rules/:ruleId/confirm', async (request, reply) => {
    const { studyId, ruleId } = request.params
    if (!(await getOwnedStudy(request.user!.userId, studyId, reply))) return
    const rule = await confirmRule(studyId, ruleId)
    if (!rule) return reply.status(404).send({ error: 'Rule not found' })
    return { rule, status: await getConfirmationStatus(studyId) }
  })

  // Doctor rejects a rule
  app.delete<{ Params: StudyRuleParams }>('/api/v1/research/studies/:studyId/protocol-rules/:ruleId', async (request, reply) => {
    const { studyId, ruleId } = request.params
    if (!(await getOwnedStudy(request.user!.userId, studyId, reply))) return
    const ok = await rejectRule(studyId, ruleId)
    return { rejected: ok, study_id: studyId, status: await getConfirmationStatus(studyId) }
  })

  // Eligibility screening
  app.post<{ Params: StudyPatientParams }>('/api/v1/research/studies/:studyId/screen/:patientHash', async (request, reply) => {
    const { studyId, patientHash } = request.params
    const userId = request.user!.userId
    if (!(await getOwnedStudy(userId, studyId, reply))) return
    const result = await screenPatient(studyId, patientHash, userId)
    return result
  })

  app.post<{ Params: StudyParams }>('/api/v1/research/studies/:studyId/screen-all', async (request, reply) => {
    const { studyId } = request.params
    const userId = request.user!.userId
    if (!(await getOwnedStudy(userId, studyId, reply))) return
    const results = await screenAllEnrolled(studyId, userId)
    return { screenings: results }
  })

  // #759: research suggestion touchpoints — recent auto/manual screenings
  // (eligible or pending_review) for patients NOT yet enrolled. Powers the
  // patient-page "候选研究" card and the dashboard aggregation.
  // #783: both endpoints are user-scoped — screenings join the requester's
  // studies only (the screening table has no userId column), the patient must
  // belong to the requester, and rows are parsed/batched defensively.
  app.get<{ Params: PatientHashParams }>('/api/v1/patients/:patientHash/research-suggestions', async (request, reply) => {
    const { patientHash } = request.params
    const userId = request.user!.userId
    const patient = await prisma.patientRecord.findFirst({ where: { hash: patientHash, userId } })
    if (!patient) return reply.status(404).send({ error: 'Patient not found' })

    const myStudies = await prisma.researchStudy.findMany({
      where: { userId }, select: { id: true },
    })
    const myStudyIds = myStudies.map((s) => s.id)
    if (myStudyIds.length === 0) return { suggestions: [] }

    const rows = await prisma.researchScreening.findMany({
      where: { patientHash, studyId: { in: myStudyIds }, verdict: { in: ['eligible', 'pending_review'] } },
      orderBy: { scannedAt: 'desc' },
      take: 20,
    })
    // Batch: enrolled studies for this patient + study titles.
    const enrolledRows = rows.length > 0 ? await prisma.researchEnrollment.findMany({
      where: { patientHash, studyId: { in: rows.map((r) => r.studyId) }, unenrolledAt: null },
      select: { studyId: true },
    }) : []
    const enrolledStudyIds = new Set(enrolledRows.map((e) => e.studyId))
    const studyRows = rows.length > 0 ? await prisma.researchStudy.findMany({
      // #783: ResearchStudy has no `title` column — the pre-fix code selected
      // `title` and 500'd on every patient with ≥1 screening row.
      where: { id: { in: rows.map((r) => r.studyId) } }, select: { id: true, name: true },
    }) : []
    const titleByStudy = new Map<string, string>(studyRows.map((s) => [s.id, s.name] as [string, string]))

    const out: Array<{ studyId: string; title: string; matchRatio: string; verdict: string; reason: string; screenedAt: string }> = []
    for (const row of rows) {
      // Skip studies the patient already joined.
      if (enrolledStudyIds.has(row.studyId)) continue
      const rules = parseDbJson<Array<{ passed?: boolean }>>(row.criteriaResults) ?? []
      const total = rules.length
      const passed = rules.filter((r) => r.passed).length
      out.push({
        studyId: row.studyId,
        title: titleByStudy.get(row.studyId) || '未命名研究',
        matchRatio: total > 0 ? `${passed}/${total}` : '—',
        verdict: row.verdict,
        reason: String(row.reason || '').replace(/\s*rev:\d+\s*$/, ''),
        screenedAt: row.scannedAt,
      })
    }
    // Dedupe by study (keep latest).
    const seen = new Set<string>()
    return { suggestions: out.filter((s) => !seen.has(s.studyId) && seen.add(s.studyId)) }
  })

  app.get('/api/v1/research/suggestions/recent', async (request) => {
    // Dashboard aggregate: most recent screening per (study,patient), not yet
    // enrolled, positive-leaning verdicts only.
    // #783: scoped to the requester's studies (was:全表捞 60 条跨租户泄露).
    const userId = request.user!.userId
    const myStudies = await prisma.researchStudy.findMany({
      where: { userId }, select: { id: true },
    })
    const myStudyIds = myStudies.map((s) => s.id)
    if (myStudyIds.length === 0) return { suggestions: [] }

    const rows = await prisma.researchScreening.findMany({
      where: { studyId: { in: myStudyIds }, verdict: { in: ['eligible', 'pending_review'] } },
      orderBy: { scannedAt: 'desc' },
      take: 60,
    })
    // Batch: enrollments + patient initials for all candidate rows.
    const studyIdSet = [...new Set(rows.map((r) => r.studyId))]
    const patientHashes = [...new Set(rows.map((r) => r.patientHash))]
    const enrolledRows = studyIdSet.length > 0 && patientHashes.length > 0 ? await prisma.researchEnrollment.findMany({
      where: { studyId: { in: studyIdSet }, patientHash: { in: patientHashes }, unenrolledAt: null },
      select: { studyId: true, patientHash: true },
    }) : []
    const enrolledKeys = new Set(enrolledRows.map((e) => `${e.studyId}:${e.patientHash}`))
    const patientRows = patientHashes.length > 0 ? await prisma.patientRecord.findMany({
      where: { hash: { in: patientHashes }, userId }, select: { hash: true, initials: true },
    }) : []
    const initialsByHash = new Map<string, string>(patientRows.map((p) => [p.hash, p.initials] as [string, string]))

    const seen = new Set<string>()
    const out: Array<Record<string, string>> = []
    for (const row of rows) {
      const key = `${row.studyId}:${row.patientHash}`
      if (seen.has(key)) continue
      seen.add(key)
      if (enrolledKeys.has(key)) continue
      out.push({
        studyId: row.studyId,
        patientHash: row.patientHash,
        patientInitials: initialsByHash.get(row.patientHash) || '',
        verdict: row.verdict,
        reason: String(row.reason || '').replace(/\s*rev:\d+\s*$/, ''),
        screenedAt: row.scannedAt,
      })
      if (out.length >= 5) break
    }
    return { suggestions: out }
  })
}
