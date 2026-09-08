import { describe, test, expect, vi, beforeEach } from 'vitest'

/**
 * #927 — document_context builder(doc-context-builder.ts)单测:
 *  item 1 — 选区注入 token 预算(4k 截断 + 标注)与 selectionSection
 *            命中时的选区原文去重(锚点替代);
 *  item 2 — FORMAT/CHART/REVISION/CITATION/CONFIRM 五条静态规则上移到
 *            文档正文之前(顺序保持),CHART/CITATION 按回合诉求门控。
 *
 * prisma 全量 mock(doc-version-writer.test.ts 同款 factory 模式),
 * 不触真实 DB;参考材料用 note 类(不触发文件提取)。
 */
const mocks = vi.hoisted(() => ({
  docFindFirst: vi.fn(),
  docRefFindMany: vi.fn(),
}))

vi.mock('../../src/common/prisma.js', () => ({
  default: {
    doc: { findFirst: mocks.docFindFirst },
    docReference: { findMany: mocks.docRefFindMany },
  },
}))

import {
  buildDocumentContext,
  shouldInjectChartCitationRules,
  fitSelectionForPrompt,
  SELECTION_TRUNCATION_MARKER,
} from '../../src/modules/chat/doc-context-builder.js'
import { FORMAT_RULE, CHART_RULE, REVISION_RULE, CITATION_RULE, CONFIRM_RULE } from '../../src/modules/chat/writing-prompts.js'

function makeHint() {
  return { focusSectionContent: null, focusIndex: null, focusTitle: null, selectionText: null }
}

describe('#927 item 1 — 选区注入预算(fitSelectionForPrompt)', () => {
  test('预算内原样返回', () => {
    const s = '这是一段普通的选中文本。'
    expect(fitSelectionForPrompt(s)).toBe(s)
  })

  test('超 4k token 截断并带截断标注;#868 editHint 仍回填未截断原文(由 builder 保证)', () => {
    // 20k 字符 latin ≈ 5k token — 超预算。
    const s = 'a'.repeat(20_000)
    const out = fitSelectionForPrompt(s)
    expect(out).toContain(SELECTION_TRUNCATION_MARKER)
    expect(out.length).toBeLessThan(s.length)
    expect(out.startsWith('a')).toBe(true)
  })
})

describe('#927 item 2 — CHART/CITATION 规则门控(shouldInjectChartCitationRules)', () => {
  test('有参考材料(evidence)→ 注入', () => {
    expect(shouldInjectChartCitationRules({ hasRefs: true, messageText: '润色这段' })).toBe(true)
  })

  test('无参考材料 + 消息含图表/引用诉求 → 注入', () => {
    expect(shouldInjectChartCitationRules({ hasRefs: false, messageText: '帮我把这组数据改成柱状图' })).toBe(true)
    expect(shouldInjectChartCitationRules({ hasRefs: false, messageText: '补充一下参考文献' })).toBe(true)
    expect(shouldInjectChartCitationRules({ hasRefs: false, messageText: 'please add a citation here' })).toBe(true)
    expect(shouldInjectChartCitationRules({ hasRefs: false, messageText: 'draw a figure for trend' })).toBe(true)
  })

  test('普通润色诉求 + 无参考材料 → 不注入', () => {
    expect(shouldInjectChartCitationRules({ hasRefs: false, messageText: '帮我润色这段摘要' })).toBe(false)
    expect(shouldInjectChartCitationRules({ hasRefs: false, messageText: '' })).toBe(false)
  })
})

