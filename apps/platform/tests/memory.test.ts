import { describe, expect, it } from 'vitest'
import type { HarnessPool } from '../src/harness/pool.ts'
import { sensitiveReason } from '../src/memory/guard.ts'
import { MemoryError, MemoryService } from '../src/memory/service.ts'
import { TurnRegistry } from '../src/mcp/turns.ts'
import { Documents } from '../src/model/runtime.ts'
import { Store } from '../src/store/db.ts'
import { TurnService } from '../src/turns/service.ts'

const ai = { source: 'turn' as const, actor: 'ai' as const }

function env() {
  const store = new Store(':memory:')
  const docs = new Documents(store)
  const memory = new MemoryService(store, null)
  const proj = store.createProject('u1', 'SELECT 汇报')
  const inProject = docs.create({ owner: 'u1', title: '项目里的文档' })
  store.setDocProject(inProject.id, proj.id)
  const loose = docs.create({ owner: 'u1', title: '散落的文档' })
  return { store, docs, memory, proj, inProject: inProject.id, loose: loose.id }
}

describe('记忆：敏感内容守卫', () => {
  it('患者可识别信息与账号拦下，去标识的写法放行', () => {
    for (const bad of ['患者王某某，男，65岁，心衰', '住院号：20250312', '联系电话 13812345678', '身份证 110101199003071234', 'MRN 448812', '姓名：李四', '家庭住址：北京市海淀区中关村']) {
      expect(sensitiveReason(bad), bad).not.toBeNull()
    }
    for (const ok of ['数值保留两位小数', '本院伦理批号 2025-KY-031', '病例描述用「患者，男，60 余岁」这样的去标识写法', '统计软件用 R 4.3', '患者入组标准写在方法第一段']) {
      expect(sensitiveReason(ok), ok).toBeNull()
    }
  })
})

describe('记忆：提议、确认与去重', () => {
  it('AI 提议进待确认；用户明确要求直接生效；同一条合并；拒绝过的不再提议（除非明确要求）', async () => {
    const t = env()
    const p = await t.memory.propose('u1', { content: '数值保留两位小数', kind: 'preference', scope: 'global' }, { ...ai, docId: t.loose })
    expect([p.result, p.memory.status, p.memory.source_doc_id]).toEqual(['proposed', 'proposed', t.loose])
    expect((await t.memory.propose('u1', { content: '数值保留 两位小数。', kind: 'preference', scope: 'global' }, ai)).result).toBe('merged')

    await t.memory.edit('u1', p.memory.id, { status: 'rejected' })
    expect((await t.memory.propose('u1', { content: '数值保留两位小数', kind: 'preference', scope: 'global' }, ai)).result).toBe('previously_rejected')
    const again = await t.memory.propose('u1', { content: '数值保留两位小数', kind: 'preference', scope: 'global', explicit: true }, ai)
    expect([again.result, again.memory.status]).toEqual(['merged', 'active'])

    const direct = await t.memory.propose('u1', { content: '统计软件用 R', kind: 'fact', scope: 'global', explicit: true }, ai)
    expect(direct.result).toBe('active')
    expect(t.store.memoryEvents(direct.memory.id).map(e => e.action)).toEqual(['create'])
    await expect(t.memory.propose('u1', { content: '住院号：20250312', kind: 'fact', scope: 'global', explicit: true }, ai)).rejects.toMatchObject({ code: 'sensitive_content' })
  })

  it('项目记忆只对项目里的文档生效；不在项目里的文档不能存项目记忆', async () => {
    const t = env()
    await t.memory.propose('u1', { content: '本项目的主要终点叫 MACE-3', kind: 'term', scope: 'project', explicit: true }, { ...ai, docId: t.inProject })
    await t.memory.propose('u1', { content: '数值保留两位小数', kind: 'preference', scope: 'global', explicit: true }, ai)
    expect(t.memory.applicable('u1', t.inProject).map(m => m.content).sort()).toEqual(['数值保留两位小数', '本项目的主要终点叫 MACE-3'].sort())
    expect(t.memory.applicable('u1', t.loose).map(m => m.content)).toEqual(['数值保留两位小数'])
    await expect(t.memory.propose('u1', { content: '别的', kind: 'term', scope: 'project' }, { ...ai, docId: t.loose })).rejects.toBeInstanceOf(MemoryError)
    expect(t.memory.applicable('u2', t.inProject)).toEqual([]) // 别人的
  })
})

