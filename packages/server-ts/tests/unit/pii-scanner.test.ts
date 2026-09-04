import { describe, test, expect } from 'vitest'
import { scanPii, scanSkillPii } from '../../src/common/pii-scanner.js'

/**
 * #842 — PII 扫描器:skill 落库前强制闸门。
 * 验收:姓名/住院号样本命中即拒;正常流程文本放行。
 */

describe('scanPii', () => {
  test('住院号命中即拒', () => {
    const r = scanPii('先调出患者资料，住院号：2025088123,再开始写小结')
    expect(r.clean).toBe(false)
    expect(r.hits.some((h) => h.kind === 'medical_record_no')).toBe(true)
  })

  test('上下文锚定的患者姓名命中即拒', () => {
    const r = scanPii('把患者张伟的病理结果整理成表')
    expect(r.clean).toBe(false)
    expect(r.hits.some((h) => h.kind === 'person_name')).toBe(true)
  })

  test('手机号/身份证/patient_hash 命中即拒', () => {
    expect(scanPii('联系电话 13812345678').clean).toBe(false)
    expect(scanPii('证件 11010119900307891X').clean).toBe(false)
    expect(scanPii('关联 ph_9f83ka2b 的记录').clean).toBe(false)
  })

  test('正常流程文本放行(无身份锚点/号码)', () => {
    const r = scanPii('1. 打开文献库检索 PMID\n2. 复核纳入排除标准\n3. 按 AMA 格式写入 References')
    expect(r.clean).toBe(true)
    expect(r.hits).toEqual([])
  })

  test('普通医学名词不误报', () => {
    expect(scanPii('对高危患者群体建议随访').clean).toBe(true)
    expect(scanPii('主任查房意见需记录').clean).toBe(true)
  })
})

describe('scanSkillPii', () => {
  test('剧本任一字段命中即拒', () => {
    const r = scanSkillPii({
      name: '出院小结生成流程',
      description: '按科室模板生成',
      steps: ['填写住院号 2025088123', '复制检验结果'],
      promptTemplate: '请为患者李娜生成出院小结',
    })
    expect(r.clean).toBe(false)
    expect(r.hits.map((h) => h.kind)).toContain('medical_record_no')
    expect(r.hits.map((h) => h.kind)).toContain('person_name')
  })
})
