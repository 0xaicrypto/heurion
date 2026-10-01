import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { buildProjection, ensureDocxParaIds } from '../src/docs/office.ts'
import { mergeAiOpsOntoHead } from '../src/docs/merge.ts'

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const W14 = 'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"'
const p = (t: string, id: string) => `<w:p w14:paraId="${id}"><w:r><w:t>${t}</w:t></w:r></w:p>`
const docxOf = (paras: string[]) =>
  zipSync({ 'word/document.xml': strToU8(`<?xml version="1.0"?><w:document ${W} ${W14}><w:body>${paras.join('')}</w:body></w:document>`) })
const textOf = (bytes: Uint8Array) =>
  strFromU8(unzipSync(bytes)['word/document.xml']!).replace(/<[^>]+>/g, '').replace(/\s+/g, '|')

const IDS = { A: 'AAAAAAAA', B: 'BBBBBBBB', C: 'CCCCCCCC', D: 'DDDDDDDD', E: 'EEEEEEEE' }

function make(baseParas: string[], aiParas: string[], userParas: string[]) {
  const baseBytes = docxOf(baseParas)
  const baseProj = buildProjection('docx', baseBytes)
  const aiBytes = docxOf(aiParas)
  const aiProj = buildProjection('docx', aiBytes)
  const headBytes = docxOf(userParas)
  const headProj = buildProjection('docx', headBytes)
  return { baseProj, aiBytes, aiProj, headBytes, headProj }
}

describe('三方合并（AI 变更重放到用户 head，用户优先）', () => {
  it('异节点：AI 改 A、用户改 C → 双方都保留', () => {
    const base = [p('甲', IDS.A), p('乙', IDS.B), p('丙', IDS.C)]
    const ai = [p('甲-AI修改', IDS.A), p('乙', IDS.B), p('丙', IDS.C)]
    const user = [p('甲', IDS.A), p('乙', IDS.B), p('丙-用户改', IDS.C)]
    const r = mergeAiOpsOntoHead(make(base, ai, user))
    const merged = textOf(r.bytes)
    expect(merged).toContain('甲-AI修改')
    expect(merged).toContain('丙-用户改')
    expect(merged).toContain('乙')
    expect(r.applied.map(a => a.kind)).toEqual(['modified'])
    expect(r.overridden).toEqual([])
  })

  it('同节点冲突：AI 改 B、用户也改 B → 用户版本生效，AI 改动进 overridden', () => {
    const base = [p('甲', IDS.A), p('乙原文', IDS.B), p('丙', IDS.C)]
    const ai = [p('甲', IDS.A), p('乙-AI版本', IDS.B), p('丙', IDS.C)]
    const user = [p('甲', IDS.A), p('乙-用户版本', IDS.B), p('丙', IDS.C)]
    const r = mergeAiOpsOntoHead(make(base, ai, user))
    const merged = textOf(r.bytes)
    expect(merged).toContain('乙-用户版本')
    expect(merged).not.toContain('乙-AI版本')
    expect(r.overridden).toEqual([{ id: IDS.B, text: '乙-AI版本' }])
    expect(r.applied).toEqual([])
  })

  it('AI 新增 D（锚定在前兄弟）；用户新增 E → 都在，顺序正确', () => {
    const base = [p('甲', IDS.A), p('乙', IDS.B)]
    const ai = [p('甲', IDS.A), p('乙', IDS.B), p('AI新增', IDS.D)]
    const user = [p('甲', IDS.A), p('用户新增', IDS.E), p('乙', IDS.B)]
    const r = mergeAiOpsOntoHead(make(base, ai, user))
    const merged = textOf(r.bytes)
    expect(merged).toContain('AI新增')
    expect(merged).toContain('用户新增')
    // AI 新增在乙之后（D 锚定到 B）
    const xml = strFromU8(unzipSync(r.bytes)['word/document.xml']!)
    expect(xml.indexOf('AI新增')).toBeGreaterThan(xml.indexOf('>乙<'))
    expect(r.applied.some(a => a.kind === 'added' && a.id === IDS.D)).toBe(true)
  })

  it('AI 删除的节点：head 还有 → 删；用户已删 → no-op', () => {
    const base = [p('甲', IDS.A), p('乙', IDS.B), p('丙', IDS.C)]
    const ai = [p('甲', IDS.A), p('丙', IDS.C)] // AI 删了乙
    const user = [p('甲', IDS.A), p('乙', IDS.B), p('丙', IDS.C)]
    const r = mergeAiOpsOntoHead(make(base, ai, user))
    expect(textOf(r.bytes)).not.toContain('乙')
    expect(r.applied.some(a => a.kind === 'removed' && a.id === IDS.B)).toBe(true)
  })

  it('用户整段重写（换新 id）→ AI 对旧 id 的修改按用户赢丢弃', () => {
    const base = [p('甲', IDS.A), p('乙原文', IDS.B)]
    const ai = [p('甲', IDS.A), p('乙-AI版本', IDS.B)]
    // 用户用 Collabora 重写了乙（新 id E）
    const user = [p('甲', IDS.A), p('乙-用户版本', IDS.E)]
    const r = mergeAiOpsOntoHead(make(base, ai, user))
    const merged = textOf(r.bytes)
    expect(merged).toContain('乙-用户版本')
    expect(merged).not.toContain('乙-AI版本')
    expect(r.overridden).toEqual([{ id: IDS.B, text: '乙-AI版本' }])
  })

  it('AI 没动任何节点 → 返回的 bytes 即 head（快照层去重，不落空版本）', () => {
    const base = [p('甲', IDS.A), p('乙', IDS.B)]
    const ai = base
    const user = [p('甲', IDS.A), p('乙', IDS.B)]
    const r = mergeAiOpsOntoHead(make(base, ai, user))
    expect(r.applied).toEqual([])
    expect(r.overridden).toEqual([])
    expect(r.bytes).toEqual(docxOf(user))
  })
})