describe('记忆：三层开关与注入', () => {
  function turnEnv() {
    const t = env()
    const prompts: string[] = []
    const pool = { liveSession: () => 's', run: async (_u: string, prompt: string) => { prompts.push(prompt); return { finalResponse: 'ok' } }, cancel: async () => {} } as unknown as HarnessPool
    const registry = new TurnRegistry()
    const turns = new TurnService(t.docs, pool, registry, { memory: t.memory })
    return { ...t, prompts, turns }
  }

  it('回合开头注入已生效的记忆；本轮不用记忆 / 暂停 / 管理员停用时不注入', async () => {
    const t = turnEnv()
    await t.memory.propose('u1', { content: '数值保留两位小数', kind: 'preference', scope: 'global', explicit: true }, ai)
    await t.memory.propose('u1', { content: '待确认的不注入', kind: 'preference', scope: 'global' }, ai)
    await t.turns.submit('u1', t.loose, '写结果段')
    expect(t.prompts[0]).toContain('［记忆］')
    expect(t.prompts[0]).toContain('[偏好] 数值保留两位小数')
    expect(t.prompts[0]).not.toContain('待确认的不注入')

    await t.turns.submit('u1', t.loose, '写结果段', undefined, { memory: false })
    expect(t.prompts[1]).not.toContain('［记忆］')
    expect(t.prompts[1]).toContain('关闭了记忆')

    t.memory.setPaused('u1', true)
    await t.turns.submit('u1', t.loose, '写结果段')
    expect(t.prompts[2]).not.toContain('［记忆］')
    await expect(t.memory.propose('u1', { content: '新的', kind: 'preference', scope: 'global' }, ai)).rejects.toMatchObject({ code: 'memory_paused' })
    t.memory.setPaused('u1', false)
    expect(t.store.listMemories('u1').length).toBe(2) // 暂停保留已有记忆

    expect(t.memory.setInstanceEnabled(false)).toBe(2) // 停用即删除
    await t.turns.submit('u1', t.loose, '写结果段')
    expect(t.prompts[3]).not.toContain('［记忆］')
    expect(t.store.listMemories('u1')).toEqual([])
  })

  it('超出预算时只注入放得下的；导出 / 导入（导入进待确认，敏感与重复跳过）', async () => {
    const t = env()
    for (let i = 0; i < 30; i++) await t.memory.propose('u1', { content: `第 ${i} 条偏好：${'很长的说明'.repeat(10)}`, kind: 'preference', scope: 'global', explicit: true }, ai)
    const block = await t.memory.forPrompt('u1', t.loose, '写', 600)
    expect(block.length).toBeLessThan(800)
    expect(block.split('\n- ').length).toBeGreaterThan(2)

    const exported = t.memory.exportAll('u1')
    expect(exported.length).toBe(30)
    const r = await t.memory.importItems('u2', [{ content: '术语统一用「心衰」', kind: 'term' }, { content: '术语统一用「心衰」' }, { content: '手机 13812345678' }])
    expect(r.added).toBe(1)
    expect(r.skipped.map(s => s.reason)).toEqual(['已有相同的记忆', expect.stringContaining('手机号')])
    expect(t.store.listMemories('u2')[0]!.status).toBe('proposed')
  })
})

describe('记忆：忘掉', () => {
  it('唯一命中彻底删除；多条相近返回候选，按 ids 删；没有返回 not_found；暂停时也能忘', async () => {
    const t = env()
    const a = await t.memory.propose('u1', { content: '文档中的百分比一律保留两位小数，例如 6.50%', kind: 'preference', scope: 'global', explicit: true }, ai)
    await t.memory.propose('u1', { content: '表格标题放在表格上方', kind: 'style', scope: 'global', explicit: true }, ai)
    await t.memory.propose('u1', { content: '表格标题用中文', kind: 'style', scope: 'global', explicit: true }, ai)
    t.memory.setPaused('u1', true)
    const r = await t.memory.forget('u1', '百分比两位小数那条')
    expect(r).toMatchObject({ result: 'forgotten', memories: [{ id: a.memory.id }] })
    expect(t.store.getMemory(a.memory.id)).toBeUndefined()

    const amb = await t.memory.forget('u1', '表格标题')
    expect(amb.result).toBe('ambiguous')
    const ids = amb.result === 'ambiguous' ? amb.candidates.map(m => m.id) : []
    expect(ids.length).toBe(2)
    expect((await t.memory.forget('u1', '表格标题', ids)).result).toBe('forgotten')
    expect(t.store.listMemories('u1')).toEqual([])
    expect((await t.memory.forget('u1', '不存在的东西')).result).toBe('not_found')
    expect((await t.memory.forget('u2', '百分比', ids)).result).toBe('not_found') // 不能删别人的
  })
})

