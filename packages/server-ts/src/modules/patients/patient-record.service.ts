/**
 * Patient record write service (#687) — the chiefComplaint append and the
 * scan-findings → MemoryGraph facts write that used to live inline in
 * patients.router.ts. The router only maps HTTP to these operations.
 */
import prisma from '../../common/prisma.js'
import { getUserContext } from '../shared/user-context.js'
import { MemoryGraphGateway } from '../../memory/memory-gateway.js'

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
  const patient = await prisma.patientRecord.findFirst({ where: { hash: patientHash, userId } })
  if (!patient) return
  const existing = patient.chiefComplaint || ''
  const snippet = text.slice(0, 50)
  if (existing.includes(snippet)) return
  await prisma.patientRecord.update({
    where: { hash: patientHash },
    data: { chiefComplaint: (existing + `\n[${prefix}] ` + text.slice(0, 300)).trim(), updatedAt: new Date().toISOString() },
  })
}

/**
 * Store quick-scan findings as MemoryGraph facts so the LLM can reference
 * them in chat. #839: machine-extracted findings go through the write gate
 * as pending proposals (semantic dedup / conflict marking / audit chain);
 * `file:<studyId>` sourceRange maps to the same document provenance the old
 * direct write carried. Best-effort by contract: failures are swallowed
 * (telemetry upstream decides visibility), never fail the scan response.
 */
export async function recordScanFindingsAsFacts(
  userId: string,
  studyId: string,
  findings: Array<{ type: string; content: string }>,
): Promise<void> {
  try {
    const ctx = getUserContext(userId)
    const docNode = ctx.memory.graph.getLatestByStableId(studyId)
    const patientHash = (docNode as any)?.patientHash
    const gateway = new MemoryGraphGateway(userId, ctx.memory)
    for (const f of findings) {
      if (f.type === 'meta' || f.type === 'error') continue
      const content = f.content.slice(0, 200)
      if (content.length > 5) {
        await gateway.propose({
          scopeType: patientHash ? 'patient' : 'global',
          patientHash: patientHash || undefined,
          kind: 'fact',
          content,
          importance: 4,
          confidence: 'medium',
          reason: '检查报告扫描发现',
          sourceRange: `file:${studyId}`,
          category: 'fact',
        })
      }
    }
  } catch { /* best-effort */ }
}
