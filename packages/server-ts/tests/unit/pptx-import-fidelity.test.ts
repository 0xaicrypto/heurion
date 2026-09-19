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

describe('#1067 表格 gridSpan + hMerge 标准组合（双重计数列修复）', () => {
  test('标准组合：gridSpan=2 锚点 + 1 个 hMerge 占位 → 行列数与其他行一致、内容对齐', () => {
    // 真实 PowerPoint 合并单元格标准写法：锚点 gridSpan="N" + N-1 个 hMerge="1" 占位格。
    // 旧实现：锚点展开 2 列后，hMerge 占位又被当作新列 push → 该行 4 列（其他行 3 列）全表错位。
    const built = buildPptxFixture([
      {
        title: '标准合并',
        table: {
          rows: [
            [{ text: '组别' }, { text: '中位 PFS（月）' }, { text: '中位 OS（月）' }],
            [{ text: '实验组', gridSpan: 2 }, { text: '', hMerge: true }, { text: '5.2' }],
            [{ text: '对照组', gridSpan: 2 }, { text: '', hMerge: true }, { text: '3.1' }],
          ],
        },
      },
    ])
    const parsed = parsePptx(built.buffer)
    expect(parsed.ok).toBe(true)
    const rows = parsed.slides[0].tables?.[0]?.rows ?? []
    expect(rows).toEqual([
      ['组别', '中位 PFS（月）', '中位 OS（月）'],
      ['实验组', '实验组', '5.2'],
      ['对照组', '对照组', '3.1'],
    ])
    // 合并单元格降级标记不回退（锚点 gridSpan 仍标记 mergedDegraded → caption 可见）
    expect(parsed.slides[0].tables?.[0]?.mergedDegraded).toBe(true)
  })

  test('畸形回退：锚点未声明 gridSpan 的 hMerge 续格 → 保持复制左格行为', () => {
    // HTML 风格畸形产物：hMerge 续格前没有 gridSpan 锚点 — 回退「复制左格」，
    // 行列数不丢（旧行为保持，#1067 不改变该路径）。
    const built = buildPptxFixture([
      {
        title: '畸形续格',
        table: {
          rows: [
            [{ text: 'A' }, { text: 'B' }, { text: 'C' }],
            [{ text: '左格' }, { text: '', hMerge: true }, { text: '右格' }],
          ],
        },
      },
    ])
    const parsed = parsePptx(built.buffer)
    const rows = parsed.slides[0].tables?.[0]?.rows ?? []
    expect(rows[0]).toHaveLength(3)
    expect(rows[1]).toEqual(['左格', '左格', '右格'])
  })

  test('多行混合合并（回归）：标准组合与 rowSpan/vMerge 混用，#1062-7 既有行为不回退', () => {
    const built = buildPptxFixture([
      {
        title: '混合合并',
        table: {
          rows: [
            [{ text: '区域', gridSpan: 2 }, { text: '', hMerge: true }, { text: '合计' }],
            [{ text: 'PFS', rowSpan: 2 }, { text: '5.2' }, { text: '3.1' }],
            [{ text: '40%' }, { text: '25%' }],
          ],
        },
      },
    ])
    const parsed = parsePptx(built.buffer)
    expect(parsed.ok).toBe(true)
    const rows = parsed.slides[0].tables?.[0]?.rows ?? []
    // 三行均为 3 逻辑列：标准组合行不再多计 N-1，rowSpan 携带行照旧
    expect(rows).toEqual([
      ['区域', '区域', '合计'],
      ['PFS', '5.2', '3.1'],
      ['PFS', '40%', '25%'],
    ])
    expect(parsed.slides[0].tables?.[0]?.mergedDegraded).toBe(true)
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

describe('#1059 图表 <c:pt> 按 idx 属性对齐（弃下标位置假设）', () => {
  // <c:pt> 原始 XML 构造器（fixture catPts/valPts 覆盖用）。
  const pt = (idx: number, v: string | number) => `<c:pt idx="${idx}"><c:v>${v}</c:v></c:pt>`

  test('用例 1：val 的 <c:pt> 缺 idx=1（空单元格）→ label/value 不整体错位', () => {
    // 真实 Excel 产物：数值列含空单元格时 numCache 跳过该 <c:pt>，cat strCache 保留全部类别。
    // 旧实现（按位置配对）：values 过滤后 [5.2, 2.8] 与 labels[0..1] 配对 → Arm B 拿到 2.8（静默串行）。
    const built = buildPptxFixture([
      {
        title: '空单元格图表',
        charts: [{
          kind: 'barChart',
          categories: ['Arm A', 'Arm B', 'Arm C'],
          series: [{ name: '中位 PFS', values: [5.2, 2.8] }],
          catPts: [pt(0, 'Arm A'), pt(1, 'Arm B'), pt(2, 'Arm C')],
          valPts: [pt(0, 5.2), pt(2, 2.8)],
        }],
      },
    ])
    const parsed = parsePptx(built.buffer)
    expect(parsed.ok).toBe(true)
    const chart = parsed.slides[0].charts?.[0]
    expect(chart?.spec?.data).toEqual([{ label: 'Arm A', value: 5.2 }, { label: 'Arm C', value: 2.8 }])
  })

  test('用例 2（回归）：cat/val 的 idx 均连续 → 结果与按位置配对一致', () => {
    const built = buildPptxFixture([
      {
        charts: [{
          kind: 'barChart',
          categories: ['D1', 'D2', 'D3'],
          series: [{ name: '肿瘤体积', values: [100, 80, 60] }],
        }],
      },
    ])
    const parsed = parsePptx(built.buffer)
    expect(parsed.slides[0].charts?.[0].spec?.data).toEqual([
      { label: 'D1', value: 100 },
      { label: 'D2', value: 80 },
      { label: 'D3', value: 60 },
    ])
  })

  test('用例 3：idx 乱序出现 → 仍按 idx 正确对齐（升序输出）', () => {
    const built = buildPptxFixture([
      {
        charts: [{
          kind: 'lineChart',
          categories: ['C0', 'C1', 'C2'],
          series: [{ name: 'x', values: [1, 2, 3] }],
          catPts: [pt(2, 'C2'), pt(0, 'C0'), pt(1, 'C1')],
          valPts: [pt(2, 3), pt(0, 1), pt(1, 2)],
        }],
      },
    ])
    const parsed = parsePptx(built.buffer)
    expect(parsed.slides[0].charts?.[0].spec?.data).toEqual([
      { label: 'C0', value: 1 },
      { label: 'C1', value: 2 },
      { label: 'C2', value: 3 },
    ])
  })
})

describe('#1062 PPTX 保真度跟进批次（导入侧 1/2/4/6/7）', () => {
  test('#1062-1 超大表（导出必炸 256KB）→ 导入侧预自检截断 + truncatedDegraded 标记', () => {
    // 199 行 × 4 列 × ~400 字符 ≈ 318KB JSON — 可导入但超导出 schema
    // （tableBlockSchema data ≤256KB），此前导入成功、导出永远报验证错。
    const filler = 'x'.repeat(400)
    const built = buildPptxFixture([
      {
        title: '超大表页',
        table: {
          rows: [
            [{ text: '列A' }, { text: '列B' }, { text: '列C' }, { text: '列D' }],
            ...Array.from({ length: 199 }, (_, i) => [{ text: `r${i}-${filler}` }, { text: filler }, { text: filler }, { text: filler }]),
          ],
        },
      },
    ])
    const parsed = parsePptx(built.buffer)
    expect(parsed.ok).toBe(true)
    const table = parsed.slides[0].tables?.[0]
    expect(table).toBeTruthy()
    // 截断到导出边界内 + 标记
    const size = JSON.stringify({ rows: table!.rows }).length
    expect(size).toBeLessThanOrEqual(256 * 1024)
    expect(table!.rows.length).toBeLessThan(200)
    expect(table!.truncatedDegraded).toBe(true)
    // deck 落点带 caption（不静默），且能通过导出边界校验
    const deck = pptxSlidesToDeck(parsed.slides, parsed.images, 'T', 2)!
    const block = deck.slides[0].content.find((b) => b.type === 'table') as { caption?: string; data: string } | undefined
    expect(block?.caption || '').toContain('截断')
    expect(block && JSON.parse(block.data).rows.length).toBe(table!.rows.length)
    expect(validateRenderContent('sidecar.generate_pptx', { schemaVersion: 2, title: 'T', slides: deck.slides }).ok).toBe(true)
  })

  test('#1062-1 预自检保留表头行（第 0 行不丢）', () => {
    const filler = 'x'.repeat(900) // 180 行 × 2 列 × ~900 字符 ≈ 324KB JSON > 256KB
    const built = buildPptxFixture([
      {
        table: {
          rows: [
            [{ text: '表头A' }, { text: '表头B' }],
            ...Array.from({ length: 180 }, () => [{ text: filler }, { text: filler }]),
          ],
        },
      },
    ])
    const parsed = parsePptx(built.buffer)
    const table = parsed.slides[0].tables?.[0]
    expect(table?.truncatedDegraded).toBe(true)
    expect(table?.rows[0]).toEqual(['表头A', '表头B'])
  })

  test('#1062-2 notes 按 slide rels 定位：notesSlide 编号与页序错位（fixture 反同构）仍挂对页', () => {
    // 反同构构造：第 1 页的备注落 notesSlide2.xml、第 2 页的落 notesSlide1.xml，
    // 且 notes 关系写在 rels 最前 — 页序映射假设下备注会静默挂错页。
    const built = buildPptxFixture([
      { title: '第一页', paragraphs: ['P1'], notes: '第一页的备注', notesPart: 'notesSlide2.xml' },
      { title: '第二页', paragraphs: ['P2'], notes: '第二页的备注', notesPart: 'notesSlide1.xml' },
    ])
    const parsed = parsePptx(built.buffer)
    expect(parsed.ok).toBe(true)
    expect(parsed.slides[0].notes).toBe('第一页的备注')
    expect(parsed.slides[1].notes).toBe('第二页的备注')
  })

  test('#1062-2 rels 缺 notesSlide 关系 → 按页序兜底（回归）', () => {
    const built = buildPptxFixture([
      { title: '旧产物页', notes: '兜底备注', omitNotesRel: true },
    ])
    const parsed = parsePptx(built.buffer)
    expect(parsed.slides[0].notes).toBe('兜底备注')
  })

  test('#1062-4 同页多 SmartArt 按 frame 引用的 r:id 配对（rels 逆序反同构）', () => {
    // 反同构构造：fixture 将 SA2 的 rels 写在 SA1 之前（rels 无序映射）。
    // 旧实现按 rels 出现序消费 → SA1 frame 拿到 SA2 的降级绘图（文字互相串）。
    const built = buildPptxFixture([
      {
        title: '双 SmartArt 页',
        smartArts: [
          { shapes: ['流程A-入组', '流程A-评估'] },
          { shapes: ['流程B-给药', '流程B-随访'] },
        ],
      },
    ])
    const parsed = parsePptx(built.buffer)
    expect(parsed.ok).toBe(true)
    const paras = parsed.slides[0].paragraphs
    expect(paras.indexOf('流程A-入组')).toBeGreaterThan(-1)
    expect(paras.indexOf('流程B-给药')).toBeGreaterThan(-1)
    // 各 frame 与自己的降级绘图配对：A 组文字整体在 B 组之前（frame 顺序）
    expect(paras.indexOf('流程A-入组')).toBeLessThan(paras.indexOf('流程B-给药'))
    expect(paras.indexOf('流程A-评估')).toBeLessThan(paras.indexOf('流程B-给药'))
  })

  test('#1062-6 notes 提取上限统一到 wire 5000 字符口径（原 2000 静默截断）', () => {
    const notes = 'N'.repeat(6000)
    const built = buildPptxFixture([{ title: '长备注页', notes }])
    const parsed = parsePptx(built.buffer)
    expect(parsed.slides[0].notes?.length).toBe(5000)
  })

  test('#1062-7 表格列数超 30（row.slice(0,30)）→ truncatedDegraded 标记 + caption', () => {
    const built = buildPptxFixture([
      {
        title: '宽表页',
        table: {
          rows: [
            Array.from({ length: 35 }, (_, c) => ({ text: `列${c}` })),
            Array.from({ length: 35 }, (_, c) => ({ text: `值${c}` })),
          ],
        },
      },
    ])
    const parsed = parsePptx(built.buffer)
    const table = parsed.slides[0].tables?.[0]
    expect(table?.rows[0]).toHaveLength(30)
    expect(table?.truncatedDegraded).toBe(true)
    const deck = pptxSlidesToDeck(parsed.slides, parsed.images, 'T', 2)!
    const block = deck.slides[0].content.find((b) => b.type === 'table') as { caption?: string } | undefined
    expect(block?.caption || '').toContain('截断')
  })

  test('#1062-7 表格行数超 200（grid.slice(0,200)）→ truncatedDegraded 标记', () => {
    const built = buildPptxFixture([
      {
        title: '长表页',
        table: {
          rows: Array.from({ length: 205 }, (_, r) => [{ text: `r${r}` }, { text: `v${r}` }]),
        },
      },
    ])
    const parsed = parsePptx(built.buffer)
    const table = parsed.slides[0].tables?.[0]
    expect(table?.rows).toHaveLength(200)
    expect(table?.truncatedDegraded).toBe(true)
    // 无合并单元格 → 不误标 mergedDegraded
    expect(table?.mergedDegraded).toBeUndefined()
  })

  test('#1062-7 段落超 50 块 → 保留降级注记块（丢弃数可见），总块数 ≤ 50', () => {
    const built = buildPptxFixture([
      { title: '超长页', paragraphs: Array.from({ length: 55 }, (_, i) => `P${i}`) },
    ])
    const parsed = parsePptx(built.buffer)
    const deck = pptxSlidesToDeck(parsed.slides, parsed.images, 'T', 1)!
    expect(deck.slides[0].content.length).toBeLessThanOrEqual(50)
    expect(deck.slides[0].content[0]).toMatchObject({ type: 'paragraph', text: 'P0' })
    // 降级注记：丢弃数可见（55 - 49 = 6），不再是静默截断
    const marker = deck.slides[0].content.find((b) => (b as { text?: string }).text?.includes('已丢弃'))
    expect(marker).toBeTruthy()
    expect((marker as { text: string }).text).toContain('6')
  })

  test('#1062-7 段落满 50 块时表格等追加块不再被无痕丢弃', () => {
    // 50 段落 + 1 表格：旧实现 content.slice(0,50) 会把表格无痕丢掉
    const built = buildPptxFixture([
      {
        title: '满页',
        paragraphs: Array.from({ length: 50 }, (_, i) => `P${i}`),
        table: { rows: [[{ text: '关键数据' }, { text: '值' }]] },
      },
    ])
    const parsed = parsePptx(built.buffer)
    const deck = pptxSlidesToDeck(parsed.slides, parsed.images, 'T', 1)!
    const blockTypes = deck.slides[0].content.map((b) => b.type)
    expect(blockTypes).toContain('table')
    expect(deck.slides[0].content.length).toBeLessThanOrEqual(50)
  })
})
