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

describe('#1068 表格高度传导渲染（页高预算/拆续页/多表不重叠）', () => {
  afterEach(() => vi.clearAllMocks())

  const EMU_PER_IN = 914400
  const PAGE_H_EMU = 5.625 * EMU_PER_IN // WIDE 画布高（in → EMU）

  interface YRange { y: number; bottom: number }

  /** slide XML 中所有表格 graphicFrame 的纵坐标区间（EMU）— h 传导后 frame ext cy 即表格预算高。 */
  const tableRanges = (slideXml: string): YRange[] => {
    const out: YRange[] = []
    for (const m of slideXml.matchAll(/<p:graphicFrame>[\s\S]*?<\/p:graphicFrame>/g)) {
      if (!m[0].includes('<a:tbl>')) continue
      const y = parseInt(/<a:off x="\d+" y="(-?\d+)"/.exec(m[0])?.[1] || '', 10)
      const cy = parseInt(/<a:ext cx="\d+" cy="(\d+)"/.exec(m[0])?.[1] || '', 10)
      out.push({ y, bottom: y + cy })
    }
    return out
  }

  /** 指定文本所在形状（p:sp）的纵坐标区间（EMU）。 */
  const textRange = (slideXml: string, needle: string): YRange | null => {
    for (const m of slideXml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)) {
      if (!m[0].includes(needle)) continue
      const y = parseInt(/<a:off x="\d+" y="(-?\d+)"/.exec(m[0])?.[1] || '', 10)
      const cy = parseInt(/<a:ext cx="\d+" cy="(\d+)"/.exec(m[0])?.[1] || '', 10)
      return { y, bottom: y + cy }
    }
    return null
  }

  const generate = async (content: unknown) => {
    const res = await generatePptx({ schema_version: 1, content_type: 'sidecar.generate_pptx', data: content })
    return unzip((res as { buffer: Buffer }).buffer)
  }

  test('30 行表格导出 → 各表格 frame 的 y 坐标区间均在画布内（无页高越界），行不丢', async () => {
    // 旧实现：未传 h、整表塞一页 — frame cy 停留在 1in 兜底值，行按 rowH 自然
    // 外溢画布（超约 11 行即越界）。
    const rows = Array.from({ length: 30 }, (_, i) => [`第${i}行`, `值${i}`])
    const parts = await generate({
      schemaVersion: 2,
      title: 'T',
      slides: [{ title: '长表页', content: [{ type: 'table', data: JSON.stringify({ rows }) }] }],
    })
    const slideNames = Object.keys(parts).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    const frames = slideNames.flatMap((n) => tableRanges(parts[n]))
    // 拆续页语义生效（页高预算 ~11 行/页 → 多页承载），且每个 frame 完整落在画布内
    expect(frames.length).toBeGreaterThanOrEqual(2)
    for (const f of frames) {
      expect(f.y).toBeGreaterThanOrEqual(0)
      expect(f.bottom).toBeLessThanOrEqual(PAGE_H_EMU)
    }
    // 拆页不丢行：30 行全部渲染（含续页）
    const all = Object.values(parts).join('\n')
    for (let i = 0; i < 30; i++) expect(all).toContain(`<a:t>第${i}行</a:t>`)
  })

  test('一页两表（表格 + 图表页）→ 表格与图表摘要文本坐标区间不相交（无视觉重叠）', async () => {
    // 旧实现：图表摘要文本固定从 BODY_TOP 起渲染，压在表格区域上（视觉重叠）。
    const parts = await generate({
      schemaVersion: 2,
      title: 'T',
      slides: [
        {
          title: '数据页',
          content: [
            { type: 'table', data: JSON.stringify({ rows: [['A', 'B'], ['1', '2'], ['3', '4']] }) },
            { type: 'chart', spec: { chart_type: 'bar', title: '疗效对比', data: [{ label: 'Arm A', value: 5.2 }] } },
          ],
        },
      ],
    })
    const slideXml = parts['ppt/slides/slide2.xml'] || ''
    const tbl = tableRanges(slideXml)[0]
    const chartText = textRange(slideXml, '图表')
    expect(tbl).toBeTruthy()
    expect(chartText).toBeTruthy()
    // 图表文本整体位于表格区间之下（区间不相交）
    expect(chartText!.y).toBeGreaterThanOrEqual(tbl!.bottom)
  })

  test('两个 table 块高度求和超页预算 → 两者坐标区间不相交且均在画布内', async () => {
    // 两表各 10 行（自然高 2×3.45=6.9 > 页预算 3.9）：求和判定 → 第二表整表拆续页。
    // 旧实现：第二表 y 压到首页底部、实际渲染高度不收敛 → 画布外溢出。
    const tenRows = Array.from({ length: 10 }, (_, i) => [`T${i}`, `V${i}`])
    const parts = await generate({
      schemaVersion: 2,
      title: 'T',
      slides: [
        {
          title: '双表页',
          content: [
            { type: 'table', data: JSON.stringify({ rows: tenRows.map((r) => [`${r[0]}a`, r[1]]) }) },
            { type: 'table', data: JSON.stringify({ rows: tenRows.map((r) => [`${r[0]}b`, r[1]]) }) },
          ],
        },
      ],
    })
    const slideNames = Object.keys(parts).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    const frames = slideNames.flatMap((n) => tableRanges(parts[n]))
    expect(frames.length).toBe(2)
    for (const f of frames) expect(f.bottom).toBeLessThanOrEqual(PAGE_H_EMU)
    // 两表不在同一页（求和超预算 → 拆续页），坐标区间天然不相交
    for (const n of slideNames) expect(tableRanges(parts[n]).length).toBeLessThanOrEqual(1)
    const all = Object.values(parts).join('\n')
    expect(all).toContain('<a:t>T0a</a:t>')
    expect(all).toContain('<a:t>T0b</a:t>')
  })

  test('回归：既有短表格（3 行）渲染不变 — 单 frame、y=BODY_TOP、行高 rowH', async () => {
    const parts = await generate({
      schemaVersion: 2,
      title: 'T',
      slides: [
        {
          title: '疗效数据',
          content: [{ type: 'table', data: JSON.stringify({ rows: [['药名', 'PFS'], ['Arm A', '5.2'], ['Arm B', '3.1']] }) }],
        },
      ],
    })
    const slideXml = parts['ppt/slides/slide2.xml'] || ''
    const frames = tableRanges(slideXml)
    expect(frames).toHaveLength(1) // 不拆页
    expect(frames[0].y).toBe(Math.round(1.25 * EMU_PER_IN)) // y = BODY_TOP
    // frame ext cy = 行数×rowH+0.05（#1062-3 tblH 同口径）— 不再是 1in 兜底
    expect(frames[0].bottom).toBe(Math.round((3 * 0.34 + 0.05) * EMU_PER_IN) + Math.round(1.25 * EMU_PER_IN))
    expect(slideXml).toContain('<a:tr h="310896">') // 行高 0.34in 不变
    expect(slideXml).toContain('药名')
  })
})

