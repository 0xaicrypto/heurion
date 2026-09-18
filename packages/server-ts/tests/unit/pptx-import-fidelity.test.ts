import { describe, test, expect } from 'vitest'
import { parsePptx, pptxSlidesToDeck } from '../../src/lib/pptx-extractor.js'
import { buildPptxFixture } from '../fixtures/pptx-fixture.js'
import { validateRenderContent, deckWireSchema, chartBlockSchema } from '@heurion/contracts'
/**
 * #1046 — PPTX 说话人备注（notes）链路保真测试。
 *
 * 链路：parsePptx（notesSlideN.xml → PptxSlide.notes）→ pptxSlidesToDeck
 * （→ DeckWire.slides[].notes）→ 导出边界 presentationContentSchema →
 * worker generatePptx（slide.addNotes 写回 notesSlideN.xml）。
 */

describe('#1046 说话人备注全链路', () => {
  test('导入含备注的 PPTX → Doc.deck 对应 slide 的 notes 非空', () => {
    const built = buildPptxFixture([
      { title: '研究背景', paragraphs: ['EGFR 突变 NSCLC'], notes: '开场 30 秒强调入组标准' },
      { title: '关键结果', paragraphs: ['中位 PFS 5.2 个月'] },
    ])
    const parsed = parsePptx(built.buffer)
    expect(parsed.ok).toBe(true)
    expect(parsed.slides[0].notes).toBe('开场 30 秒强调入组标准')
    expect(parsed.slides[1].notes).toBeUndefined()

    const deck = pptxSlidesToDeck(parsed.slides, parsed.images, '测试 PPT', 1)
    expect(deck).toBeTruthy()
    // 丢失点回归锁：DeckWire.slides[].notes 必须带上导入的备注
    expect(deck!.slides[0].notes).toBe('开场 30 秒强调入组标准')
    expect(deck!.slides[1].notes).toBeUndefined()
  })

  test('契约层：deckWireSchema 与 presentationContentSchema 均接受 notes 字段', () => {
    const deck = {
      title: 'T',
      slides: [{ title: 'S', notes: '备注', content: [{ type: 'paragraph', text: 'x' }] }],
    }
    expect(deckWireSchema.safeParse(deck).success).toBe(true)
    const check = validateRenderContent('sidecar.generate_pptx', { schemaVersion: 1, ...deck })
    expect(check.ok).toBe(true)
    // notes 必须穿透导出边界（zod parse 不丢字段），worker 才能写回 notesSlideN.xml
    if (check.ok) {
      expect((check.data as { slides: Array<{ notes?: string }> }).slides[0].notes).toBe('备注')
    }
  })
})

describe('#1047 表格（<a:tbl>）解析', () => {
  test('简单表格（无合并单元格）→ type:table 块，行列数据与源文件一致', () => {
    const built = buildPptxFixture([
      {
        title: '疗效数据',
        table: {
          rows: [
            [{ text: '药名' }, { text: '中位 PFS（月）' }],
            [{ text: 'Arm A' }, { text: '5.2' }],
            [{ text: 'Arm B' }, { text: '3.1' }],
          ],
        },
      },
    ])
    const parsed = parsePptx(built.buffer)
    expect(parsed.ok).toBe(true)
    const tables = parsed.slides[0].tables ?? []
    expect(tables).toHaveLength(1)
    expect(tables[0].rows).toEqual([['药名', '中位 PFS（月）'], ['Arm A', '5.2'], ['Arm B', '3.1']])

    const deck = pptxSlidesToDeck(parsed.slides, parsed.images, 'T', 1)!
    const tableBlock = deck.slides[0].content.find((b) => b.type === 'table') as { data: string } | undefined
    expect(tableBlock).toBeTruthy()
    expect(JSON.parse(tableBlock!.data)).toEqual({ rows: [['药名', '中位 PFS（月）'], ['Arm A', '5.2'], ['Arm B', '3.1']] })
  })

  test('合并单元格（gridSpan/rowSpan/hMerge/vMerge）→ 降级为重复文本，不留空白不丢内容', () => {
    const built = buildPptxFixture([
      {
        title: '合并表格',
        table: {
          rows: [
            [{ text: '实验组', gridSpan: 2 }, { text: '对照组' }],
            [{ text: 'PFS', rowSpan: 2 }, { text: '5.2' }, { text: '3.1' }],
            [{ text: '40%' }, { text: '25%' }],
            [{ text: '脚注' }, { text: '', hMerge: true }, { text: '完' }],
          ],
        },
      },
    ])
    const parsed = parsePptx(built.buffer)
    expect(parsed.ok).toBe(true)
    const tables = parsed.slides[0].tables ?? []
    expect(tables).toHaveLength(1)
    const rows = tables[0].rows
    // 逻辑网格 4 行 3 列：合并单元格按约定降级为重复文本
    expect(rows).toEqual([
      ['实验组', '实验组', '对照组'],
      ['PFS', '5.2', '3.1'],
      ['PFS', '40%', '25%'],
      ['脚注', '脚注', '完'],
    ])
    // 降级块带说明（caption），不静默
    const deck = pptxSlidesToDeck(parsed.slides, parsed.images, 'T', 1)!
    const block = deck.slides[0].content.find((b) => b.type === 'table') as { caption?: string } | undefined
    expect(block?.caption || '').toContain('合并')
  })

  test('全空表格（无可解析内容）→ 保留占位注记（原降级行为回归）', () => {
    const built = buildPptxFixture([
      { title: '空表页', table: { rows: [[{ text: '' }, { text: '' }], [{ text: '' }, { text: '' }]] } },
    ])
    const parsed = parsePptx(built.buffer)
    expect(parsed.slides[0].tables ?? []).toHaveLength(0)
    expect(parsed.slides[0].paragraphs).toContain('[本页含表格，未解析]')
  })

  test('回归：无表格的既有 PPTX 导入行为不变（无 table 块、段落原样）', () => {
    const built = buildPptxFixture([
      { title: '普通页', paragraphs: ['要点一', '要点二'] },
    ])
    const parsed = parsePptx(built.buffer)
    const deck = pptxSlidesToDeck(parsed.slides, parsed.images, 'T', 1)!
    expect(deck.slides[0].content.some((b) => b.type === 'table')).toBe(false)
    expect(deck.slides[0].content[0]).toMatchObject({ type: 'paragraph', text: '要点一' })
  })

  test('契约层：presentationContentSchema 接受 table 块、拒绝非法 data', () => {
    const ok = validateRenderContent('sidecar.generate_pptx', {
      schemaVersion: 2,
      title: 'T',
      slides: [{ title: 'S', content: [{ type: 'table', data: JSON.stringify({ rows: [['a', 'b'], ['1', '2']] }) }] }],
    })
    expect(ok.ok).toBe(true)
    const bad = validateRenderContent('sidecar.generate_pptx', {
      schemaVersion: 2,
      title: 'T',
      slides: [{ title: 'S', content: [{ type: 'table', data: 'not-json' }] }],
    })
    expect(bad.ok).toBe(false)
  })
})