describe('#927 — buildDocumentContext 装配(规则位置/门控/选区去重)', () => {
  beforeEach(() => {
    mocks.docFindFirst.mockReset()
    mocks.docRefFindMany.mockReset()
  })

  test('短文档 + 无参考材料 + 普通润色:静态规则在正文之前,CHART/CITATION 不注入,选区原文完整注入', async () => {
    const body = '# 摘要\n\n原始摘要内容一句话。\n\n# 方法\n\n研究方法内容。'
    mocks.docFindFirst.mockResolvedValue({ id: 'doc_x', userId: 'u1', title: 'T', body, deck: null })
    mocks.docRefFindMany.mockResolvedValue([])

    const hint = makeHint()
    const seg = await buildDocumentContext({
      userId: 'u1', docId: 'doc_x', messageText: '润色这段', rawSelection: '原始摘要内容一句话。',
      editHint: hint, lastAssistantContent: null,
    })

    // 五条静态规则上移:全部位于文档正文之前,顺序 FORMAT→REVISION→CONFIRM(CHART/CITATION 被门控)。
    expect(seg.indexOf(FORMAT_RULE)).toBeGreaterThan(-1)
    expect(seg.indexOf(FORMAT_RULE)).toBeLessThan(seg.indexOf('原始摘要内容一句话。'))
    expect(seg.indexOf(REVISION_RULE)).toBeGreaterThan(seg.indexOf(FORMAT_RULE))
    expect(seg.indexOf(CONFIRM_RULE)).toBeGreaterThan(seg.indexOf(REVISION_RULE))
    expect(seg).not.toContain(CHART_RULE)
    expect(seg).not.toContain(CITATION_RULE)
    // 规则各出现一次,且不再有挂在段尾的旧布局。
    expect(seg.split(FORMAT_RULE).length - 1).toBe(1)
    expect(seg.split(CONFIRM_RULE).length - 1).toBe(1)
    // 选区原文完整注入(短文档,预算内)。
    expect(seg).toContain('## 用户选中文本')
    expect(seg).toContain('原始摘要内容一句话。')
    // #868: 选区回填 editHint(未截断)。
    expect(hint.selectionText).toBe('原始摘要内容一句话。')
  })

  test('消息含图表诉求 → CHART/CITATION 注入且仍在正文之前', async () => {
    mocks.docFindFirst.mockResolvedValue({ id: 'doc_x', userId: 'u1', title: 'T', body: '# 一\n\n正文甲。', deck: null })
    mocks.docRefFindMany.mockResolvedValue([])

    const seg = await buildDocumentContext({
      userId: 'u1', docId: 'doc_x', messageText: '把数据改成柱状图', rawSelection: undefined,
      editHint: makeHint(), lastAssistantContent: null,
    })

    expect(seg).toContain(CHART_RULE)
    expect(seg).toContain(CITATION_RULE)
    expect(seg.indexOf(CHART_RULE)).toBeLessThan(seg.indexOf('正文甲。'))
    expect(seg.indexOf(CITATION_RULE)).toBeGreaterThan(seg.indexOf(CHART_RULE))
  })

  test('长文档 + 选区命中焦点段:选区原文不重复注入(锚点替代),CHART/CITATION 因有参考材料而注入', async () => {
    // 每句 ~65 CJK 字符 × 800 × 2 段 ≈ 104k 字符(≈69k token > 48k 全文预算)
    // → 分段注入;heading 模式下 2 个一级章节 → 2 段。
    const SENTENCE = '这是用于撑大文档体积的句子，确保整体超过全文注入预算而走分段路径，所以每句都写得足够长以快速达到阈值。'
    const fill = (prefix: string) => Array.from({ length: 800 }, (_, i) => `${prefix}第${i + 1}句：${SENTENCE}`).join('\n')
    const secA = fill('甲段')
    const secB = fill('乙段')
    const body = `# 第一段\n\n${secA}\n\n# 第二段\n\n${secB}`
    mocks.docFindFirst.mockResolvedValue({ id: 'doc_x', userId: 'u1', title: 'T', body, deck: null })
    mocks.docRefFindMany.mockResolvedValue([{ id: 'r1', refType: 'note', label: 'ref1', snapshot: '参考文献内容片段' }])

    const selection = `乙段第100句：${SENTENCE}`
    const hint = makeHint()
    const seg = await buildDocumentContext({
      userId: 'u1', docId: 'doc_x', messageText: '润色这段', rawSelection: selection,
      editHint: hint, lastAssistantContent: null,
    })

    // 焦点段定位到第 2 段(选区命中)。
    expect(seg).toContain('## 当前编辑段落（第 2/2 段')
    expect(seg).toContain('## 用户选中文本')
    // 选区原文只在焦点段正文中出现一次 — 「用户选中文本」块不再重复全文。
    expect(seg.split(selection).length - 1).toBe(1)
    // 锚点为选区开头 40 字符(≤ 41 字符,含省略号)。
    expect(seg).toContain(`${selection.slice(0, 40)}…`)
    // 有参考材料 → CHART/CITATION 注入(门控按 evidence)。
    expect(seg).toContain(CHART_RULE)
    expect(seg).toContain(CITATION_RULE)
    // #868: 焦点段原文/选中文本回填(未截断)。
    expect(hint.selectionText).toBe(selection)
    expect(hint.focusIndex).toBe(2)
    expect(hint.focusSectionContent).toBeTruthy()
  }, 20000)

  test('超长选区(全文模式):注入按 4k token 预算截断 + 标注,editHint 回填未截断原文', async () => {
    mocks.docFindFirst.mockResolvedValue({ id: 'doc_x', userId: 'u1', title: 'T', body: '# 一\n\n正文甲。', deck: null })
    mocks.docRefFindMany.mockResolvedValue([])

    const selection = 'b'.repeat(20_000)
    const hint = makeHint()
    const seg = await buildDocumentContext({
      userId: 'u1', docId: 'doc_x', messageText: '润色这段', rawSelection: selection,
      editHint: hint, lastAssistantContent: null,
    })

    expect(seg).toContain(SELECTION_TRUNCATION_MARKER)
    expect(seg).toContain('b'.repeat(100))
    expect(seg).not.toContain('b'.repeat(20_000))
    expect(hint.selectionText).toBe(selection)
  })

  test('docId 不存在 → 空串(合法降级)', async () => {
    mocks.docFindFirst.mockResolvedValue(null)
    const seg = await buildDocumentContext({
      userId: 'u1', docId: 'doc_missing', messageText: 'x', rawSelection: undefined,
      editHint: makeHint(), lastAssistantContent: null,
    })
    expect(seg).toBe('')
  })
})
