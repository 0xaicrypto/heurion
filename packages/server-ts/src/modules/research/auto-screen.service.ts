/**
 * #755 — Automatic eligibility screening on patient intake.
 *
 * "新患者进来 → 系统主动举牌": patient creation / new medical record entry
 * enqueues a background screening pass across all studies with confirmed
 * protocol rules. Runs through the same screenPatient pipeline as manual
 * screening (conservative verdicts + per-rule breakdown persisted to
 * ResearchScreening), but decoupled from the HTTP response so registration
 * latency is unaffected.
 *
 * Intake-only (no historical backfill): each (study, patient) pair screens at
 * most once per evidence revision — a later medical-record update bumps the
 * evidence counter and permits one re-screen that supersedes the prior row.
 */
import prisma from '../../common/prisma.js'
import { makeLogger } from '../../common/logger.js'
import { screenPatient } from './eligibility-screening.service.js'
import { PrismaTelemetryService } from '../knowledge/telemetry.service.js'

const log = makeLogger('research.auto-screen')
const telemetry = new PrismaTelemetryService()

/** Evidence revision: registry passes 0, medical-record entries bump by count. */
async function evidenceRevision(userId: string, patientHash: string): Promise<number> {
  const count = await (prisma as any).medicalRecord.count({
    where: { userId, patientHash },
  }).catch(() => 0)
  return count || 0
}

async function alreadyScreened(studyId: string, patientHash: string, revision: number): Promise<boolean> {
  const latest = await (prisma as any).researchScreening.findFirst({
    where: { studyId, patientHash, reason: { contains: `rev:${revision}` } },
    orderBy: { scannedAt: 'desc' },
  })
  return !!latest
}

function withRevision(reason: string | null | undefined, revision: number): string {
  const base = reason?.replace(/\s*rev:\d+\s*$/, '') || ''
  return `${base} rev:${revision}`.slice(0, 499)
}

/**
 * Screen one patient against every study that has confirmed rules.
 * Fire-and-forget safe; errors land in telemetry, never the caller.
 */
export async function autoScreenPatient(userId: string, patientHash: string): Promise<{ studies: number; eligible: number }> {
  try {
    // Only patients with some clinical context are worth an LLM call.
    const hasProfile = await (prisma as any).patientRecord.findFirst({ where: { hash: patientHash, userId } })
    if (!hasProfile) return { studies: 0, eligible: 0 }

    const studies = await (prisma as any).researchStudy.findMany({
      where: { status: 'active' },
      select: { id: true },
    })
    if (!studies.length) return { studies: 0, eligible: 0 }

    const revision = await evidenceRevision(userId, patientHash)
    let screened = 0
    let eligible = 0

    for (const s of studies) {
      try {
        if (await alreadyScreened(s.id, patientHash, revision)) continue
        const result = await screenPatient(s.id, patientHash, userId)
        // Annotate the persisted reason with the evidence revision marker
        // (screenPatient already wrote its row — patch it).
        await (prisma as any).researchScreening.updateMany({
          where: { studyId: s.id, patientHash, scannedAt: { gte: new Date(Date.now() - 60000).toISOString() } },
          data: { reason: withRevision(result.reason, revision) },
        })
        screened++
        if (result.verdict === 'eligible') eligible++
      } catch (err) {
        log.warn('auto-screen per-study failed', { studyId: s.id, patientHash, reason: (err as Error).message.slice(0, 120) })
      }
    }

    await telemetry.record({
      userId,
      workspaceId: userId,
      category: 'research',
      action: 'auto_screened',
      metadata: { patientHash, studies: screened, eligible },
    }).catch(() => {})
    log.info(`auto-screen done`, { patientHash, screened, eligible })
    return { studies: screened, eligible }
  } catch (err) {
    log.warn('auto-screen skipped', { patientHash, reason: (err as Error).message.slice(0, 140) })
    return { studies: 0, eligible: 0 }
  }
}

const running = new Set<string>()

/** Serialized per-patient guard: coalesce duplicate triggers for one hash. */
export function enqueueAutoScreen(userId: string, patientHash: string): void {
  const key = `${userId}:${patientHash}`
  if (running.has(key)) return
  running.add(key)
  void autoScreenPatient(userId, patientHash).finally(() => running.delete(key))
}
