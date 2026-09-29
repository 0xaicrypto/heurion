import { describe, test, expect, vi } from 'vitest'
import { runExperienceSynthesisTick, EXPERIENCE_USER_PAGE_SIZE } from '../../src/modules/skills/experience-synthesis.service.js'

/**
 * #1146 — 经验归纳调度:旧实现 `findMany({ take: 50 })` 无 orderBy/游标,
 * 第 51 个用户永远轮不到;单个用户抛错中止整轮。
 * 修复:游标分页全量遍历 + 逐用户 try/catch。
 */
describe('#1146 经验归纳调度分页与容错', () => {
  test('游标分页覆盖全部用户;单用户失败不中止整轮', async () => {
    const firstPage = Array.from({ length: EXPERIENCE_USER_PAGE_SIZE }, (_, i) => ({ id: `u${String(i).padStart(4, '0')}` }))
    const pages: Array<Array<{ id: string }>> = [firstPage, [{ id: 'zzz_last' }]]
    const cursors: Array<string | undefined> = []
    const takes: number[] = []
    const synth = vi.fn(async (userId: string) => {
      if (userId === 'u0003') throw new Error('boom')
      return { candidates: [{}], groups: 1 } as never
    })

    const res = await runExperienceSynthesisTick({}, {
      listUserPage: async (cursor, take) => {
        cursors.push(cursor)
        takes.push(take)
        return pages.shift() ?? []
      },
      synthesize: synth as never,
    })

    // 全量覆盖:100 + 1,而非旧的只处理前 50。
    expect(res.users).toBe(EXPERIENCE_USER_PAGE_SIZE + 1)
    expect(synth).toHaveBeenCalledTimes(EXPERIENCE_USER_PAGE_SIZE + 1)
    // 单用户失败被隔离,其余用户照常归纳。
    expect(res.failed).toBe(1)
    expect(res.created).toBe(EXPERIENCE_USER_PAGE_SIZE)
    // 游标推进:首轮无游标,次轮使用首页最后 id。
    expect(cursors[0]).toBeUndefined()
    expect(cursors[1]).toBe('u0099')
    expect(takes.every((t) => t === EXPERIENCE_USER_PAGE_SIZE)).toBe(true)
  })

  test('单页未满即结束(不空转)', async () => {
    const calls: Array<string | undefined> = []
    const res = await runExperienceSynthesisTick({}, {
      listUserPage: async (cursor) => { calls.push(cursor); return [{ id: 'only' }] },
      synthesize: (async () => ({ candidates: [], groups: 0 })) as never,
    })
    expect(res.users).toBe(1)
    expect(calls.length).toBe(1)
  })
})
