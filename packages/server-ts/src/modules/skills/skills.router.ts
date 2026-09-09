import { FastifyInstance } from 'fastify'
import { authGuard } from '../../common/auth.guard'
import prisma from '../../common/prisma'
import { fetchGitHubSkills } from './github-skills.js'
// #922: 分页唯一实现(lib/paginate)—— 此前内联 parseInt 切片无 NaN 防护。
import { normalizePage, normalizeLimit, paginate } from '../../lib/paginate.js'

// #3: Expanded skill catalog (30+ skills)
const CATALOG = [
  // Clinical
  { identifier: 'official/clinical-summary', name: 'Clinical Summary', description: 'Generate structured clinical summaries from patient encounters', source: 'official', version: '1.2', author: 'Heurion' },
  { identifier: 'official/safety-monitor', name: 'Safety Monitor', description: 'Track adverse events and DLTs across study arms with auto-alerting', source: 'official', version: '1.0', author: 'Heurion' },
  { identifier: 'official/eligibility-check', name: 'Eligibility Check', description: 'Auto-check patient eligibility against protocol inclusion/exclusion criteria', source: 'official', version: '1.0', author: 'Heurion' },
  { identifier: 'official/differential-diagnosis', name: 'Differential Diagnosis', description: 'Generate ranked differential diagnosis from patient findings and history', source: 'official', version: '1.0', author: 'Heurion' },
  { identifier: 'official/treatment-plan', name: 'Treatment Plan', description: 'Generate evidence-based treatment plans with NCCN guideline references', source: 'official', version: '1.1', author: 'Heurion' },
  { identifier: 'official/soap-note', name: 'SOAP Note', description: 'Generate structured SOAP notes from clinical encounters', source: 'official', version: '1.0', author: 'Heurion' },
  // Imaging
  { identifier: 'github/imaging-report', name: 'Imaging Report', description: 'Generate structured radiology reports from DICOM and clinical context', source: 'github', version: '0.9', author: 'rad-ai' },
  { identifier: 'github/chest-xray-reader', name: 'Chest X-Ray Reader', description: 'Preliminary chest X-ray interpretation with finding detection', source: 'github', version: '0.8', author: 'med-ai' },
  { identifier: 'github/ct-nodule-detection', name: 'CT Nodule Detection', description: 'Lung nodule detection and measurement from CT series', source: 'github', version: '0.7', author: 'oncology-ai' },
  { identifier: 'github/mri-brain-seg', name: 'MRI Brain Segmentation', description: 'Brain tumor segmentation and volumetric analysis from MRI', source: 'github', version: '0.6', author: 'neuro-ai' },
  // Medication
  { identifier: 'github/med-review', name: 'Medication Review', description: 'Review medication lists for interactions and contraindications', source: 'github', version: '0.8', author: 'pharm-ai' },
  { identifier: 'github/dosing-calculator', name: 'Dosing Calculator', description: 'Calculate body-surface-area and weight-based dosing for oncology drugs', source: 'github', version: '1.0', author: 'pharm-ai' },
  { identifier: 'github/polypharmacy-check', name: 'Polypharmacy Check', description: 'Identify potential issues in patients on 5+ concurrent medications', source: 'github', version: '0.5', author: 'geri-ai' },
  // Research
  { identifier: 'github/trial-matching', name: 'Trial Matching', description: 'Match patients to eligible clinical trials based on profile and biomarkers', source: 'github', version: '0.7', author: 'research-ai' },
  { identifier: 'github/protocol-parser', name: 'Protocol Parser', description: 'Parse clinical trial protocols from PDF/DOCX into structured data', source: 'github', version: '0.6', author: 'research-ai' },
  { identifier: 'github/consort-generator', name: 'CONSORT Generator', description: 'Generate CONSORT flow diagrams from study enrollment data', source: 'github', version: '0.8', author: 'research-ai' },
  { identifier: 'github/kaplan-meier', name: 'Kaplan-Meier Plot', description: 'Generate survival curves from time-to-event data', source: 'github', version: '0.9', author: 'stats-ai' },
  // Writing
  { identifier: 'anthropic/diagnostic-reasoning', name: 'Diagnostic Reasoning', description: 'Step-by-step differential diagnosis from clinical findings', source: 'anthropic', version: '1.0', author: 'Anthropic' },
  { identifier: 'anthropic/patient-education', name: 'Patient Education', description: 'Generate patient-friendly explanations of medical conditions and treatments', source: 'anthropic', version: '1.0', author: 'Anthropic' },
  { identifier: 'anthropic/literature-review', name: 'Literature Review', description: 'Summarize recent literature on a given clinical topic from PubMed', source: 'anthropic', version: '1.1', author: 'Anthropic' },
  { identifier: 'anthropic/guideline-synthesis', name: 'Guideline Synthesis', description: 'Synthesize recommendations across NCCN/ASCO/ESMO guidelines', source: 'anthropic', version: '1.0', author: 'Anthropic' },
  { identifier: 'anthropic/informed-consent', name: 'Informed Consent', description: 'Generate plain-language informed consent documents for clinical trials', source: 'anthropic', version: '0.9', author: 'Anthropic' },
  // Quality
  { identifier: 'github/note-quality', name: 'Note Quality Audit', description: 'Audit clinical notes for completeness, clarity, and medico-legal compliance', source: 'github', version: '0.7', author: 'quality-ai' },
  { identifier: 'github/coding-assist', name: 'ICD-10 Coding', description: 'Suggest ICD-10 codes from clinical documentation', source: 'github', version: '0.8', author: 'coding-ai' },
  { identifier: 'github/billing-review', name: 'Billing Review', description: 'Review clinical documentation for appropriate billing level support', source: 'github', version: '0.6', author: 'billing-ai' },
  // Communication
  { identifier: 'github/referral-letter', name: 'Referral Letter', description: 'Generate structured referral letters with key clinical details', source: 'github', version: '0.8', author: 'comm-ai' },
  { identifier: 'github/discharge-summary', name: 'Discharge Summary', description: 'Generate comprehensive discharge summaries from hospital course', source: 'github', version: '0.7', author: 'comm-ai' },
  { identifier: 'github/handoff-note', name: 'Handoff Note', description: 'Generate structured sign-out notes for care transitions', source: 'github', version: '0.6', author: 'comm-ai' },
]

