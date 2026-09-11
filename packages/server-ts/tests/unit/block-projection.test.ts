import { describe, test, expect } from 'vitest'
import { buildBlockProjection, withSectionIds, applySectionEdit, loadProjection, hash12 } from '../../src/lib/block-projection.js'
import { blockProjectionSchema } from '@heurion/contracts'

/**
 * #989 Phase 1 — 投影与 body 强一致走查（验证标准）：
 *  1. 任意 span 走查 body.slice(start,end) 还原原文；
 *  2. ID 在无关编辑后保持稳定；
 *  3. 契约形状（blockProjectionSchema safeParse）。
 */
const DOC = [
  '# Paper Title',
  '',
  'Opening paragraph before any heading.',
  '',
  '## Introduction',
  'intro text with **bold** marker.',
  '',
  '- point one',
  '- point two',
  '',
  '## Methods',
  '### Cohort',
  'n=120 patients.',
  '',
  '| arm | n |',
  '|---|---|',
  '| control | 60 |',
  '',
  '![Fig 1](/files/chart.svg)',
  '',
  '```bash',
  'echo hello',
  '```',
  '',
  '## Results',
  'PFS improved.',
].join('\n')

describe('#989 投影构建 — 节/块分类与 span 走查', () => {
  const proj = buildBlockProjection(DOC)

  test('契约形状 safeParse 通过', () => {
    const check = blockProjectionSchema.safeParse(proj)
    expect(check.success).toBe(true)
    expect(proj.schema_version).toBe(1)
    expect(proj.body_hash).toHaveLength(12)
  })

  test('节节点:H1/H2/H3 全收集,标题与层级正确', () => {
    const sections = proj.nodes.filter((n) => n.kind === 'section')
    expect(sections.map((s) => s.heading)).toEqual(['Paper Title', 'Introduction', 'Methods', 'Cohort', 'Results'])
    expect(sections.map((s) => s.level)).toEqual([1, 2, 2, 3, 2])
    // 所有 section 无 block_type
    expect(sections.every((s) => s.block_type === undefined)).toBe(true)
  })

  test('块分类:段落/列表/表格/图片/代码', () => {
    const blocks = proj.nodes.filter((n) => n.kind === 'block')
    const byType = (t: string) => blocks.filter((b) => b.block_type === t)
    expect(byType('paragraph').length).toBeGreaterThanOrEqual(4)
    expect(byType('list')).toHaveLength(1)
    expect(byType('table')).toHaveLength(1)
    expect(byType('image')).toHaveLength(1)
    expect(byType('code')).toHaveLength(1)
  })

  test('span 走查:slice 还原原文(强一致不变量)', () => {
    for (const n of proj.nodes) {
      const raw = DOC.slice(n.start, n.end)
      expect(raw.length).toBeGreaterThan(0)
      // 节 span 以标题行开头;块 span 还原其内容
      if (n.kind === 'section') expect(raw).toContain(n.heading!)
      if (n.kind === 'block' && n.block_type === 'table') expect(raw).toContain('| arm | n |')
      if (n.kind === 'block' && n.block_type === 'image') expect(raw).toContain('![Fig 1]')
      if (n.kind === 'block' && n.block_type === 'code') expect(raw).toContain('echo hello')
      if (n.kind === 'block' && n.block_type === 'list') expect(raw).toContain('- point one')
    }
    // 精确区间还原 — Methods 节的 Cohort 子节
    const cohort = proj.nodes.find((n) => n.kind === 'section' && n.heading === 'Cohort')!
    expect(DOC.slice(cohort.start, cohort.end)).toContain('n=120 patients.')
  })

  test('块挂所属节(parent_id);首个标题之前的块 parent 为 null', () => {
    const intro = proj.nodes.find((n) => n.kind === 'section' && n.heading === 'Introduction')!
    const list = proj.nodes.find((n) => n.kind === 'block' && n.block_type === 'list')!
    expect(list.parent_id).toBe(intro.id)
    // 主文档以 H1 标题行开头 — opening 段落属于 H1 节('Paper Title')
    const title = proj.nodes.find((n) => n.kind === 'section' && n.heading === 'Paper Title')!
    const opening = proj.nodes.find((n) => n.kind === 'block' && DOC.slice(n.start, n.end).includes('Opening paragraph'))!
    expect(opening.parent_id).toBe(title.id)
    // 真正的「首标题之前」块 — 首行为正文的文档
    const lead = buildBlockProjection('Lead text before any heading.\n\n## Introduction\nintro body')
    const leadBlock = lead.nodes.find((n) => n.kind === 'block')!
    expect(leadBlock.parent_id).toBeNull()
  })

  test('确定性:同输入同输出', () => {
    expect(buildBlockProjection(DOC)).toEqual(proj)
  })
})

