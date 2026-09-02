/**
 * Patient record write service (#687) — the chiefComplaint append and the
 * scan-findings → MemoryGraph facts write that used to live inline in
 * patients.router.ts. The router only maps HTTP to these operations.
 */
import prisma from '../../common/prisma.js'
import { getUserContext } from '../chat/user-context.js'

/**
 * Append a labelled snippet to the patient's chiefComplaint. The target
 * patient must be EXPLICIT and owned by the user — a scan result must never
 * land in the 'latest patient' profile (multi-patient data integrity,
 * clinical safety). Idempotent per 50-char snippet prefix.
 */
export async function appendChiefComplaint(
  userId: string,
  patientHash: string | undefined | null,
  prefix: string,
  text: string,
): Promise<void> {
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

/**
 * Store quick-scan findings as MemoryGraph facts so the LLM can reference
 * them in chat. Best-effort by contract: failures are swallowed (telemetry
 * upstream decides visibility), never fail the scan response.
 */
export function recordScanFindingsAsFacts(
  userId: string,
  studyId: string,
  findings: Array<{ type: string; content: string }>,
): void {
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
  } catch { /* best-effort */ }
}