export async function skillsRouter(app: FastifyInstance) {
  app.addHook('preHandler', authGuard)

  // #923 类型收口:路由参数/查询/请求体显式类型(替代 request.params as any)。
  interface SkillNameParams { name: string }
  interface DraftIdParams { id: string }

  app.get('/api/v1/skills', async (request) => {
    const prefs = await prisma.userSkillPref.findMany({ where: { userId: request.user!.userId } })
    const installed = new Map(prefs.map((p) => [p.skillName, p]))
    // Return ALL skills with installed flag — so page shows full catalog
    const skills = CATALOG.map(s => ({
      name: s.name, title: s.name,
      description: s.description, version: s.version, author: s.author,
      enabled: installed.has(s.name) ? installed.get(s.name)?.enabled !== 0 : false,
      installed: installed.has(s.name),
    }))
    return { skills }
  })

  // #3: Paginated search with page + page_size
  app.get<{ Querystring: { query?: string; source?: string; page?: string; page_size?: string } }>('/api/v1/skills/search', async (request) => {
    const { query, source, page, page_size } = request.query
    const q = (query || '').toLowerCase()
    const src = source || 'all'
    // #922: 防护取严格版 — page 非法(NaN/负/0)回落 1,page_size clamp 1..100
    // (此前 parseInt('abc')=NaN 会让 offset 变 NaN、slice 返回空且页码回显 NaN)。
    const pageNum = normalizePage(page, 1)
    const pageSize = normalizeLimit(page_size, 10, 100)

    const prefs = await prisma.userSkillPref.findMany({ where: { userId: request.user!.userId } })
    const installed = new Set(prefs.map((p) => p.skillName))

    let results = CATALOG
      .filter(s => src === 'all' || s.source === src)
      .filter(s => !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))
      .map(s => ({ identifier: s.identifier, name: s.name, description: s.description, source: s.source, installed: installed.has(s.name), version: s.version, author: s.author }))

    // clampPageToTotal: false — 保持旧行为:越界页回显请求页 + 空结果,
    // 不像 gap 列表那样收进最后页;total_pages 保持 ceil 口径(空结果为 0)。
    const paged = paginate(results, pageNum, pageSize, { clampPageToTotal: false })
    results = paged.items

    return { results, total: paged.total, page: paged.page, page_size: paged.pageSize, total_pages: paged.totalPages }
  })

  app.post<{ Body: { identifier?: string } }>('/api/v1/skills/install', async (request) => {
    const { identifier } = request.body
    const skill = CATALOG.find(s => s.identifier === identifier)
    // split 永不产生空数组;identifier 缺省时保持原 as any 时代的 TypeError 语义。
    const name = skill?.name || identifier!.split('/').pop() || ''
    const source = skill?.source || 'manual'
    await prisma.userSkillPref.upsert({
      where: { userId_skillName: { userId: request.user!.userId, skillName: name } },
      update: { enabled: 1 },
      create: { userId: request.user!.userId, skillName: name, enabled: 1, autoApply: 0, source, createdAt: new Date().toISOString() },
    })
    return { name, source }
  })

  app.post<{ Params: SkillNameParams; Body: { enabled?: boolean } }>('/api/v1/skills/:name/toggle', async (request) => {
    const { name } = request.params
    const { enabled } = request.body
    await prisma.userSkillPref.upsert({
      where: { userId_skillName: { userId: request.user!.userId, skillName: name } },
      update: { enabled: enabled ? 1 : 0 },
      create: { userId: request.user!.userId, skillName: name, enabled: enabled ? 1 : 0, source: 'manual', createdAt: new Date().toISOString() },
    })
    return { name, enabled }
  })

  app.delete<{ Params: SkillNameParams }>('/api/v1/skills/:name', async (request) => {
    const { name } = request.params
    try { await prisma.userSkillPref.delete({ where: { userId_skillName: { userId: request.user!.userId, skillName: name } } }) } catch { /* ok */ }
    return { uninstalled: true }
  })

  // ── GitHub Claude Skills marketplace ──
  app.get<{ Querystring: { query?: string } }>('/api/v1/skills/github', async (request) => {
    const { query } = request.query
    const q = (query || '').toLowerCase()
    const skills = await fetchGitHubSkills()
    const prefs = await prisma.userSkillPref.findMany({ where: { userId: request.user!.userId } })
    const installed = new Set(prefs.map((p) => p.skillName))
    const filtered = skills
      .filter(s => !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))
      .map(s => ({
        identifier: s.identifier, name: s.name, description: s.description,
        source: 'github', repo: s.repo, author: s.author,
        installed: installed.has(s.name), version: s.version,
      }))
    return { skills: filtered, total: filtered.length, source: 'github' }
  })

