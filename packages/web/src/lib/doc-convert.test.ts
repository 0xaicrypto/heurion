import { describe, test, expect } from 'vitest'
import { markdownToHtml, htmlToMarkdown } from './doc-convert'

/**
 * #837 — md ↔ HTML 往返回归保护。
 * 审阅机制的全部落地路径都经过 markdownToHtml → tiptap → htmlToMarkdown;
 * 往返不保值时,接受 AI 修改就会破坏文档结构(生产事故:\## 逃逸、标题
 * 粘进段落)。以下为结构不变量(非逐字节等价)。
 */
function roundTrip(md: string): string {
  return htmlToMarkdown(markdownToHtml(md))
}

describe('doc-convert markdown round-trip (#837)', () => {
  test('标题层级保持块结构 — 不粘连、无 \\/# 逃逸', () => {
    const md = '# 主标题\n\n## Introduction\n\nEGFR mutations occur in NSCLC.\n\n### 子节\n\n正文段落。'
    const out = roundTrip(md)
    expect(out).toMatch(/(^|\n)#{1,6}\s*Introduction/)
    expect(out).toMatch(/(^|\n)#{1,3}\s*子节/)
    expect(out).not.toContain('\\#')
    // 标题与正文分属不同行
    expect(out).toMatch(/Introduction\n\n?EGFR mutations/)
    expect(out).toMatch(/子节\n\n?正文段落/)
  })

  test('列表与有序列表保持', () => {
    const md = '- 列表项一\n- 列表项二\n\n1. 有序一\n2. 有序二'
    const out = roundTrip(md)
    expect(out).toContain('列表项一')
    expect(out).toContain('列表项二')
    expect(out).toContain('有序一')
    expect(out).toContain('有序二')
  })

  test('GFM 表格往返保持管道结构', () => {
    const md = '| 药物 | 剂量 |\n|---|---|\n| A | 100mg |\n| B | 200mg |'
    const out = roundTrip(md)
    expect(out).toContain('|')
    expect(out).toContain('A')
    expect(out).toContain('100mg')
    expect(out).toContain('B')
  })

  test('行内样式(加粗/斜体/行内代码/链接)保持', () => {
    const md = '含**加粗**、*斜体*、`代码`与[链接](https://example.com)的段落。'
    const out = roundTrip(md)
    expect(out).toContain('**加粗**')
    expect(out).toContain('链接')
  })

  test('多段落后往返不合并成一段', () => {
    const md = '第一段。\n\n第二段。\n\n第三段。'
    const out = roundTrip(md)
    expect(out).toMatch(/第一段。\n\n?第二段。/)
    expect(out).toMatch(/第二段。\n\n?第三段。/)
  })

  test('#1037 删除线 ~~ 语法往返保持(此前 turndown 无内置规则,静默丢失)', () => {
    const out = roundTrip('含~~删除线~~的段落')
    expect(out).toContain('~~删除线~~')
  })

  test('#1037 链接 href 往返保持(含 title 之外的主链路)', () => {
    const out = roundTrip('跳转到 [Heurion](https://heurion.ai) 首页')
    expect(out).toContain('[Heurion](https://heurion.ai)')
  })

  test('#1037 任务列表勾选态以 - [x] / - [ ] 保留', () => {
    const out = roundTrip('- [x] 已完成\n- [ ] 待办')
    expect(out).toMatch(/- \[x\] 已完成/)
    expect(out).toMatch(/- \[ \] 待办/)
  })

  test('#1037 代码块语言标注往返保持', () => {
    const out = roundTrip('```python\nprint("hi")\n```')
    expect(out).toMatch(/```python/)
  })

  // #1054: Underline 全链路 — markdown 无下划线行内语法，采用 <u> HTML 直通
  // （GitHub 同款方案）。sanitize 白名单只放行纯文本内容的 <u>，属性与
  // 嵌套标签一律剥离，不因此放开全量 HTML 直通。
  describe('#1054 <u> 下划线直通存储', () => {
    test('用例1: <u> 标记 round-trip 保值（此前 turndown 无规则静默丢 mark）', () => {
      const out = roundTrip('含<u>下划线</u>的段落')
      expect(out).toContain('<u>下划线</u>')
    })

    test('用例2: <u> 内嵌 <script> → script 连内容剥离，仅保留 u', () => {
      const html = markdownToHtml('段落<u><script>alert(1)</script>安全文本</u>')
      expect(html).toContain('<u>安全文本</u>')
      expect(html).not.toContain('<script')
      expect(html).not.toContain('alert(1)')
    })

    test('用例2: <u> 属性剥离（on* 事件注入面归零）', () => {
      const html = markdownToHtml('<u onclick="evil()" onmouseover="x()">下划线</u>')
      expect(html).toContain('<u>下划线</u>')
      expect(html).not.toContain('onclick')
      expect(html).not.toContain('onmouseover')
    })

    test('用例2: <u> 嵌套其他标签剥离（只保留纯文本内容）', () => {
      const html = markdownToHtml('<u><b>加粗</b>与<img src="x" onerror="y"></u>')
      expect(html).toContain('<u>加粗与</u>')
      expect(html).not.toContain('<b>')
      expect(html).not.toContain('<img')
    })

    test('保存侧: <u> 携带属性经 turndown 规则重写为纯 <u>', () => {
      expect(htmlToMarkdown('<u onclick="evil()">下划线</u>')).toContain('<u>下划线</u>')
    })

    // #1066-4: 嵌套/残缺 <u> 的平衡输出 — 此前非贪婪配对把外层 </u> 留成
    // 游离闭标签，</u > 变体不识别直接透传。
    test('#1066-4: 嵌套 <u> 拍平输出，不残留游离 </u>', () => {
      const html = markdownToHtml('段落<u>b<u>c</u>d</u>尾部')
      // 嵌套内层被剥离后拍平为单层（配对消费非贪婪，外层残余闭标签被清除）
      expect(html).toContain('<u>bc</u>')
      // 开/闭标签数量平衡（修复前存在游离 </u>，闭多于开）
      expect((html.match(/<u>/g) ?? []).length).toBe((html.match(/<\/u>/g) ?? []).length)
    })

    test('#1066-4: </u > 闭标签变体被识别，不透传原始形态', () => {
      const html = markdownToHtml('<u>a</u >')
      expect(html).toContain('<u>a</u>')
      expect(html).not.toContain('</u >')
    })

    test('#1066-4: 孤立闭标签（无匹配开标签）被剥离', () => {
      const html = markdownToHtml('前</u >中<u>后</u>')
      expect(html).toContain('<u>后</u>')
      expect(html).not.toContain('</u >')
      expect((html.match(/<u>/g) ?? []).length).toBe((html.match(/<\/u>/g) ?? []).length)
    })

    test('用例5: 无 <u> 的既有内容不受 sanitize 影响（回归）', () => {
      const html = markdownToHtml('含**加粗**与[链接](https://example.com)的段落')
      expect(html).toContain('<strong>加粗</strong>')
      expect(html).toContain('<a href="https://example.com">链接</a>')
      expect(html).not.toContain('<u>')
      // 数学预处理产出的 data 属性 HTML 不被误伤（#fix 链路回归）。
      const math = markdownToHtml('$$x^2$$')
      expect(math).toContain('data-type="block-math"')
    })
  })

  // #1061: 嵌套任务列表 round-trip — 此前 turndown taskItem 规则丢失缩进,
  // 保存重载后子项被拍平成同级任务项(结构静默丢失)。
  describe('#1061 嵌套任务列表 round-trip', () => {
    test('父子两级嵌套保存重载层级结构保留(GFM 子项缩进)', () => {
      const out = roundTrip('- [x] 父任务\n  - [ ] 子任务')
      expect(out).toMatch(/- \[x\] 父任务\n {2,4}- \[ \] 子任务/)
      expect(out).not.toMatch(/- \[x\] 父任务\n- \[ \]/)
    })

    test('嵌套下父子勾选状态分别保留', () => {
      const out = roundTrip('- [ ] 父任务\n  - [x] 子任务')
      expect(out).toMatch(/- \[ \] 父任务\n {2,4}- \[x\] 子任务/)
    })

    test('保存侧: 编辑器 tiptap 形态的嵌套 taskItem HTML 缩进输出', () => {
      const tiptapHtml =
        '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>父任务</p>' +
        '<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>子任务</p></li></ul></li></ul>'
      const out = htmlToMarkdown(tiptapHtml)
      expect(out).toMatch(/- \[x\] 父任务\n {2,4}- \[ \] 子任务/)
    })

    test('平铺任务列表回归: 不引入多余缩进', () => {
      const out = roundTrip('- [x] 甲\n- [ ] 乙')
      expect(out).toMatch(/- \[x\] 甲\n- \[ \] 乙/)
      expect(out).not.toMatch(/\n {2,}-/)
    })
  })

  test('AI 写回典型形态(标题+小节+列表)整篇往返', () => {
    const md = [
      '# 论文标题',
      '',
      '## Introduction',
      '',
      '背景段落一。',
      '',
      '### EGFR-Mutant NSCLC and the TKI Era',
      '',
      'EGFR mutations occur in approximately 15–50% of patients.',
      '',
      '- 首次应用',
      '- 填补空白',
      '',
      '## Methods',
      '',
      '回顾性真实世界研究。',
    ].join('\n')
    const out = roundTrip(md)
    expect(out).toMatch(/### EGFR-Mutant NSCLC and the TKI Era/)
    expect(out).toMatch(/Era\n\n?EGFR mutations occur/)
    expect(out).not.toContain('\\#')
    expect(out).toMatch(/-\s+首次应用/)
  })
})
