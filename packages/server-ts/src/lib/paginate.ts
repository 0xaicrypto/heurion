/**
 * #922 重复实现收敛 — 分页唯一实现。
 *
 * 泛化自 knowledge-gap.service.ts 的 paginate(page clamp 进有效区间)与
 * skills.router.ts 的内联切片(parseInt 无 NaN 防护)。防护取更严格一版:
 * page 非法(NaN/负/0)回落 1,limit clamp 到 [1, max]。
 * 对外响应形状由各调用点自行拼装(形状不变,仅防护收紧)。
 */

/** page 非法(NaN/负数/0)回落 fallback(默认 1);解析口径同 parseInt。 */
export function normalizePage(raw: unknown, fallback = 1): number {
  const n = typeof raw === 'number' ? raw : parseInt(String(raw ?? ''), 10)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback
}

/** limit 非法回落 fallback,并 clamp 到 [1, max](默认上限 100)。 */
export function normalizeLimit(raw: unknown, fallback: number, max = 100): number {
  const n = typeof raw === 'number' ? raw : parseInt(String(raw ?? ''), 10)
  if (!Number.isFinite(n) || n < 1) return fallback
  return Math.min(Math.floor(n), max)
}

export interface PaginatedResult<T> {
  items: T[]
  page: number
  pageSize: number
  total: number
  totalPages: number
}

/**
 * 统一切片:totalPages = ceil(total/pageSize)(不加下限,由调用方决定
 * 是否 max(1, …));clampPageToTotal(默认 true)把 page 收进 [1, 最后页],
 * 关闭时原样回显 page(无 clamp,与旧 skills 行为一致)。
 */
export function paginate<T>(
  items: T[],
  page: number,
  pageSize: number,
  opts: { clampPageToTotal?: boolean } = {},
): PaginatedResult<T> {
  const total = items.length
  const totalPages = Math.ceil(total / pageSize)
  const safePage = opts.clampPageToTotal === false
    ? page
    : Math.min(Math.max(1, page), Math.max(1, totalPages))
  const start = (safePage - 1) * pageSize
  return {
    items: items.slice(start, start + pageSize),
    page: safePage,
    pageSize,
    total,
    totalPages,
  }
}
