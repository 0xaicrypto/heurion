import { describe, test, expect } from 'vitest'
import {
  validateRenderContent,
  deckWireSchema,
  type PresentationContent,
} from '@heurion/contracts'

/**
 * #957 — deck v2 契约 golden fixtures。
 * deck schema 曾实际漂移过一次（#773/#790 schemaVersion），本测试锁形状：
 * v1 载荷原样可解析（向后兼容）、v2 新字段（layout/theme/chart/figure）
 * 合法形状通过、非法形状拒绝、未知 block 类型拒绝。
 */

const V1_DECK: PresentationContent = {
  schemaVersion: 1,
  title: 'EGFR 研究',
  slides: [{ title: '结果', content: [{ type: 'paragraph', text: 'PFS 5.2 个月', style: 'bullet' }] }],
}

describe('#957 deck v2 契约（presentationContentSchema）', () => {
  test('v1 载荷可解析（向后兼容 golden）', () => {
    const check = validateRenderContent('sidecar.generate_pptx', V1_DECK)
    expect(check.ok).toBe(true)
  })

  test('v2 布局 + 主题 + chart/figure block 合法', () => {
    const v2: PresentationContent = {
      schemaVersion: 2,
      title: 'EGFR 研究',
      theme: 'warm-paper',
      slides: [
        { title: '封面', layout: 'title', content: [{ type: 'paragraph', text: '副标题占位' }] },
        {
          title: '疗效对比',
          layout: 'chart-full',
          content: [
            {
              type: 'chart',
              spec: {
                chart_type: 'bar',
                data: [{ label: 'PFS', value: 5.2 }, { label: 'OS', value: 14.1 }],
                errors: [{ label: 'PFS', error: 0.8 }],
                title: '中位生存',
                y_label: '月',
              },
            },
          ],
        },
        {
          title: '通路',
          layout: 'bullets',
          content: [{ type: 'figure', kind: 'mermaid', source: 'graph TD; A-->B' }, { type: 'paragraph', text: '说明' }],
        },
      ],
    }
    const check = validateRenderContent('sidecar.generate_pptx', v2)
    expect(check.ok).toBe(true)
  })

  test('非法布局枚举拒绝', () => {
    const bad = { ...V1_DECK, schemaVersion: 2, slides: [{ title: 'x', layout: 'freeform', content: [{ type: 'paragraph', text: 'y' }] }] }
    const check = validateRenderContent('sidecar.generate_pptx', bad)
    expect(check.ok).toBe(false)
    expect(check.errors.join()).toContain('layout')
  })

  test('chart block 缺 data / 空 data 拒绝', () => {
    const bad = { ...V1_DECK, schemaVersion: 2, slides: [{ title: 'x', content: [{ type: 'chart', spec: { chart_type: 'bar', data: [] } }] }] }
    expect(validateRenderContent('sidecar.generate_pptx', bad).ok).toBe(false)
    const bad2 = { ...V1_DECK, schemaVersion: 2, slides: [{ title: 'x', content: [{ type: 'chart', spec: { chart_type: 'spline', data: [{ label: 'a', value: 1 }] } }] }] }
    expect(validateRenderContent('sidecar.generate_pptx', bad2).ok).toBe(false)
  })

  test('figure source 超 32KB 拒绝（#825 安全约束口径）', () => {
    const bad = {
      ...V1_DECK,
      schemaVersion: 2,
      slides: [{ title: 'x', content: [{ type: 'figure', kind: 'mermaid', source: 'graph TD\n' + 'a-->b\n'.repeat(9000) }] }],
    }
    expect(validateRenderContent('sidecar.generate_pptx', bad).ok).toBe(false)
  })
})

describe('#957 DeckWire（SSE wire 宽松形状）', () => {
  test('v2 wire（theme/layout/chart/figure 字段）可解析', () => {
    const wire = {
      title: 'EGFR',
      theme: 'warm-paper',
      slides: [
        { title: '封面', layout: 'title', content: [{ type: 'paragraph', text: 'x' }] },
        { title: '图', layout: 'chart-full', content: [{ type: 'chart', spec: { chart_type: 'bar', data: [{ label: 'a', value: 1 }] } }, { type: 'figure', kind: 'latex_math', source: 'e=mc^2' }] },
      ],
    }
    expect(deckWireSchema.safeParse(wire).success).toBe(true)
  })

  test('v1 wire（无 v2 字段）仍可解析', () => {
    expect(deckWireSchema.safeParse({ title: 'd', slides: [{ title: 's', content: [] }] }).success).toBe(true)
  })
})
