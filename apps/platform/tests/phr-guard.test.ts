import { describe, expect, it } from 'vitest'
import { guardPhrRedlines, type PhrMember } from '../src/ops/phr-guard.ts'

/** 跑一次守卫，返回失败码（通过返回 null）。 */
const codeOf = (text: string, member: PhrMember | null = null): string | null => {
  try { guardPhrRedlines(text, 0, member); return null } catch (e) { return (e as { code?: string }).code ?? null }
}

const MOM = { tags: ['孕产'], birth_year: 1993 }
const CHILD = { tags: [], birth_year: 2022 }
const ADULT = { tags: [], birth_year: 1988 }

describe('患者红线守卫（PATIENT.md §3）', () => {
  it('诊断结论：AI 自己下诊断拦截；记录医生口径放行', () => {
    expect(codeOf('宝宝这个情况考虑是支气管炎。', CHILD)).toBe('health_advice_forbidden')
    expect(codeOf('符合川崎病的诊断标准，可以确诊为川崎病。')).toBe('health_advice_forbidden')
    expect(codeOf('医生诊断为支气管炎，已开始治疗。')).toBeNull()
    expect(codeOf('出院诊断：急性支气管炎；恢复良好。')).toBeNull()
    expect(codeOf('体检报告查出甲状腺结节 2 类。')).toBeNull()
  })

  it('用药 / 剂量：AI 的建议与带剂量的指令拦截；记录医嘱放行', () => {
    expect(codeOf('建议每天服用 5mg。')).toBe('health_advice_forbidden')
    expect(codeOf('每次 0.5 片即可，不用加量。')).toBe('health_advice_forbidden')
    expect(codeOf('建议改用头孢类抗生素。')).toBe('health_advice_forbidden')
    expect(codeOf('每天 5mg，医生交代的，先这样吃。')).toBeNull()
    expect(codeOf('医生让停用阿司匹林，改用氯吡格雷。')).toBeNull()
  })

  it('统计性论断要有出处；自己化验值的记录不拦', () => {
    expect(codeOf('他汀治疗可降低 44% 的复发风险。')).toBe('unsourced_claim')
    expect(codeOf('他汀治疗可降低 44% 的复发风险 [@c:c1]。')).toBeNull()
    expect(codeOf('糖化血红蛋白 7.2%（2026-09-01），比上次 6.8% 略升高。')).toBeNull()
  })

  it('急症表现必须有就医引导，且不得展开分析', () => {
    expect(codeOf('半夜突然剧烈胸痛伴大汗，可先在家观察一小时。')).toBe('emergency_overreach')
    expect(codeOf('半夜突然剧烈胸痛伴大汗——出现这些情况请立即就医 / 拨打 120。')).toBeNull()
  })

  it('异常指标块要带引导就医的话；正常记录不拦', () => {
    expect(codeOf('空腹血糖 7.8 mmol/L（2026-09-01），高于参考。')).toBe('guidance_required')
    expect(codeOf('空腹血糖 7.8 mmol/L（2026-09-01），高于参考。以上异常项建议带上原始报告咨询医生。')).toBeNull()
    expect(codeOf('空腹血糖 5.2 mmol/L（2026-09-01），在参考范围内。')).toBeNull()
  })

  it('肿瘤相关内容只记录，不做解读性展开', () => {
    expect(codeOf('CEA 5.2 ng/ml，提示可能有复发风险。')).toBe('presentation_tier')
    expect(codeOf('CEA 5.2 ng/ml（2026-09-01，医生交代的复查安排）。')).toBeNull()
  })

  it('特殊人群：孕产 / 哺乳 / 儿童不给用药建议；成人不受限', () => {
    expect(codeOf('宝宝发烧可以吃布洛芬混悬液退烧。', CHILD)).toBe('special_population')
    expect(codeOf('哺乳期感冒可以吃这个药，不影响喂奶。', MOM)).toBe('special_population')
    expect(codeOf('宝宝发烧可以吃布洛芬混悬液退烧。', ADULT)).toBeNull()
    expect(codeOf('医生交代：宝宝发烧先物理降温，38.5 度以上用退烧药（医生交代的）。', CHILD)).toBeNull()
  })

  it('多句一起查：任意一句违规都拦', () => {
    expect(codeOf('血压 148/96 mmHg（2026-09-01）。另外建议你每天服用 5mg。', ADULT)).toBe('health_advice_forbidden')
  })
})