describe('#989 ID 稳定性(验证标准:无关编辑后保持稳定)', () => {
  test('其他节内容修改 → 本节 ID 不变(hash 变更检测)', () => {
    const before = buildBlockProjection(DOC)
    const edited = DOC.replace('PFS improved.', 'PFS improved substantially with HR 0.7.')
    const after = buildBlockProjection(edited)
    const introBefore = before.nodes.find((n) => n.kind === 'section' && n.heading === 'Introduction')!
    const introAfter = after.nodes.find((n) => n.kind === 'section' && n.heading === 'Introduction')!
    expect(introAfter.id).toBe(introBefore.id)
    // Methods 节 id 也不变(改的是 Results)
    const methodsAfter = after.nodes.find((n) => n.kind === 'section' && n.heading === 'Methods')!
    const methodsBefore = before.nodes.find((n) => n.kind === 'section' && n.heading === 'Methods')!
    expect(methodsAfter.id).toBe(methodsBefore.id)
  })

  test('文末追加段落 → 既有节/块 ID 全部不变', () => {
    const before = buildBlockProjection(DOC)
    const after = buildBlockProjection(`${DOC}\n\nAppended closing paragraph.`)
    for (const n of before.nodes) {
      if (n.kind === 'block' && DOC.slice(n.start, n.end).includes('Appended')) continue
      const matched = after.nodes.find((m) => m.id === n.id)
      expect(matched, `ID 丢失: ${n.id}`).toBeTruthy()
    }
  })

  test('改标题 → 仅该节 ID 失效,其余节稳定', () => {
    const before = buildBlockProjection(DOC)
    const after = buildBlockProjection(DOC.replace('## Introduction', '## Background'))
    const beforeIntro = before.nodes.find((n) => n.kind === 'section' && n.heading === 'Introduction')!
    const afterIntro = after.nodes.find((n) => n.kind === 'section' && n.heading === 'Background')!
    expect(afterIntro).toBeTruthy()
    expect(after.nodes.find((n) => n.id === beforeIntro.id)).toBeUndefined()
    const methodsBefore = before.nodes.find((n) => n.kind === 'section' && n.heading === 'Methods')!
    expect(after.nodes.find((n) => n.id === methodsBefore.id)).toBeTruthy()
  })

  test('空白/markdown 强调差异不影响 ID(无关编辑形态)', () => {
    const a = buildBlockProjection('## Intro\nsome text')
    const b = buildBlockProjection('##  Intro\nsome   text')
    const aSec = a.nodes.find((n) => n.kind === 'section')!
    const bSec = b.nodes.find((n) => n.kind === 'section')!
    expect(aSec.id).toBe(bSec.id)
    // 加粗标记不影响
    const c = buildBlockProjection('## Intro\nsome **text**')
    const cSec = c.nodes.find((n) => n.kind === 'section')!
    expect(cSec.id).toBe(aSec.id)
  })
})

