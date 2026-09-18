import { describe, test, expect, vi, afterEach } from 'vitest'
import JSZip from 'jszip'
import { generatePptx, parseInlineMarkdown } from '../src/handlers/pptx.js'

vi.mock('../src/storage.js', () => ({
  saveFile: vi.fn(async (buffer: Buffer, name: string, mime: string) => ({ fileId: 'f1', fileName: name, mimeType: mime, buffer })),
}))

/**
 * #1050 — deck slide 文本行内 markdown（bold/italic/strike/link）导出为
 * pptxgenjs rich-text runs（真实粗体/斜体/删除线/超链接片段，非图片）。
 * 无标记纯文本必须与改动前渲染完全一致（回归）。
 */

async function slideFiles(buffer: Buffer): Promise<{ xmls: string[]; rels: string[] }> {
  const zip = await JSZip.loadAsync(buffer)
  const xmlNames = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort()
  const relNames = Object.keys(zip.files).filter((n) => /^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/.test(n)).sort()
  const xmls: string[] = []
  for (const n of xmlNames) xmls.push(await zip.files[n].async('string'))
  const rels: string[] = []
  for (const n of relNames) rels.push(await zip.files[n].async('string'))
  return { xmls, rels }
}

async function render(content: unknown): Promise<Buffer> {
  const res = await generatePptx({ schema_version: 1, content_type: 'sidecar.generate_pptx', data: content })
  return (res as { buffer: Buffer }).buffer
}

describe('#1050 parseInlineMarkdown（markdown 行内 → runs）', () => {
  test('纯文本（无标记）→ 单一无样式 run，文本与原文一致（回归用例 4 前提）', () => {
    expect(parseInlineMarkdown('PFS 5.2 个月，风险比 0.48')).toEqual([{ text: 'PFS 5.2 个月，风险比 0.48' }])
  })

  test('空串 → 空数组（调用方按无 run 处理）', () => {
    expect(parseInlineMarkdown('')).toEqual([])
  })

  test('bold/italic/strike/link 各自解析为带标记的 run', () => {
    expect(parseInlineMarkdown('**粗体**')).toEqual([{ text: '粗体', bold: true }])
    expect(parseInlineMarkdown('*斜体*')).toEqual([{ text: '斜体', italic: true }])
    expect(parseInlineMarkdown('~~删除~~')).toEqual([{ text: '删除', strike: true }])
    expect(parseInlineMarkdown('[文本](https://example.com)')).toEqual([{ text: '文本', link: 'https://example.com' }])
  })

  test('混合标记 → 有序 run 序列，纯文本片段保持无标记', () => {
    const runs = parseInlineMarkdown('普通 **粗体** 中间 *斜体* 尾 ~~删除~~ [链](https://e.com) 末')
    expect(runs).toEqual([
      { text: '普通 ' },
      { text: '粗体', bold: true },
      { text: ' 中间 ' },
      { text: '斜体', italic: true },
      { text: ' 尾 ' },
      { text: '删除', strike: true },
      { text: ' ' },
      { text: '链', link: 'https://e.com' },
      { text: ' 末' },
    ])
  })

  test('容错：成对缺失的标记符/裸链接语法不匹配 → 原样纯文本', () => {
    expect(parseInlineMarkdown('5*3=15 和 **未闭合 与 [孤零](无空格url)')).toEqual([
      { text: '5*3=15 和 **未闭合 与 [孤零](无空格url)' },
    ])
  })
})

/** 定位包含指定文本的 run 的完整 XML 片段（run 级断言用 — 页标题本身是粗体，不能整页断言）。 */
function runAround(xml: string, text: string): string {
  const idx = xml.indexOf(`<a:t>${text}</a:t>`)
  const runStart = xml.lastIndexOf('<a:r>', idx)
  return xml.slice(runStart, xml.indexOf('</a:r>', idx) + 6)
}