describe('#1048 图表（chartN.xml）解析 → 既有 chartBlockSchema', () => {
  test('柱状图 → chart 块通过 chartBlockSchema，系列/类别数据一致', () => {
    const built = buildPptxFixture([
      {
        title: '疗效对比',
        charts: [{
          kind: 'barChart',
          categories: ['Arm A', 'Arm B', 'Arm C'],
          series: [{ name: '中位 PFS（月）', values: [5.2, 3.1, 2.8] }],
          title: '各臂中位 PFS',
        }],
      },
    ])
    const parsed = parsePptx(built.buffer)
    expect(parsed.ok).toBe(true)
    const charts = parsed.slides[0].charts ?? []
    expect(charts).toHaveLength(1)
    expect(charts[0].spec).toMatchObject({
      chart_type: 'bar',
      title: '各臂中位 PFS',
      data: [{ label: 'Arm A', value: 5.2 }, { label: 'Arm B', value: 3.1 }, { label: 'Arm C', value: 2.8 }],
    })
    // 契约对齐：insert_chart 产出的同一形状（chartBlockSchema）
    const deck = pptxSlidesToDeck(parsed.slides, parsed.images, 'T', 1)!
    const block = deck.slides[0].content.find((b) => b.type === 'chart')
    const check = chartBlockSchema.safeParse(block)
    expect(check.success).toBe(true)
    // 导入→导出全链路：含 chart 块的 deck 能通过导出边界校验
    expect(validateRenderContent('sidecar.generate_pptx', { schemaVersion: 2, title: 'T', slides: deck.slides }).ok).toBe(true)
  })

  test('折线图 → chart_type line', () => {
    const built = buildPptxFixture([
      { charts: [{ kind: 'lineChart', categories: ['D1', 'D2'], series: [{ name: '肿瘤体积', values: [100, 80] }] }] },
    ])
    const parsed = parsePptx(built.buffer)
    expect(parsed.slides[0].charts?.[0].spec?.chart_type).toBe('line')
    expect(parsed.slides[0].charts?.[0].spec?.data).toEqual([{ label: 'D1', value: 100 }, { label: 'D2', value: 80 }])
  })

  test('饼图 → 数据保真映射为 bar（caption 记录原类型，渲染管道零新增代码）', () => {
    const built = buildPptxFixture([
      { charts: [{ kind: 'pieChart', categories: ['完全缓解', '部分缓解'], series: [{ name: '分布', values: [30, 70] }] }] },
    ])
    const parsed = parsePptx(built.buffer)
    const chart = parsed.slides[0].charts?.[0]
    expect(chart?.spec?.chart_type).toBe('bar')
    expect(chart?.spec?.data).toEqual([{ label: '完全缓解', value: 30 }, { label: '部分缓解', value: 70 }])
    expect(chart?.caption || '').toContain('pieChart')
  })

  test('多系列 → 保留第 1 个系列，caption 注明（不静默丢系列）', () => {
    const built = buildPptxFixture([
      {
        charts: [{
          kind: 'barChart',
          categories: ['Arm A', 'Arm B'],
          series: [
            { name: '中位 PFS', values: [5.2, 3.1] },
            { name: '中位 OS', values: [18.3, 15.2] },
          ],
        }],
      },
    ])
    const parsed = parsePptx(built.buffer)
    const chart = parsed.slides[0].charts?.[0]
    expect(chart?.spec?.data).toEqual([{ label: 'Arm A', value: 5.2 }, { label: 'Arm B', value: 3.1 }])
    expect(chart?.caption || '').toContain('2 个系列')
  })

  test('不支持类型（雷达图）→ 降级占位并记录类型名，不中断导入', () => {
    const built = buildPptxFixture([
      {
        title: '雷达页',
        charts: [{ kind: 'radarChart', categories: ['A', 'B'], series: [{ name: 'x', values: [1, 2] }] }],
      },
      { title: '后续页', paragraphs: ['不应被中断'] },
    ])
    const parsed = parsePptx(built.buffer)
    expect(parsed.ok).toBe(true)
    expect(parsed.slides[0].charts ?? []).toHaveLength(0)
    expect(parsed.slides[0].paragraphs.some((p) => p.includes('radarChart'))).toBe(true)
    expect(parsed.slides[1].paragraphs).toContain('不应被中断')
  })

  test('关系断链（chart part 缺失）→ 原占位注记，不中断', () => {
    const built = buildPptxFixture([
      { charts: [{ kind: 'barChart', categories: ['A'], series: [{ name: 'x', values: [1] }], withPart: false }] },
    ])
    const parsed = parsePptx(built.buffer)
    expect(parsed.ok).toBe(true)
    expect(parsed.slides[0].charts ?? []).toHaveLength(0)
    expect(parsed.slides[0].paragraphs).toContain('[本页含图表，未解析]')
  })
})