describe('#989 边界:无标题文档/空文档/同名标题', () => {
  test('无标题长文 → 全部块 parent_id=null,无 section 节点', () => {
    const proj = buildBlockProjection('para one\n\npara two')
    expect(proj.nodes.filter((n) => n.kind === 'section')).toHaveLength(0)
    const blocks = proj.nodes.filter((n) => n.kind === 'block')
    expect(blocks).toHaveLength(2)
    expect(blocks.every((b) => b.parent_id === null)).toBe(true)
  })

  test('空文档 → 空投影(合法)', () => {
    const proj = buildBlockProjection('')
    expect(proj.nodes).toHaveLength(0)
    expect(proj.body_hash).toBe(hash12(''))
    expect(blockProjectionSchema.safeParse(proj).success).toBe(true)
  })

  test('同名标题 → 序号消歧(确定性)', () => {
    const doc = '## Notes\nfirst\n\n## Notes\nsecond'
    const proj = buildBlockProjection(doc)
    const sections = proj.nodes.filter((n) => n.kind === 'section')
    expect(sections).toHaveLength(2)
    expect(sections[0].id).not.toBe(sections[1].id)
    expect(sections[1].id).toContain('_2')
    // 再建一次同序号(确定性)
    expect(buildBlockProjection(doc)).toEqual(proj)
  })

  test('重复内容块 → 序号消歧', () => {
    const proj = buildBlockProjection('## A\nsame line\n\n## B\nsame line')
    const same = proj.nodes.filter((n) => n.kind === 'block')
    expect(same).toHaveLength(2)
    expect(same[0].id).not.toBe(same[1].id)
    expect(same[1].id).toContain('_2')
  })
})

// ─────────────────────────────────────────────────────────────────────────
// #989 Phase 2 — 编辑引用模式:ID 挂标题行 + 确定性节编辑。
// ─────────────────────────────────────────────────────────────────────────
describe('#989 Phase 2 — withSectionIds(标题行挂 ID)', () => {
  test('heading 行插入 [sec:<id>] marker,正文行不动', () => {
    const proj = buildBlockProjection(DOC)
    const withIds = withSectionIds(DOC, proj)
    const intro = proj.nodes.find((n) => n.kind === 'section' && n.heading === 'Introduction')!
    expect(withIds).toContain(`## [sec:${intro.id}] Introduction`)
    // 原正文行不受影响
    expect(withIds).toContain('intro text with **bold** marker.')
    // 非标题行无 marker
    expect(withIds).not.toContain('point one [sec:')
  })

  test('同名标题按出现序消费(与构建器一致)', () => {
    const doc = '## Notes\nfirst\n\n## Notes\nsecond'
    const proj = buildBlockProjection(doc)
    const sections = proj.nodes.filter((n) => n.kind === 'section')
    const withIds = withSectionIds(doc, proj)
    expect(withIds).toContain(`## [sec:${sections[0].id}] Notes`)
    expect(withIds).toContain(`## [sec:${sections[1].id}] Notes`)
  })

  test('截断文本中丢失的标题不挂 marker(头部截断形态)', () => {
    const proj = buildBlockProjection(DOC)
    const truncated = DOC.split('\n').slice(10).join('\n') // 丢前 10 行
    const withIds = withSectionIds(truncated, proj)
    // 存活的标题行仍可挂;前面的 heading 文本不在截断内,queue 未消费不会错位
    expect(withIds).toContain('## [sec:')
  })

  test('无投影 → 原文返回', () => {
    expect(withSectionIds('## A\nx', { schema_version: 1, body_hash: '', nodes: [] })).toBe('## A\nx')
  })
})

