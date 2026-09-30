import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { Store } from '../src/db.ts'
import { computeIdSurvival, docxProjection, ensureDocxParaIds, pptxProjection } from '../src/docs/office.ts'
import { DocFiles } from '../src/docs/workspace.ts'

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const W14 = 'http://schemas.microsoft.com/office/word/2010/wordml'

const docxXml = (body: string, opts: { w14?: boolean } = {}) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<w:document ${W_NS}${opts.w14 === false ? '' : ` xmlns:w14="${W14}"`}>` +
  `<w:body>${body}</w:body></w:document>`

const p = (text: string, o: { id?: string; style?: string; numPr?: boolean } = {}) => {
  const id = o.id ? ` w14:paraId="${o.id}"` : ''
  const props = `${o.style ? `<w:pStyle w:val="${o.style}"/>` : ''}${o.numPr ? '<w:numPr/>' : ''}`
  const style = props ? `<w:pPr>${props}</w:pPr>` : ''
  return `<w:p${id}>${style}<w:r><w:t>${text}</w:t></w:r></w:p>`
}

const asDocx = (xml: string) => zipSync({ 'word/document.xml': strToU8(xml) })

describe('ensureDocxParaIds', () => {
  it('为缺失的段落分配 paraId，已有 id 与其余字节原样保留', () => {
    const xml = docxXml(p('一', { id: 'AAAA0001' }) + p('二') + p('三'))
    const r = ensureDocxParaIds(asDocx(xml))
    expect(r.stats).toEqual({ assigned: 2, reassigned: 0 })
    const out = strFromU8(unzipSync(r.bytes)['word/document.xml']!)
    expect(out).toContain('w14:paraId="AAAA0001"')
    const ids = [...out.matchAll(/w14:paraId="([0-9A-F]+)"/g)].map(m => m[1])
    expect(ids).toHaveLength(3)
    expect(new Set(ids).size).toBe(3)
    // 除新增/改写的 id 属性外内容不变（两侧都剥掉 id 属性再比）
    expect(out.replaceAll(/ w14:paraId="[0-9A-Fa-f]+"/g, '')).toBe(xml.replaceAll(/ w14:paraId="[0-9A-Fa-f]+"/g, ''))
  })

  it('缺 w14 命名空间时补声明；自闭合 <w:p/> 也能挂 id', () => {
    const xml = docxXml(p('甲') + '<w:p/>', { w14: false })
    const r = ensureDocxParaIds(asDocx(xml))
    const out = strFromU8(unzipSync(r.bytes)['word/document.xml']!)
    expect(out).toContain(`xmlns:w14="${W14}"`)
    expect(out).toContain('w14:paraId=')
    expect(r.stats.assigned).toBe(2)
  })

  it('重复 id：首现保留、后续重分配', () => {
    const xml = docxXml(p('a', { id: 'BBBB0001' }) + p('b', { id: 'BBBB0001' }) + p('c', { id: 'bbbb0001' }))
    const r = ensureDocxParaIds(asDocx(xml))
    expect(r.stats).toEqual({ assigned: 0, reassigned: 2 })
    const ids = [...strFromU8(unzipSync(r.bytes)['word/document.xml']!).matchAll(/w14:paraId="([0-9A-F]+)"/g)].map(m => m[1]!.toUpperCase())
    expect(new Set(ids).size).toBe(3)
  })

  it('幂等：跑第二遍不再变更（原地编辑场景 id 100% 保留）', () => {
    const xml = docxXml(p('一') + p('二') + p('三'))
    const once = ensureDocxParaIds(asDocx(xml))
    const twice = ensureDocxParaIds(once.bytes)
    expect(twice.stats).toEqual({ assigned: 0, reassigned: 0 })
    expect(twice.bytes).toEqual(once.bytes)

    // python-docx 式原地编辑：只改一个段落的文本，其余段落 XML 原样 → id 全部保留
    const editedXml = strFromU8(unzipSync(once.bytes)['word/document.xml']!).replace('<w:t>二</w:t>', '<w:t>二改</w:t>')
    const afterEdit = ensureDocxParaIds(asDocx(editedXml))
    expect(afterEdit.stats).toEqual({ assigned: 0, reassigned: 0 })
    const before = [...strFromU8(unzipSync(once.bytes)['word/document.xml']!).matchAll(/w14:paraId="([0-9A-F]+)"/g)].map(m => m[1])
    const after = [...strFromU8(unzipSync(afterEdit.bytes)['word/document.xml']!).matchAll(/w14:paraId="([0-9A-F]+)"/g)].map(m => m[1])
    expect(after).toEqual(before)
  })
})

describe('docxProjection', () => {
  it('标题层级 / 列表 / 段落 / 表格', () => {
    const xml = docxXml(
      p('研究背景', { style: 'Heading1' }) +
      p('方法如下', { style: 'Heading2' }) +
      p('纳入标准一', { numPr: true }) +
      p('普通段落。') +
      `<w:tbl><w:tr><w:tc>${p('A1')}</w:tc><w:tc>${p('B1')}</w:tc></w:tr><w:tr><w:tc>${p('A2')}</w:tc><w:tc>${p('B2')}</w:tc></w:tr></w:tbl>`,
    )
    const nodes = docxProjection(xml)
    expect(nodes).toEqual([
      { id: expect.any(String), kind: 'heading', level: 1, text: '研究背景' },
      { id: expect.any(String), kind: 'heading', level: 2, text: '方法如下' },
      { id: expect.any(String), kind: 'list', text: '纳入标准一' },
      { id: expect.any(String), kind: 'paragraph', text: '普通段落。' },
      { id: expect.stringMatching(/^tbl-\d+$/), kind: 'table', text: 'A1 | B1\nA2 | B2' },
    ])
  })

  it('字段代码（instrText）不污染正文文本', () => {
    const xml = docxXml('<w:p><w:r><w:instrText> SEQ 表 \\* ARABIC </w:instrText></w:r><w:r><w:t>正文</w:t></w:r></w:p>')
    expect(docxProjection(xml)).toEqual([{ id: expect.any(String), kind: 'paragraph', text: '正文' }])
  })
})

describe('pptxProjection', () => {
  const slide = (shapes: string) =>
    `<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ` +
    `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>${shapes}</p:spTree></p:cSld></p:sld>`

  it('形状复合 id、文本、几何；图片归 opaque', () => {
    const s2 = slide(
      `<p:sp><p:nvSpPr><p:cNvPr id="2" name="标题"/><p:cNvSpPr/></p:nvSpPr>` +
      `<p:spPr><a:xfrm rot="16200000"><a:off x="100" y="200"/><a:ext cx="3000" cy="400"/></a:xfrm></p:spPr>` +
      `<p:txBody><a:p><a:r><a:t>主要终点</a:t></a:r></a:p></p:txBody></p:sp>` +
      `<p:pic><p:nvPicPr><p:cNvPr id="5" name="图1"/></p:nvPicPr></p:pic>`,
    )
    const slides = pptxProjection([['ppt/slides/slide2.xml', s2], ['ppt/slides/slide1.xml', slide('')]])
    expect(slides.map(s => s.id)).toEqual(['ppt/slides/slide1.xml', 'ppt/slides/slide2.xml'])
    expect(slides[1]!.index).toBe(2)
    expect(slides[1]!.shapes).toEqual([
      { id: 'ppt/slides/slide2.xml#2', kind: 'paragraph', text: '主要终点', geometry: { x: 100, y: 200, w: 3000, h: 400, rot: 270 } },
      { id: 'ppt/slides/slide2.xml#5', kind: 'opaque', text: '' },
    ])
  })
})

describe('computeIdSurvival', () => {
  it('未变节点 id 全保留 → 1；全部换新 → 0；无上一版 → null', () => {
    const prev = { nodes: [{ id: 'A1', kind: 'paragraph' as const, text: '甲' }, { id: 'A2', kind: 'paragraph' as const, text: '乙' }] }
    const same = { nodes: [{ id: 'A1', kind: 'paragraph' as const, text: '甲' }, { id: 'A2', kind: 'paragraph' as const, text: '乙' }] }
    const changedOne = { nodes: [{ id: 'A1', kind: 'paragraph' as const, text: '甲' }, { id: 'B2', kind: 'paragraph' as const, text: '乙' }] }
    const rewritten = { nodes: [{ id: 'C1', kind: 'paragraph' as const, text: '全新的内容' }] }
    expect(computeIdSurvival(undefined, same)).toBeNull()
    expect(computeIdSurvival(prev, same)).toBe(1)
    expect(computeIdSurvival(prev, changedOne)).toBe(0.5)
    expect(computeIdSurvival(prev, rewritten)).toBe(0)
  })
})

describe('DocFiles × 投影集成', () => {
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'h2-office-'))
    const store = new Store(':memory:')
    const files = new DocFiles(store, join(dir, 'ws'), join(dir, 'versions'))
    return { store, files }
  }

  const body = () => p('研究背景', { style: 'Heading1' }) + p('第一段正文。') + p('第二段正文。')

  it('上传 / AI 回合 / 回滚三种落版都生成投影，存活率写进版本 meta', () => {
    const { store, files } = setup()
    store.createDoc('d', 'Paper', 'docx')

    files.importUpload('d', 'docx', asDocx(docxXml(body())))
    expect(store.getProjection('d', 1)?.projection.nodes).toHaveLength(3)
    expect(store.getVersion('d', 1)?.meta).toBeNull()

    // AI 原地改一段 → 存活率 1.0
    const v1 = strFromU8(unzipSync(files.readVersion('d', 1))['word/document.xml']!)
    const edited = asDocx(v1.replace('第一段正文。', '第一段已修改。'))
    const base = files.materializeHead('d')
    writeWorkspace(files, 'd', edited)
    const v2 = files.snapshotAfterTurn('d', base, '改一段')
    expect(v2?.meta?.id_survival).toBe(1)

    // 整文重写 → 存活率 0
    const base3 = files.materializeHead('d')
    const rewritten = asDocx(docxXml(p('完全不同的新文档')))
    writeWorkspace(files, 'd', rewritten)
    const v3 = files.snapshotAfterTurn('d', base3, '重写')
    expect(v3?.meta?.id_survival).toBe(0)

    // 回滚也落投影（字节同 v1，id 同源）
    const v4 = files.restore('d', 1)
    expect(store.getProjection('d', v4.seq)?.projection.nodes).toHaveLength(3)
    expect(store.getDoc('d')?.head_seq).toBe(4)
  })

  it('cleanWorkspaceScripts 只清脚本，保留权威文件与目录', () => {
    const { store, files } = setup()
    store.createDoc('d', 'Paper', 'docx')
    files.importUpload('d', 'docx', asDocx(docxXml(body())))
    files.materializeHead('d')
    const dir = files.workspaceDir('d')
    writeFileSync(join(dir, 'build_docx.py'), 'print(1)')
    writeFileSync(join(dir, 'run.sh'), 'echo')
    mkdirSync(join(dir, '.venv'))
    writeFileSync(join(dir, '.venv', 'pyvenv.cfg'), '')
    files.cleanWorkspaceScripts('d')
    const names = readdirSync(dir)
    expect(names).toContain('document.docx')
    expect(names).toContain('.venv')
    expect(names).not.toContain('build_docx.py')
    expect(names).not.toContain('run.sh')
  })
})

function writeWorkspace(files: DocFiles, docId: string, bytes: Uint8Array): void {
  writeFileSync(files.workspaceFile(docId, 'docx'), bytes)
}
