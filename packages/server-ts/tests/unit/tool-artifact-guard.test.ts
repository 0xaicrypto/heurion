import { describe, it, expect } from 'vitest'
import { isToolArtifactNotification } from '../../src/memory/memory.types.js'

/**
 * #836-followup: 工具完成通知("已生成 xxx.pptx")不得成为记忆 —
 * 生产实例:Anlotinib_*.pptx.pptx 被立为 summary、压缩提取把
 * "AI已生成英文PPT文件…"立为任务状态事实。守卫必须在 propose
 * 闸门统一拦截。
 */
describe('isToolArtifactNotification', () => {
  it('拦截中文生成通知(实际生产垃圾样本)', () => {
    expect(isToolArtifactNotification('已生成 "Anlotinib_radioimmunotherapy_NSCLC.pptx.pptx"。')).toBe(true)
    expect(isToolArtifactNotification('已生成 "RILI_Akk_HTau_ACO2_axis_evidence_table.docx"。')).toBe(true)
  })

  it('拦截英文渲染通知与前缀变体', () => {
    expect(isToolArtifactNotification('Rendered "Case_Summary.docx".')).toBe(true)
    expect(isToolArtifactNotification('AI已生成英文PPT文件“帮我做一个英文版本的PPTX.pptx”，但用户后续仍要求修改')).toBe(true)
    expect(isToolArtifactNotification('文件已生成 report.pdf')).toBe(true)
  })

  it('不误伤正常临床/知识内容', () => {
    expect(isToolArtifactNotification('医生建议每周复查一次肝功能')).toBe(false)
    expect(isToolArtifactNotification('EGFR 突变的 NSCLC 患者可从免疫治疗中获益')).toBe(false)
    expect(isToolArtifactNotification('用户的报告已上传到系统')).toBe(false)
    expect(isToolArtifactNotification('已生成的报告需要医生复核签字')).toBe(false)
    expect(isToolArtifactNotification('')).toBe(false)
  })
})
