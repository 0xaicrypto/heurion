import { deepseekChat, getApiKey, type LlmTelemetryContext , DEEPSEEK_CHAT_MODEL } from '../../common/llm.js'
import prisma from '../../common/prisma.js'
import fs from 'fs'
import path from 'path'

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
        model: DEEPSEEK_CHAT_MODEL,
        maxTokens: 1200,
        telemetryContext,
      },
    )
    const match = result.match(/\{[\s\S]*\}/)
    if (!match) return empty
    const parsed = JSON.parse(match[0])
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
 * #6: merge extracted sections into the patient's medical record —
 * upsert the latest record, preserving manual sections (only provided
 * keys are written).
 */
export async function updateMedicalRecordFromChat(
  userId: string,
  patientHash: string,
  sections: MedicalRecordSectionsUpdate,
): Promise<boolean> {
  const keys = Object.keys(sections) as Array<keyof MedicalRecordSectionsUpdate>
  if (keys.length === 0) return false

  const now = new Date().toISOString()
  const existing = await (prisma as any).medicalRecord.findFirst({
    where: { userId, patientHash },
    orderBy: { createdAt: 'desc' },
  })

  if (existing) {
    let current: Record<string, string> = {}
    try { current = JSON.parse(existing.sections || '{}') } catch { /* invalid json */ }
    for (const key of keys) current[key] = sections[key]!
    await (prisma as any).medicalRecord.update({
      where: { id: existing.id },
      data: { sections: JSON.stringify(current), updatedAt: now },
    })
    return true
  }

  await (prisma as any).medicalRecord.create({
    data: {
      id: `mr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      userId,
      patientHash,
      title: 'AI 自动更新病历',
      sections: JSON.stringify(sections),
      createdAt: now,
      updatedAt: now,
    },
  })
  return true
}

export async function analyzeUploadForPatient(
  userId: string, fileId: string, telemetryContext?: LlmTelemetryContext
): Promise<ClinicalFinding[]> {
  const dir = path.join(process.env.TWIN_BASE_DIR || '.nexus/twins', userId, 'uploads')
  const filepath = path.join(dir, fileId)
  if (!fs.existsSync(filepath)) return []

  const text = fs.readFileSync(filepath, 'utf-8').slice(0, 3000)
  const prompt = `Extract clinical findings from this medical document. Return ONLY a JSON array:
[{"finding_type": "diagnosis|lab_result|imaging|medication|symptom", "content": "short finding", "confidence": 0.0-1.0}]

Document:
${text}`

  try {
    const result = await deepseekChat(
      [{ role: 'user', content: prompt }],
      getApiKey(),
      {
        model: DEEPSEEK_CHAT_MODEL,
        maxTokens: 1024,
        telemetryContext,
      },
    )
    const match = result.match(/\[[\s\S]*\]/)
    return match ? JSON.parse(match[0]) : []
  } catch {
    return []
  }
}

export async function updatePatientFromFindings(
  userId: string, patientHash: string, findings: ClinicalFinding[]
): Promise<void> {
  if (!findings.length) return

  const patient = await (prisma as any).patientRecord.findFirst({
    where: { hash: patientHash, userId },
  })
  if (!patient) return

  const existingComplaint = patient.chiefComplaint || ''
  const newFindings = findings
    .filter(f => f.confidence > 0.5)
    .map(f => `[${f.finding_type}] ${f.content}`)
    .join('; ')

  await (prisma as any).patientRecord.update({
    where: { hash: patientHash },
    data: {
      chiefComplaint: existingComplaint
        ? `${existingComplaint} | ${newFindings}`
        : newFindings,
      updatedAt: new Date().toISOString(),
    },
  })
}

export async function analyzeChatForPatient(
  userId: string, patientHash: string, messages: string, telemetryContext?: LlmTelemetryContext
): Promise<ClinicalFinding[]> {
  const prompt = `Extract clinical findings from this doctor-patient conversation. Return ONLY a JSON array:
[{"finding_type": "diagnosis|lab_result|imaging|medication|symptom", "content": "short finding", "confidence": 0.0-1.0}]

Conversation:
${messages.slice(0, 3000)}`

  try {
    const result = await deepseekChat(
      [{ role: 'user', content: prompt }],
      getApiKey(),
      {
        model: DEEPSEEK_CHAT_MODEL,
        maxTokens: 1024,
        telemetryContext,
      },
    )
    const match = result.match(/\[[\s\S]*\]/)
    return match ? JSON.parse(match[0]) : []
  } catch {
    return []
  }
}