describe('#1050 导出 rich-text runs（用例 3）', () => {
  afterEach(() => vi.clearAllMocks())

  test('**bold**/*italic*/~~strike~~/[text](url) → XML 出现真实 b/i/strike/hlinkClick run + rels 超链接', async () => {
    const buffer = await render({
      schemaVersion: 1,
      title: '富文本导出',
      slides: [
        {
          title: '结果',
          content: [
            { type: 'paragraph', text: '普通 **粗体** 与 *斜体* 与 ~~删除~~ 与 [链接](https://example.com)', style: 'bullet' },
          ],
        },
      ],
    })
    const { xmls, rels } = await slideFiles(buffer)
    const contentXml = xmls[xmls.length - 1] // 内容页（末张；首张为合成封面）
    // 各标记 run：真实样式属性落在对应文本片段上（非图片、非原始 markdown 符号）
    expect(runAround(contentXml, '粗体')).toContain('b="1"')
    expect(runAround(contentXml, '斜体')).toContain('i="1"')
    expect(runAround(contentXml, '删除')).toContain('strike="sngStrike"')
    expect(runAround(contentXml, '链接')).toContain('hlinkClick')
    expect(contentXml).toContain('<a:t>普通 </a:t>')
    expect(contentXml).not.toContain('**粗体**')
    // 超链接是真实关系（External URL）
    expect(rels.join()).toContain('Target="https://example.com"')
    expect(rels.join()).toContain('TargetMode="External"')
  })

  test('回归（用例 4）：纯文本 slide 导出与改动前一致 — 单段纯文本、无任何标记 run', async () => {
    const buffer = await render({
      schemaVersion: 1,
      title: '纯文本回归',
      slides: [{ title: '结果', content: [{ type: 'paragraph', text: 'PFS 5.2 个月', style: 'bullet' }] }],
    })
    const { xmls } = await slideFiles(buffer)
    const contentXml = xmls[xmls.length - 1]
    expect(contentXml).toContain('<a:t>PFS 5.2 个月</a:t>')
    // 无行内标记 → 对应 run 不携带任何样式属性（与改动前纯文本路径一致）
    const run = runAround(contentXml, 'PFS 5.2 个月')
    expect(run).not.toContain('b="1"')
    expect(run).not.toContain('i="1"')
    expect(run).not.toContain('strike="sngStrike"')
    expect(run).not.toContain('hlinkClick')
    expect(run).not.toContain('u="sng"')
  })
})

// #1054 — <u> 下划线直通（与正文/deck 同款 GitHub 方案）：内容只匹配纯文本，
// 带属性/未闭合/嵌套标签的 <u> 一律不匹配 → 原样纯文本，不产生注入面。
describe('#1054 parseInlineMarkdown <u> 下划线', () => {
  test('<u> 下划线 → underline run', () => {
    expect(parseInlineMarkdown('<u>下划线</u>')).toEqual([{ text: '下划线', underline: true }])
  })

  test('混合标记 → 有序 run 序列，underline 与既有标记共存', () => {
    expect(parseInlineMarkdown('普通 <u>下划线</u> 末')).toEqual([
      { text: '普通 ' },
      { text: '下划线', underline: true },
      { text: ' 末' },
    ])
  })

  test('容错：未闭合/带属性/嵌套标签的 <u> 不匹配 → 原样纯文本（安全默认）', () => {
    expect(parseInlineMarkdown('<u>未闭合 与 <u onclick="x()">带属性</u>')).toEqual([
      { text: '<u>未闭合 与 <u onclick="x()">带属性</u>' },
    ])
    expect(parseInlineMarkdown('<u><b>嵌套</b></u>')).toEqual([{ text: '<u><b>嵌套</b></u>' }])
  })

  test('导出（用例4）：<u> slide → XML 出现真实 u="sng" run，原始标签不残留', async () => {
    const buffer = await render({
      schemaVersion: 1,
      title: '下划线导出',
      slides: [{ title: '结果', content: [{ type: 'paragraph', text: '指标 <u>PFS 显著</u> 优于对照', style: 'bullet' }] }],
    })
    const { xmls } = await slideFiles(buffer)
    const contentXml = xmls[xmls.length - 1]
    expect(runAround(contentXml, 'PFS 显著')).toContain('u="sng"')
    expect(contentXml).toContain('<a:t>指标 </a:t>')
    expect(contentXml).not.toContain('<u>')
  })

  test('导出回归（用例5）：无 <u> 的纯文本导出与改动前一致（无 u 样式 run）', async () => {
    const buffer = await render({
      schemaVersion: 1,
      title: '纯文本回归',
      slides: [{ title: '结果', content: [{ type: 'paragraph', text: 'ORR 48%', style: 'bullet' }] }],
    })
    const { xmls } = await slideFiles(buffer)
    const run = runAround(xmls[xmls.length - 1], 'ORR 48%')
    expect(run).not.toContain('u="sng"')
  })
})
