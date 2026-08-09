import { FastifyInstance } from 'fastify'
import { authGuard } from '../../common/auth.guard'
import prisma from '../../common/prisma'
import { ResearchService } from './research.service'
import { createStudySchema, enrollPatientSchema } from './research.dto'
import { extractRulesFromProtocol, getPendingRules, confirmRule, rejectRule, getConfirmationStatus } from './protocol-extractor.js'
import { screenPatient, screenAllEnrolled } from './eligibility-screening.service.js'
import { extractDocumentText } from '../../lib/document-extractor.js'
import fs from 'fs'
import path from 'path'

const service = new ResearchService()

// Transform Prisma camelCase → frontend snake_case
const toStudy = (s: any) => ({
  study_id: s.id, display_name: s.name, short_code: s.shortCode,
  study_type: s.studyType || 'clinical',
  status: 'active', created_at: s.createdAt, updated_at: s.updatedAt,
})
const toRoster = (e: any, p?: any) => ({
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
const toScreening = (s: any, p?: any) => ({ patient_hash: s.patientHash, patient_id: s.patientHash, name: p?.name || '', initials: p?.initials || '', age_value: p?.age || undefined, sex: p?.sex || '', status: s.verdict, scanned_at: s.scannedAt, criteria_results: [] })
const toObservation = (o: any, p?: any) => ({ observation_id: o.id, patient_hash: o.patientHash, patient_id: o.patientHash, name: p?.name || '', initials: p?.initials || '', age_value: p?.age || undefined, sex: p?.sex || '', category: o.kind, ae_grade: o.grade, is_dlt: o.dlt === 1, confirmed: o.confirmed === 1, created_at: o.createdAt })
const toAssessment = (a: any, p?: any) => ({ visit_id: a.visit, patient_hash: a.patientHash, patient_id: a.patientHash, name: p?.name || '', initials: p?.initials || '', age_value: p?.age || undefined, sex: p?.sex || '', scheduled_at: a.dueAt, status: a.completedAt ? 'completed' : 'pending', completed_at: a.completedAt })

async function getPatientMap(hashes: string[], userId: string): Promise<Map<string, any>> {
  if (hashes.length === 0) return new Map()
  const patients = await (prisma as any).patientRecord.findMany({
    where: { hash: { in: hashes }, userId },
    select: { hash: true, name: true, initials: true, age: true, sex: true, chiefComplaint: true },
  })
  return new Map(patients.map((p: any) => [p.hash, p]))
}

export async function researchRouter(app: FastifyInstance) {
  app.addHook('preHandler', authGuard)

  app.get('/api/v1/research/studies', async (request) => {
    const studies = await service.listStudies(request.user!.userId)
    return studies.map(toStudy)
  })

  app.post('/api/v1/research/studies', async (request, reply) => {
    const body = createStudySchema.parse(request.body)
    const s = await service.createStudy(request.user!.userId, body.display_name, body.short_code, body.study_type === 'basic' ? 'basic' : 'clinical')
    return toStudy(s)
  })

  app.get('/api/v1/research/studies/:studyId', async (request, reply) => {
    const s = await service.getStudy(request.user!.userId, (request.params as any).studyId)
    if (!s) return reply.status(404).send({ error: 'Study not found' })
    return { ...toStudy(s), description: '' }
  })

  // #12: AI research-progress summary for citations / internal reporting.
  // Aggregates protocol, enrollment, rule confirmation, safety and
  // assessment status into a journal-ready paragraph.
  app.get('/api/v1/research/studies/:studyId/summary', async (request, reply) => {
    const userId = request.user!.userId
    const studyId = (request.params as any).studyId
    const study = await service.getStudy(userId, studyId)
    if (!study) return reply.status(404).send({ error: 'Study not found' })

    const [roster, rules, safety, assessments] = await Promise.all([
      service.getRoster(studyId).catch(() => []),
      getConfirmationStatus(studyId).catch(() => ({ total: 0, confirmed: 0, by_category: {} })),
      service.getSafetyStatus(studyId).catch(() => ({ triggered_rules: [], open_issues: 0 })),
      (prisma as any).researchAssessment.findMany({ where: { studyId }, orderBy: { dueAt: 'asc' } }).catch(() => []),
    ])

    const enrolled = (roster as any[]).filter((r: any) => r.arm).length
    const pendingAssessments = (assessments as any[]).filter((a: any) => !a.completedAt).length
    const safetyHits = (safety as any).triggered_rules?.length ?? 0

    const facts = [
      `研究：${study.name || studyId}（短码 ${study.shortCode || 'N/A'}）`,
      `协议要点：${String(study.protocol || '').slice(0, 400)}`,
      `入组：${enrolled} 例（总数 ${(roster as any[]).length}）`,
      `规则确认：${rules.confirmed}/${rules.total} 条`,
      `安全状态：触发停止规则 ${safetyHits} 条，未解决问题 ${(safety as any).open_issues ?? 0} 项`,
      `随访：待完成评估 ${pendingAssessments} 项，总评估 ${(assessments as any[]).length} 项`,
    ].filter(Boolean)

    const { deepseekChat, getApiKey, DEEPSEEK_CHAT_MODEL } = await import('../../common/llm.js')
    let summary = ''
    try {
      const raw = await deepseekChat(
        [{ role: 'system', content: '你是临床研究协调员。基于给定事实生成一段客观、适合写入论文 Methods/Results 或内部汇报的研究进展摘要（150-250字中文，含关键数字）。' },
         { role: 'user', content: facts.join('\n') }],
        getApiKey(),
        { model: DEEPSEEK_CHAT_MODEL, maxTokens: 800, telemetryContext: { userId, workspaceId: userId, action: 'research.summary' } },
      )
      summary = raw.trim()
    } catch {
      summary = '' // LLM unavailable — structured facts still returned
    }

    return {
      study_id: studyId,
      study_name: study.name,
      facts,
      summary: summary || facts.join('；'),
      generated_at: new Date().toISOString(),
    }
  })

  app.get('/api/v1/research/studies/:studyId/roster', async (request, reply) => {
    const studyId = (request.params as any).studyId
    const userId = request.user!.userId
    // 边界审计（#253）: the study must exist and belong to the caller —
    // otherwise this leaked other users' rosters and returned 200 for
    // nonexistent studies.
    const study = await service.getStudy(userId, studyId)
    if (!study) return reply.status(404).send({ error: 'Study not found' })
    const enrollments = await service.getRoster(studyId)
    const patientMap = await getPatientMap(enrollments.map((e: any) => e.patientHash), userId)
    return enrollments.map((e: any) => toRoster(e, patientMap.get(e.patientHash)))
  })

  app.get('/api/v1/research/studies/:studyId/enrollments', async (request, reply) => {
    const studyId = (request.params as any).studyId
    const userId = request.user!.userId
    const study = await service.getStudy(userId, studyId)
    if (!study) return reply.status(404).send({ error: 'Study not found' })
    const enrollments = await service.getRoster(studyId)
    const patientMap = await getPatientMap(enrollments.map((e: any) => e.patientHash), userId)
    return enrollments.map((e: any) => toRoster(e, patientMap.get(e.patientHash)))
  })

  app.post('/api/v1/research/studies/:studyId/enrollments', async (request) => {
    const body = enrollPatientSchema.parse(request.body)
    const studyId = (request.params as any).studyId
    const e = await service.enroll(studyId, body.patient_hash, body.arm)
    const userId = request.user!.userId
    const patientMap = await getPatientMap([e.patientHash], userId)
    return toRoster(e, patientMap.get(e.patientHash))
  })

  app.delete('/api/v1/research/studies/:studyId/enrollments/:patientHash', async (request) => {
    const { studyId, patientHash } = request.params as any
    return { ok: await service.unenroll(studyId, patientHash) }
  })

  app.get('/api/v1/research/studies/:studyId/eligibility', async (request) => {
    const studyId = (request.params as any).studyId
    const userId = request.user!.userId
    const screenings = await service.getEligibility(studyId)
    const patientMap = await getPatientMap(screenings.map((s: any) => s.patientHash), userId)
    return { screenings: screenings.map((s: any) => toScreening(s, patientMap.get(s.patientHash))) }
  })

  app.post('/api/v1/research/studies/:studyId/eligibility/rescan', async (request) =>
    service.rescanEligibility((request.params as any).studyId))

  app.get('/api/v1/research/studies/:studyId/observations', async (request) => {
    const studyId = (request.params as any).studyId
    const userId = request.user!.userId
    const observations = await service.getObservations(studyId)
    const patientMap = await getPatientMap(observations.map((o: any) => o.patientHash), userId)
    return observations.map((o: any) => toObservation(o, patientMap.get(o.patientHash)))
  })

  app.post('/api/v1/research/studies/:studyId/observations/:obsId/confirm', async (request, reply) => {
    const { studyId, obsId } = request.params as any
    const body = request.body as any
    const userId = request.user!.userId
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

  app.get('/api/v1/research/studies/:studyId/safety/stop-rule-status', async (request) => {
    const status = await service.getSafetyStatus((request.params as any).studyId)
    return {
      triggered_rules: status.stopRules
        .filter(r => r.triggered)
        .map(r => ({ rule: r.name, description: r.detail || '' })),
    }
  })

  app.get('/api/v1/research/studies/:studyId/assessments', async (request) => {
    const studyId = (request.params as any).studyId
    const userId = request.user!.userId
    const assessments = await service.getAssessments(studyId)
    const patientMap = await getPatientMap(assessments.map((a: any) => a.patientHash), userId)
    return assessments.map((a: any) => toAssessment(a, patientMap.get(a.patientHash)))
  })

  app.post('/api/v1/research/studies/:studyId/assessments/:visitName/complete', async (request) => {
    const { studyId, visitName } = request.params as any
    return { ok: await service.completeAssessment(studyId, visitName) }
  })

  // Step 3 workflow: Import protocol text (from file upload or paste)
  app.post('/api/v1/research/studies/:studyId/import-protocol', async (request, reply) => {
    const { studyId } = request.params as any
    const { text } = request.body as any
    const userId = request.user!.userId
    if (!text) return reply.status(400).send({ error: 'text required' })
    // Trigger AI extraction in background
    extractRulesFromProtocol(studyId, text, {
      telemetryContext: { userId, workspaceId: userId, action: 'research.extract_protocol' },
    }).catch(() => {})
    return service.importProtocol(studyId, text)
  })

  // Extraction: AI extracts rules from protocol
  app.post('/api/v1/research/studies/:studyId/extract-rules', async (request, reply) => {
    const { studyId } = request.params as any
    const { text } = request.body as any
    const userId = request.user!.userId
    if (!text) return reply.status(400).send({ error: 'text required' })
    const rules = await extractRulesFromProtocol(studyId, text, {
      telemetryContext: { userId, workspaceId: userId, action: 'research.extract_protocol' },
    })
    return { study_id: studyId, rules, status: await getConfirmationStatus(studyId) }
  })

  // Upload a protocol document (.txt/.md/.csv/.pdf/.docx): server-side text
  // extraction + rule extraction in one step.
  app.post('/api/v1/research/studies/:studyId/protocol-file', async (request, reply) => {
    const { studyId } = request.params as any
    const userId = request.user!.userId
    const data = await request.file()
    if (!data) return reply.status(400).send({ error: 'No file uploaded' })

    const buffer = await data.toBuffer()
    if (buffer.length === 0) return reply.status(400).send({ error: 'Empty file' })

    const SUPPORTED_EXT = /\.(txt|md|csv|pdf|docx)$/i
    if (!SUPPORTED_EXT.test(data.filename)) {
      return reply.status(400).send({ error: 'Unsupported file type (supported: .txt/.md/.csv/.pdf/.docx)' })
    }

    const dir = path.join(process.env.TWIN_BASE_DIR || '.nexus/twins', userId, 'uploads')
    fs.mkdirSync(dir, { recursive: true })
    const fileId = `${Date.now()}_${data.filename}`
    fs.writeFileSync(path.join(dir, fileId), buffer)

    let text = ''
    try {
      text = await extractDocumentText(buffer, data.filename, data.mimetype, { maxChars: 50000 })
    } catch (err: any) {
      return reply.status(400).send({ error: `Text extraction failed: ${err.message}` })
    }
    if (!text.trim()) {
      return reply.status(400).send({ error: 'Could not extract text from this file (supported: .txt/.md/.csv/.pdf/.docx)' })
    }

    const rules = await extractRulesFromProtocol(studyId, text, {
      telemetryContext: { userId, workspaceId: userId, action: 'research.extract_protocol' },
      sourceJobId: fileId,
      extractedFrom: data.filename,
    })

    return {
      study_id: studyId,
      file_id: fileId,
      file_name: data.filename,
      text_length: text.length,
      rules,
      status: await getConfirmationStatus(studyId),
    }
  })

  // List pending extracted rules
  app.get('/api/v1/research/studies/:studyId/protocol-rules', async (request) => {
    const { studyId } = request.params as any
    return {
      rules: await getPendingRules(studyId),
      status: await getConfirmationStatus(studyId),
    }
  })

  // Doctor confirms a rule — schedule rules also generate StudyEvent + assessment
  app.post('/api/v1/research/studies/:studyId/protocol-rules/:ruleId/confirm', async (request, reply) => {
    const { studyId, ruleId } = request.params as any
    const rule = await confirmRule(studyId, ruleId)
    if (!rule) return reply.status(404).send({ error: 'Rule not found' })
    return { rule, status: await getConfirmationStatus(studyId) }
  })

  // Doctor rejects a rule
  app.delete('/api/v1/research/studies/:studyId/protocol-rules/:ruleId', async (request, reply) => {
    const { studyId, ruleId } = request.params as any
    const ok = await rejectRule(studyId, ruleId)
    return { rejected: ok, study_id: studyId, status: await getConfirmationStatus(studyId) }
  })

  // Eligibility screening
  app.post('/api/v1/research/studies/:studyId/screen/:patientHash', async (request, reply) => {
    const { studyId, patientHash } = request.params as any
    const userId = request.user!.userId
    const result = await screenPatient(studyId, patientHash, userId)
    return result
  })

  app.post('/api/v1/research/studies/:studyId/screen-all', async (request) => {
    const { studyId } = request.params as any
    const userId = request.user!.userId
    const results = await screenAllEnrolled(studyId, userId)
    return { screenings: results }
  })
}
