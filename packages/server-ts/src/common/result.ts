/**
 * #302: unified error contract for the service layer.
 * Business failures are returned as `Result<T>` instead of `null`/thrown
 * errors, so callers can predictably distinguish "not found" from
 * "operation failed". Exceptions are reserved for unrecoverable errors
 * (missing config, corrupt storage).
 */
export type Result<T> = { ok: true; value: T } | { ok: false; error: string }

export function ok<T>(value: T): Result<T> {
  return { ok: true, value }
}

export function err<T = never>(error: string): Result<T> {
  return { ok: false, error }
}
