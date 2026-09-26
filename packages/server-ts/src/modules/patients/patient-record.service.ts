/**
 * Patient record write service (#687) — scan-findings → MemoryGraph facts
 * that used to live inline in patients.router.ts. The router only maps HTTP
 * to these operations.
 *
 * P1 临床安全: 原 appendChiefComplaint（把扫描/AI 结论直接追加进主诉）已
 * 删除 — 未经审核的 AI 结论与 DICOM 头真实姓名不得无条件写入临床记录；
 * 扫描结果统一走下方 pending 提案闸门（医生确认后才进记忆/视图）。
 */
import { getUserContext } from '../shared/user-context.js'
import { MemoryGraphGateway } from '../../memory/memory-gateway.js'

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
