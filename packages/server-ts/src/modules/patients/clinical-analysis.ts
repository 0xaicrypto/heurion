import { resolveTierModel } from '../../common/llm-gateway.js'
import { deepseekChat, getApiKey, type LlmTelemetryContext} from '../../common/llm.js'
import { parseLlmJson } from '../../common/llm-json.js'
import prisma from '../../common/prisma.js'
import { makeLogger } from '../../common/logger.js'

const log = makeLogger('patients.clinical-analysis')

/**
 * Clinical Analysis Service — extracted from uploads and chats
 * Auto-updates patient records with findings
 */

export interface ClinicalFinding {
  finding_type: string  // 'diagnosis', 'lab_result', 'imaging', 'medication', 'symptom'
  content: string
  confidence: number
}

/** #6: structured medical-record sections extracted from a chat turn. */
export interface MedicalRecordSectionsUpdate {
  chief_complaint?: string
  diagnosis?: string
  treatment_plan?: string
  physical_exam?: string
  history_of_present_illness?: string
  past_medical_history?: string
  family_history?: string
  progress_notes?: string
}

const SECTIONS_KEYS = [
  'chief_complaint', 'diagnosis', 'treatment_plan', 'physical_exam',
  'history_of_present_illness', 'past_medical_history', 'family_history', 'progress_notes',
] as const

/**
 * #6: analyze a chat turn and return BOTH free findings (for the patient
 * profile) and structured record sections (for the medical record). The
 * record write is best-effort — missing sections are left untouched so a
 * doctor's manual record is never overwritten.
 */
export async function analyzeChatForMedicalRecord(
  userId: string,
  patientHash: string,
  messages: string,
  telemetryContext?: LlmTelemetryContext,
): Promise<{ findings: ClinicalFinding[]; sections: MedicalRecordSectionsUpdate }> {
  const prompt = `Extract clinical information from this doctor-patient conversation.
Return ONLY a JSON object with two keys:
{
  "findings": [{"finding_type": "diagnosis|lab_result|imaging|medication|symptom", "content": "short finding", "confidence": 0.0-1.0}],
  "sections": {
    "chief_complaint": "主诉（新信息）",
    "diagnosis": "诊断（新信息）",
    "treatment_plan": "治疗方案（新信息）",
    "progress_notes": "本次病程记录",
    "physical_exam": "体格检查（新信息）",
    "history_of_present_illness": "现病史（新信息）",
    "past_medical_history": "既往史（新信息）",
    "family_history": "家族史（新信息）"
  }
}
Only include keys that are NEWLY mentioned in this conversation; omit others. findings may be an empty array.

Conversation:
${messages.slice(0, 4000)}`

  const empty = { findings: [] as ClinicalFinding[], sections: {} as MedicalRecordSectionsUpdate }
  try {
    const result = await deepseekChat(
      [{ role: 'user', content: prompt }],
      getApiKey(),
      {
        model: resolveTierModel('fast'),
        maxTokens: 1200,
        telemetryContext,
      },
    )
    const parsed = parseLlmJson<{ sections?: Record<string, string>; findings?: ClinicalFinding[] }>(result)
    if (!parsed) return empty
    const sections: MedicalRecordSectionsUpdate = {}
    for (const key of SECTIONS_KEYS) {
      const v = parsed.sections?.[key]
      if (typeof v === 'string' && v.trim()) sections[key] = v.trim().slice(0, 2000)
    }
    return {
      findings: Array.isArray(parsed.findings) ? parsed.findings : [],
      sections,
    }
  } catch {
    return empty
  }
}

/**
 * #6 / P0 病历覆盖修复: merge extracted sections into the patient's medical
 * record — 版本化追加,绝不原地改写既有行:
 *  - 读最新一条做合并基线(医生手写行保持原样,历史完整可回溯);
 *  - 合并结果作为**新行**写入(每轮更新的版本,行即版本);
 *  - 基线 sections JSON 损坏时中止(此前 current={} + 只写新键 =
 *    把其他章节清空),不做任何写入;
 *  - 无变化不写(避免每轮对话堆一行)。
 */
export async function updateMedicalRecordFromChat(
  userId: string,
  patientHash: string,
  sections: MedicalRecordSectionsUpdate,
): Promise<boolean> {
  const keys = Object.keys(sections) as Array<keyof MedicalRecordSectionsUpdate>
  if (keys.length === 0) return false

  const now = new Date().toISOString()
  const existing = await prisma.medicalRecord.findFirst({
    where: { userId, patientHash },
    orderBy: { createdAt: 'desc' },
  })

  let current: Record<string, string> = {}
  if (existing) {
    try {
      const parsed = JSON.parse(existing.sections || '{}') as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('sections is not a JSON object')
      current = Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).filter(([, v]) => typeof v === 'string'),
      ) as Record<string, string>
    } catch (err) {
      // 损坏 JSON 无法安全合并 — 中止。绝不把已有章节清空重写。
      log.warn('medical record update skipped: existing sections JSON is corrupt', {
        userId, patientHash, recordId: existing.id, reason: (err as Error).message.slice(0, 120),
      })
      return false
    }
  }

  const merged: Record<string, string> = { ...current }
  let changed = false
  for (const key of keys) {
    const next = sections[key]!
    if (merged[key] === next) continue
    merged[key] = next
    changed = true
  }
  if (!changed) return false

  await prisma.medicalRecord.create({
    data: {
      id: `mr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      userId,
      patientHash,
      title: 'AI 自动更新病历',
      sections: JSON.stringify(merged),
      createdAt: now,
      updatedAt: now,
    },
  })
  return true
}

export async function updatePatientFromFindings(
  userId: string, patientHash: string, findings: ClinicalFinding[]
): Promise<void> {
  if (!findings.length) return

  const patient = await prisma.patientRecord.findFirst({
    where: { hash: patientHash, userId },
  })
  if (!patient) return

  const existingComplaint = patient.chiefComplaint || ''
  const newFindings = findings
    .filter(f => f.confidence > 0.5)
    .map(f => `[${f.finding_type}] ${f.content}`)
    .join('; ')

  await prisma.patientRecord.update({
    where: { hash: patientHash },
    data: {
      chiefComplaint: existingComplaint
        ? `${existingComplaint} | ${newFindings}`
        : newFindings,
      updatedAt: new Date().toISOString(),
    },
  })
}
