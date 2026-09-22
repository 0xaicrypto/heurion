/**
 * #1107: 归属校验收口 — 路由层 `findFirst({ where: { id, userId } })` → 404
 * 模式的查询端单点（research.router getOwnedStudy 先例的通用化）。
 *
 * 404 响应（防枚举语义）仍留在调用方 — 这里只收敛重复的 Prisma 查询。
 * Prisma delegate 结构化满足 OwnedModel/HashOwnedModel（最小形状接口）。
 */

export interface OwnedModel<T> {
  findFirst(args: {
    where: { id: string; userId: string }
    select?: Record<string, unknown>
  }): Promise<T | null>
}

export interface HashOwnedModel<T> {
  findFirst(args: {
    where: { hash: string; userId: string }
  }): Promise<T | null>
}

export interface OwnedOpts {
  select?: Record<string, unknown>
}

export async function findOwned<T>(
  model: OwnedModel<T>,
  id: string,
  userId: string,
  opts?: OwnedOpts,
): Promise<T | null> {
  return model.findFirst({
    where: { id, userId },
    ...(opts?.select ? { select: opts.select } : {}),
  })
}

/** PatientRecord 的归属键是 hash（主键），非 id — 同款 404 前置查询。 */
export async function findOwnedByHash<T>(
  model: HashOwnedModel<T>,
  hash: string,
  userId: string,
): Promise<T | null> {
  return model.findFirst({ where: { hash, userId } })
}
