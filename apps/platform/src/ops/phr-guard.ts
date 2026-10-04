import { OpError } from './types.ts'

/**
 * 患者红线守卫（docs/design/PATIENT.md §3）：知家成员「健康档案」（doc 归属 doc_kind=archive）的 AI 写入，
 * 写前硬闸、只对 AI。目标不是医疗审查，而是拦住「AI 越界给出诊疗结论」：
 * - 记录口径放行（「医生诊断为…」「出院诊断：…」「每天 0.4mg，医生交代的」）；
 * - AI 自己下诊断、提用药 / 剂量 / 停换建议、无出处的统计论断、缺就医引导的急症与异常指标、肿瘤内容解读性展开 → 拦截，
 *   失败码与 hint 告诉模型怎么改写（改成记录 + 引导就医）。
 * 模式匹配是 v1 的口径：宁可拦下让模型改写，不放行越界内容；评测集（PATIENT.md §8）持续回归。
 */

export interface PhrMember { tags: string[]; birth_year: number | null }

/** 诊断结论句式：判断 / 怀疑 / 可能是 / 是典型的 + 医学名词，或确诊 / 符合诊断；英文同理。 */
const DIAG = /(?:诊断[为是]|确诊[为是]|考虑[是为]|判断[为是]|怀疑(?:是)?|可能是|是典型的)[^。]{0,10}(?:炎|症|病|瘤|癌|疹|综合征|感染|结石|结节|甲流|乙流|流感)|符合[^。]{0,16}(?:诊断|表现)|\b(?:diagnos(?:is|ed)(?:\s+with)?|you\s+have|likely\s+[a-z]+)\b/i
/**
 * 引述口径才放行：引述者要紧邻结论（医生诊断为…／医生说…／医生建议…／出院诊断：…／体检报告查出…）。
 * 引述者与结论之间出现「不 / 没 / 我 / 你 / 他 / 她 / 家」即不是引述——「医生不在，我判断是肺炎」拦下。
 */
const QGAP = '[^。；！？，,不没我你他她家]{0,6}'
const QUOTED = new RegExp(
  `(?:医生|大夫|医院|门诊|出院|入院|体检报告|随访|复查|检查)${QGAP}(?:诊断[为是]|确诊[为是]|考虑[是为]|判断[为是]|说|交代|开了?|让|查出|告知|建议)|(?:出院|入院|门诊)诊断[:：]|\\b(?:doctor|hospital)[^。]{0,6}(?:diagnos|said|told|prescrib)`,
  'i',
)
/** 用药 / 剂量建议（指令式；「可以吃」「建议吃」「加到每次 X 片」都算——记录医嘱走引述口径）。 */
const DOSAGE = /(?:改用|换用|停用|停掉|加量|减量|剂量[^。]{0,8}(?:改|调)|(?:加|减)(?:到|为)[^。]{0,6}\d+(?:\.\d+)?\s*(?:mg|毫克|片|粒|ml|毫升|滴)|(?:建议|应当?|需要|推荐|不妨|试试)[^。]{0,16}(?:服用|口服|外用|注射|静点|输注|使用|加用|吃)|(?:可以|不妨|试试)[^。]{0,6}(?:吃|服用|用上|注射)|(?:每日|每天|每次|一天)\s*\d+(?:\.\d+)?\s*(?:mg|毫克|微克|μg|ml|毫升|片|粒|支|袋|喷|滴|iu|国际单位)[^。]{0,10}(?:建议|应|需|即可|就行)|\b(?:take|prescrib)\w*[^。]{0,12}\d+\s*mg\b)/i
/** 统计性论断（研究口径的数字）＋断言词：要有出处。 */
const STAT = /\b(?:HR|OR|RR|CI)\b|\d+(?:\.\d+)?\s*[%％]|\b[Pp]\s*[<=＜]\s*0?\.\d+/
const ASSERT = /(?:风险|有效|相关|导致|预防|获益|复发|存活|死亡)/
/** 急症表现：出现就只允许「立即就医」类内容。 */
const CRITICAL = /(?:剧烈胸痛|胸痛[^。]{0,6}(?:持续|不缓解)|大汗|呼吸困难|意识不清|意识丧失|晕厥|抽搐[^。]{0,4}(?:不止|持续)|剧烈[^。]{0,4}(?:腹痛|头痛)|大量出血|高热惊厥|胎动[^。]{0,4}减少|一侧(?:肢体|手脚)?无力|言语不清)/
/** 就医引导话术（急症 / 异常指标块里必须有其一）。 */
const SEEK = /(?:立即|马上|尽快|及时)(?:就医|去?急诊|到医院|看医生)|(?:拨打|打)\s*120|急诊(?:科|室)/
/** 肿瘤相关：数值可以记录，解读性展开拦下。 */
const ONCO = /(?:肿瘤标志物|甲胎蛋白|\bAFP\b|癌胚抗原|\bCEA\b|\bCA\s?-?125\b|\bCA\s?-?19-?9\b|\bCA\s?-?153\b|\bPSA\b|前列腺特异(?:性)?抗原|\bNSE\b|鳞状细胞癌)/i
const ONCO_INTERPRET = /(?:提示|考虑|可能是|复发|转移|恶化|晚期|倾向)/
/** 异常指标（块级检查：整块里要有引导就医的话）。 */
const ABNORMAL = /(?:偏高|偏低|超标|阳性|高于参考|低于参考|超出参考)/
/** 特殊人群（孕产 / 哺乳 / 儿童）的用药建议（含问句口径的「可以吃」）。 */
const SPECIAL_MED = /(?:(?:建议|应当?|需要|推荐|不妨)[^。]{0,16}(?:吃|服用|口服|使用|注射|外用|喝)|(?:可以|能不能|能否|该不该|要不要)(?:吃|用|服|喝|打))/

