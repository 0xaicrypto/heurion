import { describe, expect, it } from 'vitest'
import { redactPhi, scanPhi, validateIdCard, validateLuhn } from '../src/ops/phi-scan.ts'

describe('PHI 扫描与脱敏测试 (Track D)', () => {
  describe('validateIdCard', () => {
    it('正确验证中国大陆 18 位身份证校验码', () => {
      // 真实有效结构的模拟测试身份证号（满足 MOD 11-2 校验）
      // 11010519491231002X (110105 19491231 002 X)
      // 计算：
      // 1*7 + 1*9 + 0*10 + 1*5 + 0*8 + 5*4 + 1*2 + 9*1 + 4*6 + 9*3 + 1*7 + 2*9 + 3*10 + 1*5 + 0*8 + 0*4 + 2*2
      // = 7+9+0+5+0+20+2+9+24+27+7+18+30+5+0+0+4 = 167
      // 167 % 11 = 2 -> 校验码 checks[2] = 'X'
      expect(validateIdCard('11010519491231002X')).toBe(true)
      expect(validateIdCard('11010519491231002x')).toBe(true)

      // 错误校验码：末位改成 1
      expect(validateIdCard('110105194912310021')).toBe(false)
      // 非法月份 (13月)
      expect(validateIdCard('11010519491331002X')).toBe(false)
      // 非法日期 (2月31日)
      expect(validateIdCard('11010519490231002X')).toBe(false)
      // 长度不合规
      expect(validateIdCard('11010519491231002')).toBe(false)
    })
  })

  describe('validateLuhn', () => {
    it('正确识别符合 Luhn 算法的卡号', () => {
      // 经典的有效 Luhn 卡号 (测试用标准号 49927398716)
      expect(validateLuhn('49927398716')).toBe(true)
      // 常见银行测试卡号 6222020200001234568
      expect(validateLuhn('49927398717')).toBe(false)
    })
  })

  describe('scanPhi & redactPhi', () => {
    it('扫描身份证并脱敏', () => {
      const text = '患者身份证号为 11010519491231002X，请妥善保管。'
      const findings = scanPhi(text)
      expect(findings).toHaveLength(1)
      expect(findings[0]!.type).toBe('id_card')
      expect(findings[0]!.value).toBe('11010519491231002X')
      expect(findings[0]!.redacted).toBe('110105********002X')

      const redacted = redactPhi(text)
      expect(redacted).toBe('患者身份证号为 110105********002X，请妥善保管。')
    })

    it('扫描手机号并脱敏', () => {
      const text = '家属联系电话：13812345678，如有突发情况请致电。'
      const findings = scanPhi(text)
      expect(findings).toHaveLength(1)
      expect(findings[0]!.type).toBe('phone')
      expect(findings[0]!.value).toBe('13812345678')
      expect(findings[0]!.redacted).toBe('138****5678')

      const redacted = redactPhi(text)
      expect(redacted).toBe('家属联系电话：138****5678，如有突发情况请致电。')
    })

    it('扫描就诊号和住院号', () => {
      const text = '门诊就诊记录，住院号: H20261005-01，就诊号：OPD-998877。'
      const findings = scanPhi(text)
      expect(findings.length).toBeGreaterThanOrEqual(2)
      const types = findings.map(f => f.type)
      expect(types).toContain('medical_record_no')
    })

    it('扫描患者姓名与敏感诊断关联', () => {
      const text = '患者姓名：李晓华，经病理检查确诊为浸润性乳腺癌。'
      const findings = scanPhi(text)
      const nameDiag = findings.find(f => f.type === 'name_with_diagnosis')
      expect(nameDiag).toBeDefined()
      expect(nameDiag?.value).toContain('李晓华')
      expect(nameDiag?.value).toContain('乳腺癌')

      const redacted = redactPhi(text)
      expect(redacted).not.toContain('李晓华')
      expect(redacted).toContain('李*')
    })

    it('综合场景：同时存在多种 PHI 实体', () => {
      const complex = `
病历摘要：
患者姓名：王建国，临床确诊为慢性肾衰竭。
住院号: IPD-889922
联系手机: 13900112233
身份证件: 11010519491231002X
`
      const findings = scanPhi(complex)
      expect(findings.length).toBeGreaterThanOrEqual(4)

      const redacted = redactPhi(complex)
      expect(redacted).not.toContain('13900112233')
      expect(redacted).not.toContain('11010519491231002X')
      expect(redacted).toContain('139****2233')
      expect(redacted).toContain('110105********002X')
    })

    it('普通学术论文或化验指标不发生误报', () => {
      const cleanText = `
Study showed that 5-year overall survival was 78.4% (95% CI 72.1-84.7%).
WBC 6.5 x10^9/L, Platelets 220 x10^9/L, ALT 24 U/L.
Reference date was 2026-05-18. DOI: 10.1016/j.cell.2026.01.002.
`
      const findings = scanPhi(cleanText)
      expect(findings).toHaveLength(0)
      expect(redactPhi(cleanText)).toBe(cleanText)
    })
  })
})