describe('#1090-3 表格块超 2 个 → 丢弃可观测（warn + 页面注记）', () => {
  afterEach(() => {
    vi.clearAllMocks()
    vi.restoreAllMocks()
  })

  const generate = async (content: unknown) => {
    const res = await generatePptx({ schema_version: 1, content_type: 'sidecar.generate_pptx', data: content })
    return unzip((res as { buffer: Buffer }).buffer)
  }

  test('3 个表格块 → 前 2 个渲染、第 3 个丢弃，warn 留痕 + 页面注记可见', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const parts = await generate({
      schemaVersion: 2,
      title: 'T',
      slides: [
        {
          title: '多表页',
          content: [
            { type: 'table', data: JSON.stringify({ rows: [['T1A'], ['1']] }) },
            { type: 'table', data: JSON.stringify({ rows: [['T2A'], ['1']] }) },
            { type: 'table', data: JSON.stringify({ rows: [['T3A'], ['1']] }) },
          ],
        },
      ],
    })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('#1090-3'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('其余 1 个已省略'))
    const all = Object.values(parts).join('\n')
    // 前 2 个表格正常渲染
    expect(all).toContain('<a:t>T1A</a:t>')
    expect(all).toContain('<a:t>T2A</a:t>')
    // 第 3 个丢弃
    expect(all).not.toContain('T3A')
    // 页面注记（#1062-7 截断标注同口径 — 丢弃数可见，不再静默）
    expect(all).toContain('仅渲染前 2 个')
    expect(all).toContain('源共 3 个')
  })

  test('回归：恰 2 个表格块 → 不触发 warn、无注记', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const parts = await generate({
      schemaVersion: 2,
      title: 'T',
      slides: [
        {
          title: '双表页',
          content: [
            { type: 'table', data: JSON.stringify({ rows: [['T1A'], ['1']] }) },
            { type: 'table', data: JSON.stringify({ rows: [['T2A'], ['1']] }) },
          ],
        },
      ],
    })
    expect(warn).not.toHaveBeenCalled()
    const all = Object.values(parts).join('\n')
    expect(all).toContain('<a:t>T1A</a:t>')
    expect(all).toContain('<a:t>T2A</a:t>')
    expect(all).not.toContain('表格过多')
  })
})