// ── #298: skill capture — draft/refine/confirm from conversation ──────

// #24: experience synthesis — distill candidates from MULTIPLE confirmed
// cases (facts grouped by category), persisted as pending_review skills.
app.post<{ Querystring: { min_facts?: string; max_candidates?: string } }>('/api/v1/skills/synthesize', async (request) => {
  const userId = request.user!.userId
  const { synthesizeExperience } = await import('./experience-synthesis.service.js')
  const result = await synthesizeExperience(userId, {
    minFacts: Number(request.query.min_facts || 3),
    maxCandidates: Number(request.query.max_candidates || 3),
  })
  return {
    candidates: result.candidates.map((c) => ({ name: c.name, description: c.description, source_count: c.sourceCount })),
    groups: result.groups,
  }
})

app.post<{ Body: { conversation?: string; session_id?: string } }>('/api/v1/skills/capture', async (request, reply) => {
  const { conversation, session_id } = request.body
  if (!conversation || !String(conversation).trim()) {
    return reply.status(400).send({ error: 'conversation required' })
  }
  const userId = request.user!.userId
  const { captureSkillDraft, saveDraft } = await import('./skill-capture.service.js')
  const draft = await captureSkillDraft(userId, String(conversation))
  if (!draft.name) {
    return reply.status(422).send({ error: 'No reusable procedure found in the conversation' })
  }
  const draftId = await saveDraft(userId, draft, session_id)
  return { draft_id: draftId, ...draft }
})

app.post<{ Params: DraftIdParams; Body: { instruction?: string } }>('/api/v1/skills/capture/:id/refine', async (request, reply) => {
  const { instruction } = request.body
  if (!instruction || !String(instruction).trim()) {
    return reply.status(400).send({ error: 'instruction required' })
  }
  const userId = request.user!.userId
  const { refineSkillDraft } = await import('./skill-capture.service.js')
  try {
    const draft = await refineSkillDraft(userId, request.params.id, String(instruction))
    return draft
  } catch (err: any) {
    return reply.status(404).send({ error: err.message })
  }
})

app.post<{ Params: DraftIdParams }>('/api/v1/skills/capture/:id/confirm', async (request, reply) => {
  const userId = request.user!.userId
  const { confirmSkillDraft } = await import('./skill-capture.service.js')
  const result = await confirmSkillDraft(userId, request.params.id)
  if (!result.ok) return reply.status(404).send({ error: 'Draft not found or already confirmed' })
  // #845/D6: confirm = 进入审批闸门;审批通过后落图 + 行标 promoted。
  return { status: 'submitted_for_approval', proposalId: result.proposalId }
})

// #727: 对话内取消捕捉 — 删除服务端草稿,避免 Captured tab 残留
// "我没保存过的技能"。
app.delete<{ Params: DraftIdParams }>('/api/v1/skills/capture/:id', async (request, reply) => {
  const userId = request.user!.userId
  const { deleteSkillDraft } = await import('./skill-capture.service.js')
  const ok = await deleteSkillDraft(userId, request.params.id)
  if (!ok) return reply.status(404).send({ error: 'Draft not found' })
  return { ok: true }
})

app.get<{ Querystring: { status?: string } }>('/api/v1/skills/captured', async (request) => {
  const userId = request.user!.userId
  const { listCapturedSkills } = await import('./skill-capture.service.js')
  const status = request.query.status
  return { skills: await listCapturedSkills(userId, status) }
})
}