const sentences = (text: string): string[] => text.split(/(?<=[。！？；!?])/)

/** 分句之间的连接词：转折、递进、插入的个人判断（引述不跨过它们）。 */
const CONNECTOR = /(?:但是|不过|然而|可是|另外|而且|并且|同时|此外|其实|所以|因此|我看|我觉得|我认为|个人认为|但)/
/**
 * 把一句拆成分句（逗号、顿号与连接词处断开），标出每个分句是否属于引述：
 * 分句自己含引述（医生说… / 出院诊断：…），或紧跟在引述分句之后且没有另起主语（不以连接词或「我 / 你」开头）。
 */
function clauses(s: string): Array<{ text: string; quoted: boolean }> {
  const parts = s.split(/[，,、]|(?=(?:但是|不过|然而|可是|另外|而且|并且|同时|此外|其实|所以|因此|我看|我觉得|我认为|个人认为))/).map(x => x.trim()).filter(Boolean)
  const out: Array<{ text: string; quoted: boolean }> = []
  let lead = false
  for (const text of parts) {
    const own = QUOTED.test(text)
    // 紧跟引述、没有另起主语的分句仍是引述（「医生让停用阿司匹林，改用氯吡格雷」）；
    // 以连接词或「我 / 你」开头的分句是另起的话（「…，另外建议…」「…，我看…」），不沿用引述
    const quoted: boolean = own || (lead && !CONNECTOR.test(text.slice(0, 4)) && !/^(?:我|你)/.test(text))
    out.push({ text, quoted })
    lead = quoted
  }
  return out
}

/** 单句的越界建议（诊断 / 用药），返回违规信息（合规返回 null）。 */
function adviceViolation(s: string): 'diag' | 'dosage' | null {
  if (DIAG.test(s)) return 'diag'
  if (DOSAGE.test(s)) return 'dosage'
  return null
}

/** 对一句越界建议抛 OpError。 */
function throwAdvice(kind: 'diag' | 'dosage', opIndex: number): never {
  if (kind === 'diag') {
    throw new OpError('health_advice_forbidden', '不能由 AI 给出诊断结论', {
      op_index: opIndex,
      hint: '诊断只能来自医生的病历：改成引述口径（如「医生诊断为…」「出院诊断：…」），或改为描述症状并建议咨询医生。',
    })
  }
  throw new OpError('health_advice_forbidden', '不能由 AI 提出用药 / 剂量 / 停换药建议', {
    op_index: opIndex,
    hint: '医生交代的用法可以记录（写明「医生交代 / 医嘱」）；不要由你提出用药、剂量或停换药建议。',
  })
}

/** 对一段 AI 拟写入的文字做红线检查；违规抛 OpError（带失败码与 hint）。 */
export function guardPhrRedlines(text: string, opIndex: number, member: PhrMember | null): void {
  for (const s of sentences(text)) {
    // 引述只豁免它所在的分句：按逗号与连接词拆成分句逐个查（「医生说按时吃药，另外建议加到 2 片」后一句照拦）
    for (const part of clauses(s)) {
      const advice = adviceViolation(part.text)
      if (advice && !part.quoted) throwAdvice(advice, opIndex)
    }
    if (STAT.test(s) && ASSERT.test(s) && !/\[@c:[a-z0-9]+\]/.test(s)) {
      throw new OpError('unsourced_claim', '这句统计性论断没有出处', {
        op_index: opIndex,
        hint: '用 pubmed_search 找证据 → insert_citation 登记 → 正文写返回的 [@c:id]；或改写为不含统计结论的记录。',
      })
    }
    if (CRITICAL.test(s) && !SEEK.test(s)) {
      throw new OpError('emergency_overreach', '出现急症表现的描述但缺少就医引导', {
        op_index: opIndex,
        hint: '涉及急症表现时只记录事实，并写明「出现这些情况请立即就医 / 拨打 120」；不要展开分析。',
      })
    }
    if (ONCO.test(s) && ONCO_INTERPRET.test(s)) {
      throw new OpError('presentation_tier', '肿瘤相关内容不要做解读性展开', {
        op_index: opIndex,
        hint: '只记录数值、日期与医生交代；解读与随访安排由医生进行，可写「具体听复查医生的建议」。',
      })
    }
  }
  if (ABNORMAL.test(text) && !SEEK.test(text) && !/(?:咨询(?:医生|大夫)|复诊|遵医嘱|问(?:医生|大夫))/.test(text)) {
    throw new OpError('guidance_required', '提到异常指标但没有引导就医', {
      op_index: opIndex,
      hint: '在本块末尾加一句「以上异常项建议带上原始报告咨询医生」。',
    })
  }
  if (member) {
    const year = new Date().getFullYear()
    const special = member.tags.includes('孕产') || member.tags.includes('哺乳') || (member.birth_year !== null && year - member.birth_year < 12)
    if (special) {
      for (const s of sentences(text)) {
        if (SPECIAL_MED.test(s) && !QUOTED.test(s)) {
          throw new OpError('special_population', '对孕产 / 哺乳 / 儿童成员不能给用药建议', {
            op_index: opIndex,
            hint: '这类成员的用药与检查必须由医生决定：医生交代的可以记录（写明「医生交代」），其余改为建议咨询医生。',
          })
        }
      }
    }
  }
}
