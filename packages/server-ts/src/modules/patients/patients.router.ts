import { FastifyInstance } from 'fastify'
import { authGuard } from '../../common/auth.guard.js'
import prisma from '../../common/prisma.js'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { quickScanDicom, renderDicomSlice, analyzeWithGeminiVision } from './dicom-scanner.js'
import { getUserContext } from '../chat/user-context.js'

function uid() { return crypto.randomBytes(8).toString('hex') }

export async function patientsRouter(app: FastifyInstance) {
  app.addHook('preHandler', authGuard)

  // ── List patients (frontend: /api/v1/dicom/patients/full) ──
  app.get('/api/v1/dicom/patients/full', async (request) => {
    const records = await (prisma as any).patientRecord.findMany({
      where: { userId: request.user!.userId },
      orderBy: { createdAt: 'desc' },
    })
    return records.map((r: any) => ({
      patient_hash: r.hash,
      initials: r.initials || r.name || '',
      age_value: r.age || undefined,
      age_group: r.age ? (r.age < 18 ? 'pediatric' : r.age > 65 ? 'geriatric' : 'adult') : undefined,
      sex: r.sex || undefined,
      chief_complaint: r.chiefComplaint || undefined,
      created_at: r.createdAt,
      study_count: 0,
      source: r.source || 'manual',
    }))
  })

  // ── Patient detail ──
  app.get('/api/v1/dicom/patients/:hash/detail', async (request, reply) => {
    const { hash } = request.params as any
    const r = await (prisma as any).patientRecord.findFirst({ where: { hash, userId: request.user!.userId } })
    if (!r) return reply.status(404).send({ error: 'Patient not found' })
    return {
      patient_hash: r.hash, initials: r.initials || r.name || '',
      age_value: r.age || undefined, sex: r.sex || undefined,
      chief_complaint: r.chiefComplaint || undefined,
      created_at: r.createdAt, updated_at: r.updatedAt,
      study_count: 0,
    }
  })

  // ── Register manual ──
  app.post('/api/v1/dicom/patients/register-manual', async (request) => {
    const body = request.body as any
    const hash = `patient_${uid()}`
    const now = new Date().toISOString()
    await (prisma as any).patientRecord.create({
      data: {
        hash, userId: request.user!.userId,
        initials: body.initials || body.name || '',
        age: body.age || 0,
        sex: body.sex || '',
        chiefComplaint: body.chief_complaint || '',
        source: 'manual', createdAt: now, updatedAt: now,
      },
    })
    return { patient_hash: hash, name: body.name || '', initials: body.initials || '', created_at: now }
  })

  // ── Delete ──
  app.delete('/api/v1/dicom/patients/:hash', async (request) => {
    const { hash } = request.params as any
    const userId = request.user!.userId

    // Remove related structured records first
    await (prisma as any).medicalRecord.deleteMany({ where: { patientHash: hash, userId } })
    await (prisma as any).researchAssessment.deleteMany({ where: { patientHash: hash } })
    try {
      await (prisma as any).fileIndex.deleteMany({ where: { patientHash: hash, userId } })
    } catch {
      // FileIndex table may not exist in older databases
    }

    // Delete the patient row
    await (prisma as any).patientRecord.deleteMany({ where: { hash, userId } })

    // Cascade-delete memory facts tied to this patient so dependent articles become stale/superseded
    const ctx = getUserContext(userId)
    const cascade = ctx.memory.deletePatientReferences(hash)

    return { deleted: true, ...cascade }
  })

  // ── Studies (stub) ──
  app.get('/api/v1/dicom/patients/:patientHash/studies', async (request) => {
    // Return uploaded files as DICOM studies for this patient
    const dir = path.join(process.env.TWIN_BASE_DIR || '.nexus/twins', (request as any).user?.userId || '', 'uploads')
    const files: Array<{study_id: string; modality: string; series_count: number; created_at: string}> = []
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.dcm')) {
          files.push({
            study_id: f, // Keep .dcm extension so viewer/render can find the file
            modality: 'CT',
            series_count: 1,
            created_at: new Date().toISOString(),
          })
        }
      }
    }
    // Frontend expects a bare array, not { studies: [...] }
    return files
  })

  // Study detail with series info for DICOM viewer
  app.get('/api/v1/dicom/studies/:studyId', async (request) => {
    const studyId = (request.params as any).studyId
    const findings = quickScanDicom(request.user!.userId, studyId)

    // Extract info from DICOM findings
    const studyFinding = findings.find(f => f.type === 'study')
    const imageFinding = findings.find(f => f.type === 'image')

    const rowsCols = imageFinding?.content.match(/(\d+)x(\d+)/)
    const sliceCount = 1 // Single slice DICOM
    const seriesCount = 1

    return {
      study_id: studyId,
      modality: 'CT',
      body_part: 'CHEST',
      series_count: seriesCount,
      slice_count: sliceCount,
      created_at: new Date().toISOString(),
      series: [{
        series_uid: `${studyId}_series_0`,
        series_description: studyFinding?.content || 'CT Series',
        slice_count: sliceCount,
        rows: rowsCols ? parseInt(rowsCols[1]) : 512,
        cols: rowsCols ? parseInt(rowsCols[2]) : 512,
      }],
    }
  })

  app.get('/api/v1/dicom/studies/:studyId/series/:seriesIdx/render', async (request, reply) => {
    const studyId = (request.params as any).studyId
    const bmp = renderDicomSlice(request.user!.userId, studyId)
    if (bmp) {
      reply.header('Content-Type', 'image/png')
      reply.header('Cache-Control', 'public, max-age=3600')
      return bmp
    }
    reply.header('Content-Type', 'image/png')
    return Buffer.alloc(1)
  })

  // The target patient must be EXPLICIT and owned by the user — a scan
  // result must never land in the 'latest patient' profile (multi-patient
  // data integrity, clinical safety).
  async function appendChiefComplaint(userId: string, patientHash: string | undefined | null, prefix: string, text: string) {
    if (!patientHash || !text || text.length <= 5) return
    const patient = await (prisma as any).patientRecord.findFirst({ where: { hash: patientHash, userId } })
    if (!patient) return
    const existing = patient.chiefComplaint || ''
    const snippet = text.slice(0, 50)
    if (existing.includes(snippet)) return
    await (prisma as any).patientRecord.update({
      where: { hash: patientHash },
      data: { chiefComplaint: (existing + `\n[${prefix}] ` + text.slice(0, 300)).trim(), updatedAt: new Date().toISOString() },
    })
  }

  // #2: Quick Scan + update patient profile
  app.post('/api/v1/dicom/studies/:studyId/quick-scan', async (request) => {
    const studyId = (request.params as any).studyId
    const userId = request.user!.userId
    const body = (request.body as any) || {}
    // The scan must be explicitly attached to a patient owned by the user —
    // no implicit 'latest patient' (clinical data integrity).
    const patientHash = body.patient_hash || null
    const findings = quickScanDicom(userId, studyId)

    // Gemini Vision analysis with timeout — AI FAILURES are telemetry only,
    // never persisted into the patient record as clinical findings.
    const AI_TIMEOUT_MS = 10000
    let aiFindings = ''
    let aiFailed = false
    try {
      aiFindings = await Promise.race([
        analyzeWithGeminiVision(userId, studyId),
        new Promise<string>((_, reject) => setTimeout(() => reject(new Error('timeout')), AI_TIMEOUT_MS)),
      ])
    } catch (err) {
      aiFailed = true
      const message = err instanceof Error ? err.message : String(err)
      console.log(`[QUICK-SCAN] Vision analysis failed: ${message}`)
    }

    if (aiFindings && !aiFailed) {
      findings.push({ type: 'ai_analysis', content: aiFindings })
      await appendChiefComplaint(userId, patientHash, 'AI Vision', aiFindings).catch(() => {})
    }

    // Update patient with scan data
    const text = findings.filter((f: any) => f.type !== 'meta' && f.type !== 'error' && f.type !== 'ai_analysis')
      .map((f: any) => f.content).join(' | ')
    if (text && text.length > 5) {
      await appendChiefComplaint(userId, patientHash, 'Scan', text).catch(() => {})
    }

    // Store findings as MemoryGraph facts so the LLM can reference them in chat
    try {
      const ctx = getUserContext(userId)
      const docNode = ctx.memory.graph.getLatestByStableId(studyId)
      const patientHash = (docNode as any)?.patientHash
      for (const f of findings) {
        if (f.type === 'meta' || f.type === 'error') continue
        const content = f.content.slice(0, 200)
        if (content.length > 5) {
          ctx.memory.addFact({
            category: 'fact',
            importance: 4,
            content,
            sourceType: 'patient',
            patientHash: patientHash || undefined,
            provenance: { sourceKind: 'document', sourceRef: studyId },
          }, 'system')
        }
      }
    } catch {}

    return { ok: true, findings, study_id: studyId }
  })

  app.post('/api/v1/dicom/send-to-agent', async (request) => {
    return { ok: true }
  })

  // ── Memory projection — aggregate findings from patient data
  app.get('/api/v1/memory/patient/:patientHash/projection', async (request) => {
    const { patientHash } = request.params as any
    const userId = request.user!.userId

    const patient = await (prisma as any).patientRecord.findFirst({ where: { hash: patientHash, userId } })
    if (!patient) return { findings: [], medications: [], timeline: [], medical_record: null }

    const findings: Array<{ node_id: string; node_type: string; content: string }> = []
    const medications: Array<{ node_id: string; node_type: string; content: string }> = []
    const timeline: Array<{ event_id: string; event_type: string; content: string; timestamp: string }> = []

    // ── 1. Pull structured data from latest medical record (primary source) ──
    const latestMr = await (prisma as any).medicalRecord.findFirst({
      where: { patientHash, userId },
      orderBy: { updatedAt: 'desc' },
    })
    let medicalRecord: {
      id: string; title: string; updated_at: string;
      sections: { chief_complaint?: string; diagnosis?: string; treatment_plan?: string;
                   physical_exam?: string; history_of_present_illness?: string;
                   past_medical_history?: string; family_history?: string; progress_notes?: string }
    } | null = null

    if (latestMr) {
      const sections = typeof latestMr.sections === 'string'
        ? JSON.parse(latestMr.sections) : (latestMr.sections || {})
      medicalRecord = {
        id: latestMr.id,
        title: latestMr.title,
        updated_at: latestMr.updatedAt,
        sections,
      }
      // Map structured sections to findings (these take priority over chief_complaint tags)
      const sectionFindings: Array<[string, string]> = [
        ['chief_complaint', sections.chief_complaint],
        ['diagnosis', sections.diagnosis],
        ['treatment_plan', sections.treatment_plan],
        ['physical_exam', sections.physical_exam],
        ['history_of_present_illness', sections.history_of_present_illness],
        ['past_medical_history', sections.past_medical_history],
        ['family_history', sections.family_history],
        ['progress_notes', sections.progress_notes],
      ]
      for (const [type, content] of sectionFindings) {
        if (content && content.trim()) {
          findings.push({ node_id: `mr_${type}`, node_type: type, content: content.trim() })
        }
      }
      timeline.push({
        event_id: `mr_${latestMr.id}`,
        event_type: 'medical_record_updated',
        content: `Medical record "${latestMr.title}" updated`,
        timestamp: latestMr.updatedAt,
      })
    }

    // ── 2. Parse chief_complaint tags (supplementary, legacy) ──
    const complaint = patient.chiefComplaint || ''
    if (complaint) {
      const tags = complaint.match(/\[(\w+)\]\s*([^\[\]]+)/g) || []
      for (const tag of tags) {
        const m = tag.match(/\[(\w+)\]\s*(.+)/)
        if (!m) continue
        const [, type, content] = m
        if (type === 'medication') {
          medications.push({ node_id: `med_${medications.length}`, node_type: 'medication', content: content.trim() })
        } else {
          // Skip if medical record already covers this type
          const alreadyCovered = findings.some(f => f.node_id === `mr_${type}`)
          if (!alreadyCovered) {
            findings.push({ node_id: `f_${findings.length}`, node_type: type, content: content.trim() })
          }
        }
      }
      timeline.push({
        event_id: 'create', event_type: 'patient_created',
        content: `Patient profile created`,
        timestamp: patient.createdAt,
      })
    }

    // ── 3. Chat events from event log ──
    const ctx = getUserContext(userId)
    const events = ctx.eventLog.query({ limit: 50 })
    for (const evt of events) {
      if (evt.metadata?.patientHash === patientHash || evt.content?.includes(patientHash)) {
        timeline.push({
          event_id: `evt_${evt.idx}`,
          event_type: evt.eventType,
          content: evt.content.slice(0, 100),
          timestamp: new Date(evt.timestamp * 1000).toISOString(),
        })
      }
    }

    return { findings, medications, timeline, medical_record: medicalRecord }
  })

  app.get('/api/v1/memory/patient/:patientHash/findings', async (request) => {
    const proj = await getPatientProjection(request)
    return { findings: proj.findings }
  })

  app.get('/api/v1/memory/patient/:patientHash/timeline', async (request) => {
    const proj = await getPatientProjection(request)
    return { entries: proj.timeline }
  })

  async function getPatientProjection(request: any) {
    const { patientHash } = request.params as any
    const userId = request.user!.userId
    const patient = await (prisma as any).patientRecord.findFirst({ where: { hash: patientHash, userId } })
    if (!patient) return { findings: [], timeline: [] }
    const complaint = patient.chiefComplaint || ''
    const findings: Array<{ node_id: string; node_type: string; content: string }> = []
    const tags = complaint.match(/\[(\w+)\]\s*([^\[\]]+)/g) || []
    for (const tag of tags) {
      const m = tag.match(/\[(\w+)\]\s*(.+)/)
      if (!m) continue
      findings.push({ node_id: `f_${findings.length}`, node_type: m[1], content: m[2].trim() })
    }
    const ctx = getUserContext(userId)
    const events = ctx.eventLog.query({ limit: 50 })
    const timeline = events
      .filter((e: any) => e.metadata?.patientHash === patientHash)
      .map((e: any) => ({
        event_id: `evt_${e.idx}`,
        event_type: e.eventType,
        content: e.content.slice(0, 100),
        timestamp: new Date(e.timestamp * 1000).toISOString(),
      }))
    return { findings, timeline }
  }
}
