import { describe, test, expect, vi, afterEach } from 'vitest'
import JSZip from 'jszip'
import { generatePptx } from '../src/handlers/pptx.js'

vi.mock('../src/storage.js', () => ({
  saveFile: vi.fn(async (buffer: Buffer, name: string, mime: string) => ({ fileId: 'f1', fileName: name, mimeType: mime, buffer })),
}))

/**
 * #1046/#1047/#1052 — PPTX 导入保真度批次的导出侧（worker）测试。
 * 服务端导入侧（pptx-extractor）测试见 server-ts tests/unit/pptx-import-fidelity.test.ts。
 */

async function unzip(buffer: Buffer): Promise<Record<string, string>> {
  const zip = await JSZip.loadAsync(buffer)
  const out: Record<string, string> = {}
  for (const [name, file] of Object.entries(zip.files)) {
    if (!file.dir) out[name] = await file.async('string')
  }
  return out
}

describe('#1046 speaker notes 写回 notesSlideN.xml', () => {
  afterEach(() => vi.clearAllMocks())

  test('deck slides[].notes → 生成文件对应页 notesSlideN.xml 内容一致', async () => {
    const content = {
      schemaVersion: 1,
      title: 'EGFR 研究',
      slides: [
        { title: '研究背景', notes: '开场 30 秒强调入组标准', content: [{ type: 'paragraph', text: 'EGFR 突变 NSCLC', style: 'bullet' }] },
        { title: '关键结果', content: [{ type: 'paragraph', text: '中位 PFS 5.2 个月', style: 'bullet' }] },
        { title: '空白页', layout: 'blank', notes: '空白页备注也不丢', content: [{ type: 'paragraph', text: '占位' }] },
      ],
    }
    const res = await generatePptx({ schema_version: 1, content_type: 'sidecar.generate_pptx', data: content })
    const parts = await unzip((res as { buffer: Buffer }).buffer)
    const notesParts = Object.entries(parts).filter(([n]) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n))
    // pptxgenjs 为每页（含合成封面）都产 notesSlide part — 有 notes 的页正文非空
    const withText = notesParts.filter(([, xml]) => xml.includes('开场 30 秒强调入组标准'))
    expect(withText).toHaveLength(1)
    const blankPageNotes = notesParts.filter(([, xml]) => xml.includes('空白页备注也不丢'))
    expect(blankPageNotes).toHaveLength(1)
  })
})

describe('#1047 表格块导出（pptxgenjs 原生表格对象）', () => {
  afterEach(() => vi.clearAllMocks())

  test('table 块 → 生成文件含真实 <a:tbl> 表格（非图片），行列数据一致', async () => {
    const content = {
      schemaVersion: 2,
      title: 'T',
      slides: [
        {
          title: '疗效数据',
          content: [{ type: 'table', data: JSON.stringify({ rows: [['药名', '中位 PFS（月）'], ['Arm A', '5.2'], ['Arm B', '3.1']] }) }],
        },
      ],
    }
    const res = await generatePptx({ schema_version: 1, content_type: 'sidecar.generate_pptx', data: content })
    const parts = await unzip((res as { buffer: Buffer }).buffer)
    const slideXml = parts['ppt/slides/slide2.xml'] || '' // slide1 为合成封面
    expect(slideXml).toContain('<a:tbl>')
    expect(slideXml).toContain('药名')
    expect(slideXml).toContain('5.2')
    // 真实表格对象而非图片：该页不得出现图片引用
    expect(slideXml.includes('<p:pic>') || slideXml.includes('blip')).toBe(false)
  })

  test('表格 + 要点同页：表格对象与要点文本共存', async () => {
    const content = {
      schemaVersion: 2,
      title: 'T',
      slides: [
        {
          title: '数据页',
          content: [
            { type: 'paragraph', text: '关键结论要点', style: 'bullet' },
            { type: 'table', data: JSON.stringify({ rows: [['A', 'B'], ['1', '2']] }) },
          ],
        },
      ],
    }
    const res = await generatePptx({ schema_version: 1, content_type: 'sidecar.generate_pptx', data: content })
    const parts = await unzip((res as { buffer: Buffer }).buffer)
    const slideXml = parts['ppt/slides/slide2.xml'] || ''
    expect(slideXml).toContain('<a:tbl>')
    expect(slideXml).toContain('关键结论要点')
  })

  test('回归：无 table 块的页不产出 <a:tbl>', async () => {
    const content = {
      schemaVersion: 1,
      title: 'T',
      slides: [{ title: 'S', content: [{ type: 'paragraph', text: '纯要点', style: 'bullet' }] }],
    }
    const res = await generatePptx({ schema_version: 1, content_type: 'sidecar.generate_pptx', data: content })
    const parts = await unzip((res as { buffer: Buffer }).buffer)
    expect(Object.values(parts).some((xml) => xml.includes('<a:tbl>'))).toBe(false)
  })

  test('畸形 table data（非 JSON）→ 不中断导出（跳过表格渲染）', async () => {
    const content = {
      schemaVersion: 2,
      title: 'T',
      slides: [{ title: 'S', content: [{ type: 'table', data: 'not-json' }] }],
    }
    const res = await generatePptx({ schema_version: 1, content_type: 'sidecar.generate_pptx', data: content })
    const parts = await unzip((res as { buffer: Buffer }).buffer)
    expect(parts['ppt/slides/slide2.xml']).toBeTruthy()
  })
})

describe('#1052 SmartArt 降级内容导出', () => {
  afterEach(() => vi.clearAllMocks())

  test('SmartArt 降级文字列表（导入产出的段落块）→ 正常导出为文本，不报错', async () => {
    // 模拟 #1052 导入产物：降级提示 + 形状文字列表（pptxSlidesToDeck 的段落块）
    const content = {
      schemaVersion: 1,
      title: 'T',
      slides: [
        {
          title: '研究流程',
          content: [
            { type: 'paragraph', text: '[SmartArt 已降级为文字列表，原图形排布未保留]', style: 'normal' },
            { type: 'paragraph', text: '第一步：入组筛选', style: 'bullet' },
            { type: 'paragraph', text: '第二步：随机分组', style: 'bullet' },
            { type: 'paragraph', text: '第三步：终点评估', style: 'bullet' },
          ],
        },
      ],
    }
    const res = await generatePptx({ schema_version: 1, content_type: 'sidecar.generate_pptx', data: content })
    const parts = await unzip((res as { buffer: Buffer }).buffer)
    const slideXml = parts['ppt/slides/slide2.xml'] || ''
    expect(slideXml).toContain('已降级为文字列表')
    expect(slideXml).toContain('第二步：随机分组')
  })
})