describe('#1052 SmartArt 降级（dsp:drawing 降级绘图）', () => {
  test('含降级绘图 → 形状文字按几何序保留为结构化列表 + 明确降级提示（非纯占位）', () => {
    const built = buildPptxFixture([
      {
        title: '研究流程',
        smartArt: { shapes: ['第一步：入组筛选', '第二步：随机分组', '第三步：终点评估'] },
      },
    ])
    const parsed = parsePptx(built.buffer)
    expect(parsed.ok).toBe(true)
    const paras = parsed.slides[0].paragraphs
    expect(paras.some((p) => p.includes('[SmartArt 已降级为文字列表，原图形排布未保留]'))).toBe(true)
    expect(paras).toContain('第一步：入组筛选')
    expect(paras).toContain('第二步：随机分组')
    expect(paras).toContain('第三步：终点评估')
    expect(paras.some((p) => p.includes('未解析'))).toBe(false)
  })

  test('形状文字按几何位置（y→x）排序，不按 XML 出现序', () => {
    const built = buildPptxFixture([
      {
        smartArt: {
          shapes: ['右', '左'],
          positions: [{ x: 5000000, y: 1000000 }, { x: 1000000, y: 1000000 }],
        },
      },
    ])
    const parsed = parsePptx(built.buffer)
    const paras = parsed.slides[0].paragraphs
    expect(paras.indexOf('左')).toBeGreaterThan(-1)
    expect(paras.indexOf('右')).toBeGreaterThan(-1)
    expect(paras.indexOf('左')).toBeLessThan(paras.indexOf('右'))
  })

  test('降级绘图缺失（极端 fixture）→ 占位说明且给出清晰提示，不静默', () => {
    const built = buildPptxFixture([
      { title: '旧版页', smartArt: { shapes: ['不可达'], missingDrawing: true } },
      { title: '后续页', paragraphs: ['不受影响'] },
    ])
    const parsed = parsePptx(built.buffer)
    expect(parsed.ok).toBe(true)
    const paras = parsed.slides[0].paragraphs
    expect(paras.some((p) => p.includes('SmartArt') && p.includes('降级绘图缺失'))).toBe(true)
    expect(paras).not.toContain('[SmartArt 已降级为文字列表，原图形排布未保留]')
    expect(parsed.slides[1].paragraphs).toContain('不受影响')
  })

  test('deck 转换：降级文字以要点段落块落 deck（deck-view 可见），导出校验通过', () => {
    const built = buildPptxFixture([
      { title: '流程', smartArt: { shapes: ['入组', '分组', '评估'] } },
    ])
    const parsed = parsePptx(built.buffer)
    const deck = pptxSlidesToDeck(parsed.slides, parsed.images, 'T', 1)!
    const texts = deck.slides[0].content.filter((b) => b.type === 'paragraph').map((b) => (b as { text: string }).text)
    expect(texts.some((t) => t.includes('已降级为文字列表'))).toBe(true)
    expect(texts).toContain('入组')
    expect(validateRenderContent('sidecar.generate_pptx', { schemaVersion: 1, title: 'T', slides: deck.slides }).ok).toBe(true)
  })
})
