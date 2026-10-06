import { describe, it, expect } from 'vitest'
import { HELP_SECTIONS, buildHelpMarkdown } from '../web/src/help.ts'
import { parseBlocks } from '../src/model/markdown.ts'
import { schema } from '../src/model/schema.ts'

describe('产品使用手册与操作指南 (Product Help & Documentation)', () => {
  it('1. 手册章节结构完整且覆盖所有核心业务模块', () => {
    expect(HELP_SECTIONS.length).toBeGreaterThanOrEqual(8)
    const ids = HELP_SECTIONS.map(s => s.id)
    expect(ids).toContain('overview')
    expect(ids).toContain('privacy')
    expect(ids).toContain('writing')
    expect(ids).toContain('imaging')
    expect(ids).toContain('registration')
    expect(ids).toContain('diagnostics')
    expect(ids).toContain('research')
    expect(ids).toContain('collaboration')
    expect(ids).toContain('faq')

    for (const sec of HELP_SECTIONS) {
      expect(sec.id).toBeTruthy()
      expect(sec.title).toBeTruthy()
      expect(sec.badge).toBeTruthy()
      expect(sec.icon).toBeTruthy()
      expect(sec.summary).toBeTruthy()
      expect(sec.contentHtml.length).toBeGreaterThan(100)
    }
  })

  it('2. 核心临床规范与技术指标真实落地', () => {
    const allHtml = HELP_SECTIONS.map(s => s.contentHtml).join('\n')
    
    // 零 PHI 与患者档案安全准则
    expect(allHtml).toContain('零 PHI')
    expect(allHtml).toContain('纯虚拟代号建档')
    expect(allHtml).toContain('本机浏览器备注名物理隔离')
    expect(allHtml).toContain('AES-256-GCM')
    expect(allHtml).toContain('待确认操作卡')
    
    // 多模态化验与单位归一化
    expect(allHtml).toContain('国际标准单位归一化')
    expect(allHtml).toContain('原件精准溯源')
    
    // 影像量化指标与 MONAI 模型矩阵
    expect(allHtml).toContain('BAR')
    expect(allHtml).toContain('高密度粘液栓')
    expect(allHtml).toContain('MONAI')
    expect(allHtml).toContain('SegResNet')
    expect(allHtml).toContain('PI-RADS')
    expect(allHtml).toContain('Agatston')
    expect(allHtml).toContain('TotalSegmentator')
    expect(allHtml).toContain('MPR')
    expect(allHtml).toContain('横断面 (Axial)')
    expect(allHtml).toContain('NiiVue 3D WebGL2')
    expect(allHtml).toContain('定位病灶中心')
    expect(allHtml).toContain('保存切片为文档资产')
    
    // 双期 3D 刚性配准与差分热力图
    expect(allHtml).toContain('刚性/仿射配准')
    expect(allHtml).toContain('差分吸收热力图')
    expect(allHtml).toContain('双联屏联动切片滑动')
    expect(allHtml).toContain('RECIST 1.1')
    
    // 多模态因果诊断链与国际标准导出
    expect(allHtml).toContain('变应性支气管肺曲霉病')
    expect(allHtml).toContain('DICOM SR')
    expect(allHtml).toContain('HL7 FHIR')
    
    // 临床科研与知家
    expect(allHtml).toContain('Table 1')
    expect(allHtml).toContain('Kaplan-Meier')
    expect(allHtml).toContain('知家')
  })

  it('3. Markdown 手册生成与文档块结构解析验证', () => {
    const md = buildHelpMarkdown()
    expect(md).toContain('# Heurion 临床智能工作站 · 全流程使用手册与操作指南')
    expect(md).toContain('## 一、 快速上手与界面导览')
    expect(md).toContain('## 四、 患者管理与 3D 影像量化分析')
    expect(md).toContain('## 五、 双期 3D 刚性配准与差分吸收热力图')
    expect(md).toContain('纯虚拟代号建档')
    expect(md).toContain('支气管-伴行动脉比 (BAR)')
    expect(md).toContain('NiiVue 3D WebGL2')
    
    // 验证 parseBlocks 能够顺利将生成的 markdown 转换成 ProseMirror 节点
    const blocks = parseBlocks(md)
    expect(blocks.length).toBeGreaterThan(10)
    
    const docNode = schema.node('doc', null, blocks)
    expect(docNode).toBeDefined()
    expect(docNode.type.name).toBe('doc')
    expect(docNode.childCount).toBeGreaterThan(10)
  })
})
