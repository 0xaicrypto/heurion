/**
 * #922 重复实现收敛 — 状态 → Badge variant 映射唯一实现。
 *
 * 合并三处重复映射(research.tsx / medical-records.tsx / knowledge.tsx gaps
 * / research-detail.tsx 同款)的 key 超集;不在表中的 key 回落 fallback,
 * 各调用点保持原 else 行为:
 *  - research(默认 fallback 'default'):completed→success、
 *    in_progress/running→warning、failed/error→error;
 *  - medical-records(fallback 'error'):confirmed→success、
 *    pending_review→warning、rejected→error;
 *  - knowledge gaps(默认 'default'):open→warning、answered→success。
 */
export type StatusVariant = 'default' | 'success' | 'warning' | 'error'

const STATUS_VARIANT_MAP: Record<string, StatusVariant> = {
  // success
  completed: 'success',
  confirmed: 'success',
  answered: 'success',
  // warning
  in_progress: 'warning',
  running: 'warning',
  pending_review: 'warning',
  open: 'warning',
  // error
  failed: 'error',
  error: 'error',
  rejected: 'error',
}

export function statusVariant(status: string, fallback: StatusVariant = 'default'): StatusVariant {
  return STATUS_VARIANT_MAP[String(status ?? '').toLowerCase()] ?? fallback
}
