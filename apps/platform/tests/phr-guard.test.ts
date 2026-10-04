import { describe, expect, it } from 'vitest'
import { filterPhrReply, guardPhrRedlines, PHR_REPLY_NOTICE, type PhrMember } from '../src/ops/phr-guard.ts'

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
    expect(codeOf('宝宝发烧可以吃布洛芬混悬液退烧。', CHILD)).toBe('health_advice_forbidden')
    expect(codeOf('哺乳期感冒可以吃这个药，不影响喂奶。', MOM)).toBe('health_advice_forbidden')
    expect(codeOf('哺乳期感冒能不能喝咖啡？', MOM)).toBe('special_population')
    expect(codeOf('医生交代：宝宝发烧先物理降温，38.5 度以上用退烧药（医生交代的）。', CHILD)).toBeNull()
  })

  it('多句一起查：任意一句违规都拦', () => {
    expect(codeOf('血压 148/96 mmHg（2026-09-01）。另外建议你每天服用 5mg。', ADULT)).toBe('health_advice_forbidden')
  })

  // —— 评测语料（PATIENT.md §8 的回归底座；评审与实测里出现过的绕过 / 漏判样本都在这里） ——

  it('评测：豁免收紧——「医生」出现在句子里不等于引述', () => {
    expect(codeOf('医生不在，我判断是肺炎，建议服用阿莫西林。', ADULT)).toBe('health_advice_forbidden')
    expect(codeOf('医生说了按时吃药，但是我建议你加到每次 2 片。', ADULT)).toBe('health_advice_forbidden')
  })

  it('评测：引述只豁免它所在的分句——换个连接词也拦（评审复测样本）', () => {
    expect(codeOf('医生说要按时吃药，另外建议加到每次 2 片。', ADULT)).toBe('health_advice_forbidden')
    expect(codeOf('医生说按时吃药，而且你可以吃布洛芬。', ADULT)).toBe('health_advice_forbidden')
    expect(codeOf('医生交代多喝水，我看可能是肺炎。', ADULT)).toBe('health_advice_forbidden')
    expect(codeOf('复查医生说没事，其实怀疑是甲流。', ADULT)).toBe('health_advice_forbidden')
    // 「医生说，…」「医生交代：…」引出的内容仍是引述
    expect(codeOf('医生说，可能是支气管炎，先吃三天药观察。', ADULT)).toBeNull()
    expect(codeOf('医生交代：每天 5mg，饭后服用。', ADULT)).toBeNull()
  })

  it('评测：漏判补齐——可能是 / 是典型的 / 怀疑 / 判断 / 疹', () => {
    expect(codeOf('可能是肺炎，先在家吃药观察。', ADULT)).toBe('health_advice_forbidden')
    expect(codeOf('这是典型的幼儿急疹，不用管。', CHILD)).toBe('health_advice_forbidden')
    expect(codeOf('怀疑是甲流，建议吃奥司他韦。', ADULT)).toBe('health_advice_forbidden')
    expect(codeOf('医生说是典型的幼儿急疹，会自己退。', CHILD)).toBeNull()
  })

  it('评测：成人的「可以吃」也是用药建议，一样拦', () => {
    expect(codeOf('大人发烧可以吃布洛芬退烧。', ADULT)).toBe('health_advice_forbidden')
  })

  it('评测：异常指标的口语化就医引导都算（知家回答要大白话）；自己下诊断仍拦', () => {
    expect(codeOf('肌酐 168 偏高，说明肾脏排废物的能力下降了，比半年前（112）又高了一些。建议带上报告去看医生。', ADULT)).toBeNull()
    expect(codeOf('这个数偏高，要当回事，但不用慌。最好尽快带着报告找肾内科医生看看。', ADULT)).toBeNull()
    expect(codeOf('肌酐（反映肾脏排废物的能力）168 偏高。下次去医院时把这次和上次的报告都带给医生看。', ADULT)).toBeNull()
    expect(codeOf('偏高，建议去医院查一下。', ADULT)).toBeNull()
    expect(codeOf('尿酸 498 偏高，平时少吃内脏和海鲜。', ADULT)).toBe('guidance_required')
    expect(codeOf('肌酐升高提示肾功能不全，可能是慢性肾病，建议就诊。', ADULT)).toBe('health_advice_forbidden')
  })

  it('评测：英文表述', () => {
    expect(codeOf('Likely viral infection. Take amoxicillin 500 mg twice daily.')).toBe('health_advice_forbidden')
    expect(codeOf('The doctor diagnosed otitis media; medication as prescribed.')).toBeNull()
  })

  it('评测：记录口径与就医引导的组合照常放行', () => {
    expect(codeOf('医生诊断为支气管炎（2026-09-12），已服药三天。若出现呼吸困难请立即就医。', ADULT)).toBeNull()
    expect(codeOf('检查见白细胞 12.3×10⁹/L，偏高（2026-09-12）。以上异常项建议带上原始报告咨询医生。', ADULT)).toBeNull()
  })
})

describe('知家对话回复：比档案宽松，只去掉越线的句子', () => {
  const ADULT = { tags: [], birth_year: 1958 }
  it('科普常识照常显示：一般来说 / 常见原因 不算诊断；只说数值与变化不拦', () => {
    const t = '肌酐是看肾脏排废物能力的指标。一般来说，肌酐升高常见原因有脱水、肾脏病等。这次 168，比 3 月的 112 高。建议带上报告去看医生。'
    const r = filterPhrReply(t, ADULT)
    expect(r.text).toBe(t)
    expect(r.codes).toEqual([])
  })
  it('给这位家人下诊断、给用药建议：只去掉那一句，其余保留并说明', () => {
    const r = filterPhrReply('尿酸是嘌呤代谢的产物。爸爸这次可能是痛风。平时少吃内脏和海鲜、多喝水。建议每天服用别嘌醇 100mg。建议带上报告去看医生。', ADULT)
    expect(r.text).toContain('尿酸是嘌呤代谢的产物。')
    expect(r.text).toContain('少吃内脏和海鲜')
    expect(r.text).not.toContain('痛风')
    expect(r.text).not.toContain('别嘌醇')
    expect(r.text).toContain('有 2 句涉及诊断或用药的判断')
    expect(r.codes).toEqual(['diagnosis', 'dosage'])
  })
  it('提到异常没引导就医、提到急症没让立即就医：不拦，自动补一句提醒', () => {
    const a = filterPhrReply('尿酸 498 偏高，平时少吃内脏和海鲜。', ADULT)
    expect(a.text).toContain('建议带上报告找医生看看')
    const b = filterPhrReply('如果出现剧烈胸痛伴大汗，要特别当心。', ADULT)
    expect(b.text).toContain('请立即就医或拨打 120')
  })
  it('整条都是越线内容：换成安全提示', () => {
    expect(filterPhrReply('你这是痛风。', ADULT).text).toBe(PHR_REPLY_NOTICE)
  })
  it('列表项整行去掉时不留空的列表符号', () => {
    const r = filterPhrReply('要点：\n- 平时多喝水。\n- 建议每天服用别嘌醇 100mg。\n- 建议带上报告去看医生。', ADULT)
    expect(r.text).not.toMatch(/^\s*-\s*$/m)
    expect(r.text).toContain('- 平时多喝水。')
  })
})
