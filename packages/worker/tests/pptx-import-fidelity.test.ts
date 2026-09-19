import { describe, test, expect, vi, afterEach } from 'vitest'
import JSZip from 'jszip'
import { generatePptx, addNotesTruncated, type Slide } from '../src/handlers/pptx.js'

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

describe('#1062 PPTX 保真度跟进批次（导出侧 3/5/6）', () => {
  afterEach(() => vi.clearAllMocks())

  test('#1062-3 表格撑满页高时要点拆续页（不再静默丢弃）', async () => {
    // 30 行表格：tblH = min(30×0.34+0.05, 3.9) = 3.9 → tableBottom = 5.4 ≥ BODY_BOTTOM(5.15)
    const content = {
      schemaVersion: 2,
      title: 'T',
      slides: [
        {
          title: '数据页',
          content: [
            { type: 'paragraph', text: '关键结论要点', style: 'bullet' },
            { type: 'table', data: JSON.stringify({ rows: Array.from({ length: 30 }, (_, i) => [`第${i}行`, `值${i}`]) }) },
          ],
        },
      ],
    }
    const res = await generatePptx({ schema_version: 1, content_type: 'sidecar.generate_pptx', data: content })
    const parts = await unzip((res as { buffer: Buffer }).buffer)
    // 表格页（slide2，slide1 为合成封面）有表格
    expect(parts['ppt/slides/slide2.xml'] || '').toContain('<a:tbl>')
    // 旧实现：tableBottom ≥ BODY_BOTTOM → 要点连拆续页都不发生，直接消失
    const bulletSlide = Object.entries(parts).find(([, xml]) => xml.includes('关键结论要点'))
    expect(bulletSlide).toBeTruthy()
    expect(bulletSlide![0]).not.toBe('ppt/slides/slide2.xml')
  })

  test('#1062-3 表格超 100 行 → 行数口径统一（渲染前 100 行）+ 行数截断提示', async () => {
    const content = {
      schemaVersion: 2,
      title: 'T',
      slides: [
        {
          title: '长表页',
          content: [
            { type: 'table', data: JSON.stringify({ rows: Array.from({ length: 120 }, (_, i) => [`r${i + 1}`, `v${i + 1}`]) }) },
          ],
        },
      ],
    }
    const res = await generatePptx({ schema_version: 1, content_type: 'sidecar.generate_pptx', data: content })
    const parts = await unzip((res as { buffer: Buffer }).buffer)
    const all = Object.values(parts).join('\n')
    // 渲染第 100 行（口径统一后 slice(0,100) 的高度计算基准）
    expect(all).toContain('<a:t>r100</a:t>')
    // 第 101 行之后不渲染
    expect(all).not.toContain('<a:t>r120</a:t>')
    // 旧实现：静默截断 — 现要求行数截断有可见提示
    expect(all).toContain('仅渲染前 100 行')
    expect(all).toContain('120 行')
  })

  test('#1062-5 封面页（title 布局）notes 写回', async () => {
    const content = {
      schemaVersion: 1,
      title: 'T',
      slides: [
        { title: '研究报告封面', layout: 'title', notes: '封面页备注不应丢失', content: [{ type: 'paragraph', text: '副标题信息' }] },
        { title: '正文页', content: [{ type: 'paragraph', text: '正文', style: 'bullet' }] },
      ],
    }
    const res = await generatePptx({ schema_version: 1, content_type: 'sidecar.generate_pptx', data: content })
    const parts = await unzip((res as { buffer: Buffer }).buffer)
    const coverNotes = Object.values(parts).filter((xml) => xml.includes('封面页备注不应丢失'))
    expect(coverNotes).toHaveLength(1)
  })

  test('#1062-6 notes 上限统一到 wire 5000 口径：2000~5000 区间不再被静默砍半', async () => {
    // 4500 字符备注可通过 wire 校验（max 5000）— 旧实现 worker 静默 slice(0,2000)
    // 把第 2000 字符之后的内容无痕丢掉（'MIDTOKEN' 在第 3000 字符处）。
    const long = 'N'.repeat(3000) + 'MIDTOKEN' + 'N'.repeat(1492)
    expect(long.length).toBe(4500)
    const content = {
      schemaVersion: 1,
      title: 'T',
      slides: [
        { title: '长备注页', notes: long, content: [{ type: 'paragraph', text: 'x' }] },
      ],
    }
    const res = await generatePptx({ schema_version: 1, content_type: 'sidecar.generate_pptx', data: content })
    const parts = await unzip((res as { buffer: Buffer }).buffer)
    const all = Object.values(parts).join('\n')
    expect(all).toContain('MIDTOKEN')
    expect(all).not.toContain('已截断')
  })

  test('#1062-6 超限 notes（防御路径）→ 截断至 5000 且带可见提示', async () => {
    // wire 已挡 >5000；worker 侧截断为防御（直接调用 handler 内部约定）—
    // 截断必须在备注里留可见提示，不再静默。
    const fakeSlide = { addNotes: vi.fn() } as unknown as Slide
    addNotesTruncated(fakeSlide, `${'N'.repeat(5990)}TAILMARK`)
    const written = fakeSlide.addNotes.mock.calls[0][0] as string
    expect(written.length).toBeLessThanOrEqual(5000)
    expect(written).toContain('已截断至 5000')
    expect(written).toContain('源共 5998 字符')
    expect(written).not.toContain('TAILMARK')
  })

  test('#1062-6 未超限 notes 原样写回（回归）', async () => {
    const content = {
      schemaVersion: 1,
      title: 'T',
      slides: [
        { title: 'S', notes: '正常长度备注', content: [{ type: 'paragraph', text: 'x' }] },
      ],
    }
    const res = await generatePptx({ schema_version: 1, content_type: 'sidecar.generate_pptx', data: content })
    const parts = await unzip((res as { buffer: Buffer }).buffer)
    const all = Object.values(parts).join('\n')
    expect(all).toContain('正常长度备注')
    expect(all).not.toContain('已截断')
  })
})
