/**
 * #1154 — 调度器 DB 租约（单实例约束下的防重入安全网）。
 * 所有 setInterval 调度器跑在 API 进程内且无分布式锁：滚动发布/误扩副本时
 * 同名调度器会并发执行（重复研究/重复落图）。这里用一条 SQLite 行做租约：
 *  - 过期租约可被任意实例原子接管（updateMany where expiresAt < now）；
 *  - 持有者续约（holder 匹配时 update 成功）；
 *  - 竞争失败仅跳过本轮，不抛错（调度器下一次 tick 再抢）。
 */
import { hostname } from 'os'
import { randomBytes } from 'crypto'
import prisma from './prisma.js'
import { makeLogger } from './logger.js'

const log = makeLogger('scheduler.lease')

/** 本进程唯一持有者标识（host:pid:random）— 同进程多次调度共享。 */
export const LEASE_HOLDER = `${hostname()}:${process.pid}:${randomBytes(4).toString('hex')}`

export async function acquireSchedulerLease(
  name: string,
  ttlMs: number,
  holder: string = LEASE_HOLDER,
): Promise<boolean> {
  const now = new Date().toISOString()
  const expiresAt = new Date(Date.now() + Math.max(1000, ttlMs)).toISOString()
  try {
    const updated = await prisma.schedulerLease.updateMany({
      where: { name, OR: [{ expiresAt: { lt: now } }, { holder }] },
      data: { holder, expiresAt, updatedAt: now },
    })
    if (updated.count > 0) return true
  } catch (err) {
    log.warn(`lease update failed for ${name}`, { reason: (err as Error).message?.slice(0, 120) })
    return false
  }
  try {
    await prisma.schedulerLease.create({ data: { name, holder, expiresAt, updatedAt: now } })
    return true
  } catch {
    // 唯一约束冲突 = 其他实例持有有效租约 — 本轮跳过。
    return false
  }
}
