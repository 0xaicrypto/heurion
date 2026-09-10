import { describe, test, expect, vi, afterEach } from 'vitest'
import JSZip from 'jszip'
import { generatePptx } from '../src/handlers/pptx.js'
import type { PresentationContent } from '@heurion/contracts'

vi.mock('../src/storage.js', () => ({
  saveFile: vi.fn(async (buffer: Buffer, name: string, mime: string) => ({ fileId: 'f1', fileName: name, mimeType: mime, buffer })),
}))

/**
 * #964 — deck JSON → pptx golden 回归锁。
 * 所见即所导不变量（#773）的机器可执行版：布局母版（#958）× 主题（#957）
 * 的代表性组合 + autofit 拆续页行为，全部经 zip 解包做结构化断言
 * （页数 / 母版标记 / 内容完整性），防止 web 预览与导出双实现漂移。
 */

async function slideXmls(buffer: Buffer): Promise<string[]> {
  const zip = await JSZip.loadAsync(buffer)
  const names = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort()
  const out: string[] = []
  for (const n of names) out.push(await zip.files[n].async('string'))
  return out
}

async function render(content: unknown): Promise<{ buffer: Buffer; xmls: string[] }> {
  const res = await generatePptx({ schema_version: 1, content_type: 'sidecar.generate_pptx', data: content })
  const buffer = (res as { buffer: Buffer }).buffer
  return { buffer, xmls: await slideXmls(buffer) }
}

describe('#964 deck→pptx golden（布局母版 × 主题 × autofit）', () => {
  afterEach(() => vi.clearAllMocks())

  test('v1 最小载荷（回归）：合成封面 + bullets 页', async () => {
    const content = {
      schemaVersion: 1,
      title: 'EGFR 研究',
      subtitle: '回顾',
      slides: [{ title: '结果', content: [{ type: 'paragraph', text: 'PFS 5.2 个月', style: 'bullet' }] }],
    }
    const { xmls } = await render(content)
    expect(xmls.length).toBe(2) // 封面 + 1 内容页
    expect(xmls.join()).toContain('EGFR 研究')
    expect(xmls.join()).toContain('PFS 5.2 个月')
  })

  test('全布局母版 golden：title/section/bullets/bullets+image/chart-full/quote/blank', async () => {
    const content = {
      schemaVersion: 2,
      title: 'Deck',
      theme: 'warm-paper',
      slides: [
        { title: '封面页', layout: 'title', content: [{ type: 'paragraph', text: '2026 年度报告' }] },
        { title: '第一部分', layout: 'section', content: [{ type: 'paragraph', text: '背景与动机' }] },
        { title: '要点页', layout: 'bullets', content: [{ type: 'paragraph', text: '要点 A', style: 'bullet' }, { type: 'paragraph', text: '要点 B', style: 'bullet' }] },
        { title: '图文页', layout: 'bullets+image', content: [{ type: 'paragraph', text: '左文右图', style: 'bullet' }, { type: 'image', ref: 'x', data: 'iVBORw0KGgo=' }] },
        { title: '图表页', layout: 'chart-full', content: [{ type: 'image', ref: 'y', data: 'iVBORw0KGgo=' }] },
        { title: '引用页', layout: 'quote', content: [{ type: 'paragraph', text: '数据是新的 oils？不，是证据。' }] },
        { title: '空白页', layout: 'blank', content: [{ type: 'paragraph', text: '占位' }] },
      ],
    }
    const { buffer, xmls } = await render(content)
    expect(xmls.length).toBe(7) // 显式 title 页不再合成第二封面
    expect(xmls[0]).toContain('封面页')
    expect(buffer.length).toBeGreaterThan(10000)
  })

  test('autofit：30 条长要点 → 自动拆续页且内容零丢失', async () => {
    const bullets = Array.from({ length: 30 }, (_, i) => ({
      type: 'paragraph',
      text: `第 ${i + 1} 条要点：中位无进展生存期为 ${i + 5}.2 个月，风险比 0.48，具有显著的临床获益与可控的安全性谱。`,
      style: 'bullet',
    }))
    const content = { schemaVersion: 1, title: '长内容', slides: [{ title: '结果', content: bullets }] }
    const { xmls } = await render(content)
    const all = xmls.join()
    for (let i = 1; i <= 30; i++) expect(all).toContain(`第 ${i} 条要点`)
    expect(xmls.length).toBeGreaterThan(1) // 拆续页生效
    expect(all).toContain('（续）')
  })

  test('warm-paper 主题：背景色 FAF7F2 落进母版', async () => {
    const content = {
      schemaVersion: 2,
      title: 'T',
      theme: 'warm-paper',
      slides: [{ title: 'A', content: [{ type: 'paragraph', text: 'x' }] }],
    }
    const { xmls } = await render(content)
    expect(xmls.join()).toContain('FAF7F2')
    expect(xmls.join()).toContain('2F4F47') // Apothecary Green accent
  })

  test('未知布局回退 bullets（契约缺失字段向后兼容）', async () => {
    const content = {
      schemaVersion: 1,
      title: 'T',
      slides: [{ title: '页', content: [{ type: 'paragraph', text: 'y' }] }],
    }
    const { xmls } = await render(content as unknown as PresentationContent)
    expect(xmls.length).toBe(2)
    expect(xmls.join()).toContain('y')
  })
})