describe('#989 Phase 2 — applySectionEdit(确定性节编辑)', () => {
  test('replace:整节内容替换,前后节不动,round-trip 一致', () => {
    const proj = buildBlockProjection(DOC)
    const intro = proj.nodes.find((n) => n.kind === 'section' && n.heading === 'Introduction')!
    const r = applySectionEdit(DOC, proj, intro.id, 'replace', 'brand new intro content')
    expect('error' in r && r.error).toBeFalsy()
    if ('error' in r) return
    expect(r.body).toContain('brand new intro content')
    expect(r.body).not.toContain('intro text with **bold** marker.')
    // 前后节保持
    expect(r.body).toContain('# Paper Title')
    expect(r.body).toContain('## Methods')
    // 新 body 的投影可重建且 Introduction 节 id 不变(标题未动)
    const after = buildBlockProjection(r.body)
    const introAfter = after.nodes.find((n) => n.kind === 'section' && n.heading === 'Introduction')!
    expect(introAfter.id).toBe(intro.id)
  })

  test('append:节内容末尾追加', () => {
    const proj = buildBlockProjection(DOC)
    const intro = proj.nodes.find((n) => n.kind === 'section' && n.heading === 'Introduction')!
    const r = applySectionEdit(DOC, proj, intro.id, 'append', 'Appended sentence.')
    if ('error' in r) return expect.unreachable(r.error)
    expect(r.body).toContain('intro text with **bold** marker.')
    expect(r.body).toContain('Appended sentence.')
    // 追加内容位于 Introduction 与 Methods 之间
    expect(r.body.indexOf('Appended sentence.')).toBeGreaterThan(r.body.indexOf('intro text'))
    expect(r.body.indexOf('Appended sentence.')).toBeLessThan(r.body.indexOf('## Methods'))
  })

  test('prepend:标题行之后插入', () => {
    const proj = buildBlockProjection(DOC)
    const methods = proj.nodes.find((n) => n.kind === 'section' && n.heading === 'Methods')!
    const r = applySectionEdit(DOC, proj, methods.id, 'prepend', 'Overview paragraph first.')
    if ('error' in r) return expect.unreachable(r.error)
    expect(r.body).toContain('Overview paragraph first.')
    expect(r.body.indexOf('Overview paragraph first.')).toBeGreaterThan(r.body.indexOf('## Methods'))
    expect(r.body.indexOf('Overview paragraph first.')).toBeLessThan(r.body.indexOf('### Cohort'))
    expect(r.body).toContain('n=120 patients.')
  })

  test('ID 失效(文档重构后旧 id)→ error 引导降级锚点', () => {
    const proj = buildBlockProjection(DOC)
    const r = applySectionEdit(DOC, proj, 's_nonexistent0000', 'replace', 'x')
    expect('error' in r && r.error).toBeTruthy()
    if ('error' in r) expect(r.error).toContain('锚点')
  })

  test('空 content → error', () => {
    const proj = buildBlockProjection(DOC)
    const intro = proj.nodes.find((n) => n.kind === 'section' && n.heading === 'Introduction')!
    const r = applySectionEdit(DOC, proj, intro.id, 'replace', '   ')
    expect('error' in r && r.error).toBeTruthy()
  })

  test('loadProjection:stored 与 body 一致 → 用 stored;不一致 → 重建(确定性)', () => {
    const proj = buildBlockProjection(DOC)
    const stored = JSON.stringify(proj)
    expect(loadProjection(DOC, stored)).toEqual(proj)
    // 过期(stored 是别的 body 的投影)→ 重建
    const stale = JSON.stringify(buildBlockProjection('other body'))
    expect(loadProjection(DOC, stale)).toEqual(proj)
    // 损坏 → 重建
    expect(loadProjection(DOC, '{broken')).toEqual(proj)
    expect(loadProjection(DOC, null)).toEqual(proj)
    expect(loadProjection(DOC, undefined)).toEqual(proj)
  })

  test('section 编辑后的新投影:被编辑节标题 id 不变,块 id 更新(Phase 2 闭环)', () => {
    const proj = buildBlockProjection(DOC)
    const intro = proj.nodes.find((n) => n.kind === 'section' && n.heading === 'Introduction')!
    const listBefore = proj.nodes.find((n) => n.kind === 'block' && n.block_type === 'list')!
    const r = applySectionEdit(DOC, proj, intro.id, 'replace', 'Fully rewritten intro body.')
    if ('error' in r) return expect.unreachable(r.error)
    const after = buildBlockProjection(r.body)
    const introAfter = after.nodes.find((n) => n.kind === 'section' && n.heading === 'Introduction')!
    expect(introAfter.id).toBe(intro.id)
    // 旧 list 块被替换掉 — id 消失
    expect(after.nodes.find((n) => n.id === listBefore.id)).toBeUndefined()
  })
})
