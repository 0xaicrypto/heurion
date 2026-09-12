import { describe, it, expect } from 'vitest'
import { mergeThreeWay, describeConflictSections } from './doc-merge'

/**
 * #837 — AI 写回三路合并。
 * 生产事故:审阅未决时 AI 基于旧正文又写回一轮;用户接受上一轮后直接
 * diff「当前正文 → 新写回」会把已接受的修改反转回去(顺序乱)。
 */
describe('mergeThreeWay', () => {
  const base = ['# Title', 'para one', 'para two', 'para three'].join('\n')

  it('基线相同(用户放弃上一轮)→ 直接采用新写回', () => {
    const theirs = base.replace('para two', 'para two rewritten')
    expect(mergeThreeWay(base, base, theirs)).toBe(theirs)
  })

  it('无重叠改动 → 两轮修改都保留(接受上一轮后重放下一轮)', () => {
    // ours: 用户接受了上一轮对 para one 的修改
    const ours = base.replace('para one', 'para one polished')
    // theirs: AI 基于旧基线又改了 para three(与 para one 不重叠)
    const theirs = base.replace('para three', 'para three expanded')
    const merged = mergeThreeWay(base, ours, theirs)
    expect(merged).toContain('para one polished')
    expect(merged).toContain('para three expanded')
    expect(merged).toContain('para two')
  })

  it('同一区域被双方修改 → 冲突返回 null(由调用方丢弃并提示)', () => {
    const ours = base.replace('para two', 'para two accepted')
    const theirs = base.replace('para two', 'para two from-second-round')
    expect(mergeThreeWay(base, ours, theirs)).toBeNull()
  })

  // #986: 同一锚位双方各自插入(相邻/零宽 hunk)— 旧逻辑按 sort 偶然顺序
  // 静默合并(AI 编辑与手动保存改到同一段边界的产品实例),现在必须判冲突。
  it('同一锚位双方各自插入(零宽 hunk)→ 冲突返回 null', () => {
    const ours = ['# Title', 'para one', 'inserted by user', 'para two', 'para three'].join('\n')
    const theirs = ['# Title', 'para one', 'inserted by ai', 'para two', 'para three'].join('\n')
    expect(mergeThreeWay(base, ours, theirs)).toBeNull()
  })

  it('相邻行各自修改(不同 base 行)仍可合并(逐段追加/尾部换行依赖)', () => {
    const lines = base.split('\n')
    // ours 改第 2 行,theirs 改第 3 行 — 触及不同 base 行,可安全合并。
    const ours = [...lines.slice(0, 1), 'para one polished', ...lines.slice(2)].join('\n')
    const theirs = [...lines.slice(0, 2), 'para two rewritten', ...lines.slice(3)].join('\n')
    const merged = mergeThreeWay(base, ours, theirs)
    expect(merged).toContain('para one polished')
    expect(merged).toContain('para two rewritten')
  })

  it('相邻段落(不重叠)可合并', () => {
    const lines = base.split('\n')
    const ours = [...lines.slice(0, 2), 'inserted by round1', ...lines.slice(2)].join('\n')
    const theirs = base.replace('para three', 'para three v2')
    const merged = mergeThreeWay(base, ours, theirs)
    expect(merged).toContain('inserted by round1')
    expect(merged).toContain('para three v2')
  })

  it('双方在末尾各自追加 → 都保留', () => {
    const ours = `${base}\n\n## Appendix A`
    const theirs = `${base}\n\n## Section X`
    const merged = mergeThreeWay(base, ours, theirs)
    expect(merged).toContain('## Appendix A')
    expect(merged).toContain('## Section X')
  })

  it('带标题结构的 markdown 写回(生产样本形态)合并后 heading 保留', () => {
    const base = ['# 论文', '', '## Introduction', 'intro text'].join('\n')
    const ours = base.replace('intro text', 'intro text polished')
    const theirs = ['# 论文', '', '## Introduction', 'intro text', '', '## Methods', '### Cohort', '- n=120', '- 随访 24 个月'].join('\n')
    const merged = mergeThreeWay(base, ours, theirs)
    expect(merged).toContain('intro text polished')
    expect(merged).toContain('## Methods')
    expect(merged).toContain('### Cohort')
    expect(merged).toContain('- n=120')
  })

  it('尾部换行保留', () => {
    const base = 'a\nb\n'
    const ours = 'a\nB\n'
    const theirs = 'a\nb\nc\n'
    const merged = mergeThreeWay(base, ours, theirs)
    expect(merged).toBe('a\nB\nc\n')
  })

  it('空基线(用户从空文档开始)→ 直接采用新写回', () => {
    expect(mergeThreeWay('', '', '# New doc\ncontent')).toBe('# New doc\ncontent')
  })
})

/** #989 Phase 3: 块级冲突归属 — 冲突 hunk 归属到最近标题节。 */
describe('describeConflictSections', () => {
  const base = ['# Title', 'para one', '', '## Methods', 'methods text', '', '## Results', 'results text'].join('\n')

  it('冲突 hunk 归属最近标题节(同节双方修改)', () => {
    const ours = base.replace('methods text', 'methods user edit')
    const theirs = base.replace('methods text', 'methods ai edit')
    expect(describeConflictSections(base, ours, theirs)).toEqual(['Methods'])
  })

  it('多节冲突 → 去重后的节名列表', () => {
    const ours = base.replace('methods text', 'm1').replace('results text', 'r1')
    const theirs = base.replace('methods text', 'm2').replace('results text', 'r2')
    const sections = describeConflictSections(base, ours, theirs)
    expect(sections).toEqual(['Methods', 'Results'])
  })

  it('首标题前冲突归属文档头标题(H1)', () => {
    const ours = base.replace('para one', 'p1')
    const theirs = base.replace('para one', 'p2')
    expect(describeConflictSections(base, ours, theirs)).toEqual(['Title'])
  })

  it('无冲突(不相交 hunk)→ 空列表', () => {
    const ours = base.replace('methods text', 'm1')
    const theirs = base.replace('results text', 'r2')
    expect(describeConflictSections(base, ours, theirs)).toEqual([])
  })
})
