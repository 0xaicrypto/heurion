/**
 * Shared pending-ingestion row mapping (#653) — IngestionInbox and
 * PendingIngestionsWidget duplicated the kindVariant badge map, the
 * payload→(entry|proposal) discriminating casts and the 3-fetch loader.
 * Discrimination follows the #461 pattern: a MemoryProposal payload also
 * carries an `id`, so only treat a payload as a MedicalRecordEntry when it
 * is NOT a proposal.
 */
import { api } from '@/lib/api';
import type { ApprovalRequest, MedicalRecordEntry, MemoryProposal } from '@/lib/types';

export type KindVariant = 'default' | 'success' | 'warning' | 'error'

export const kindVariant: Record<string, KindVariant> = {
  fact: 'success',
  summary: 'warning',
  episode_summary: 'default',
  compaction_summary: 'default',
};

export interface IngestionRow {
  approval: ApprovalRequest;
  entry: MedicalRecordEntry | null;
  proposal: MemoryProposal | null;
  patientName?: string;
}

function toRow(approval: ApprovalRequest, patientNames: Map<string, string>): IngestionRow {
  const payload = approval.payload as Record<string, unknown> | null;
  // KB 重命名兼容:服务端启动迁移前的存量 payload 可能仍是 kind:'article'。
  let proposal = payload && typeof payload.kind === 'string' ? (payload as unknown as MemoryProposal) : null;
  if (proposal && (proposal as unknown as { kind: string }).kind === 'article') {
    proposal = { ...proposal, kind: 'summary' };
  }
  const entry = !proposal && payload && typeof payload.id === 'string' ? (payload as unknown as MedicalRecordEntry) : null;
  const patientHash = proposal?.patientHash ?? entry?.patientHash;
  return { approval, entry, proposal, patientName: patientHash ? patientNames.get(patientHash) : undefined };
}

/** 拉取两类待审批（病历条目 + 记忆提案）并统一投影为 IngestionRow。 */
export async function fetchIngestionRows(): Promise<IngestionRow[]> {
  const [entriesRes, memoriesRes, patientsRes] = await Promise.all([
    api.listPendingApprovals({ targetType: 'MedicalRecordEntry' }),
    api.listPendingApprovals({ targetType: 'MemoryProposal' }),
    api.listPatients().catch(() => []),
  ]);
  const patientNames = new Map<string, string>(patientsRes.filter((p) => p.name).map((p) => [p.patient_hash, p.name as string]));
  return [...entriesRes.requests, ...memoriesRes.requests].map((approval) => toRow(approval, patientNames));
}
